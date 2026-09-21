import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Blocaj de instanta unica: daca un alt bot ruleaza deja (proces vechi ramas
// in fundal), noul proces iese imediat cu un mesaj clar, ca sa nu dubleze
// procesarea stirilor si sa nu consume dublu cotele API.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(__dirname, "..", ".bot.lock");
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (fs.existsSync(LOCK_FILE)) {
  const oldPid = Number(fs.readFileSync(LOCK_FILE, "utf-8"));
  if (oldPid && processIsAlive(oldPid)) {
    console.error(`[eroare] Botul ruleaza deja (PID ${oldPid}). Opreste-l intai (taskkill /PID ${oldPid} /F) sau sterge .bot.lock daca procesul nu mai exista.`);
    process.exit(1);
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
function gracefulExit() {
  try {
    if (typeof notifyBot !== "undefined" && notifyBot.isPolling()) {
      notifyBot.stopPolling();
    }
  } catch {}
  for (const timer of approvalExpiryTimers.values()) clearTimeout(timer);
  approvalExpiryTimers.clear();
  persistNow(dbPersistBranch)
    .catch(() => {})
    .finally(() => process.exit(0));
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import TelegramBot from "node-telegram-bot-api";

import { fetchArticle } from "./scraper/article.js";
import { matchesKeywords, isPublishedToday, isForeignOnly, hasStrongRomanianContext, detectSpeaker, isPlausiblePersonName, CORE_POLITICAL_KEYWORDS, CORE_ROMANIAN_POLITICAL_CONTEXT } from "./filter/keywords.js";
import { createArticleProcessingPolicy } from "./filter/processing-policy.js";
import { checkSimilarity, checkSimilarityEmbedding, createArticleEmbedding, createNewsEmbedding } from "./similarity/embedding.js";
import { rewriteArticle } from "./ai/rewrite.js";
import { isRelevantToRomania } from "./ai/relevance.js";
import { extractSpeakerFromArticle } from "./ai/speaker.js";
import { findImage, processArticleImage } from "./image/search.js";
import { saveNews, saveNewsEmbedding, saveAiPost, getRecentNews, getAllAiPosts, isUrlSeen, cleanupOld, pendingApprovals } from "./storage/db.js";
import { persistNow } from "./storage/persist.js";
import { createManualMessageHandler } from "./telegram/manual-links.js";
import { formatChannelAudit } from "./telegram/channel-audit.js";
import { createPollingErrorHandler } from "./telegram/polling-health.js";
import { answerCallbackSafely, parseApprovalCallback } from "./telegram/approval-callback.js";
import { formatApprovalText } from "./telegram/approval-messages.js";
import { splitTelegramText } from "./telegram/text-chunks.js";
import { ARTICLE_APPROVAL_TTL_MS } from "./storage/pending-approvals.js";

const {
  TG_API_ID,
  TG_API_HASH,
  TG_SESSION,
  CHANNELS,
  NOTIFY_BOT_TOKEN,
  NOTIFY_CHAT_ID,
  SIMILARITY_THRESHOLD,
  HISTORY_HOURS,
  KEYWORDS,
  BYPASS_CHANNELS,
  ROMANIAN_PERSONALITIES,
} = process.env;

const keywordsList = [...new Set([
  ...(KEYWORDS || "").split(",").map((k) => k.trim()).filter(Boolean),
  ...CORE_POLITICAL_KEYWORDS,
])];
// Numele reale de personalitati romanesti (NU cuvinte generice ca "ministru"/
// "premier"). Folosit la filtrul de stiri straine: o stire straina e acceptata
// DOAR daca mentioneaza una dintre aceste persoane.
const romanianPersonalities = (
  ROMANIAN_PERSONALITIES ||
  "Ilie Bolojan,Bolojan,Nicusor Dan,Nicușor Dan,Dominic Fritz,Fritz,Diana Buzoianu,Buzoianu"
)
  .split(",")
  .map((k) => k.trim())
  .concat(CORE_ROMANIAN_POLITICAL_CONTEXT);
const channelsList = CHANNELS.split(",").map((c) => c.trim().toLowerCase());
const threshold = Number(SIMILARITY_THRESHOLD || 0.80);
const historyHours = Number(HISTORY_HOURS || 72);
// Canalele care OCOLESC toate filtrele de continut (similaritate, keywords,
// stiri straine) - ex: canalul tau de rezerva, unde vrei sa pui orice daca da
// prost. RAMANE activ doar deduplicarea de URL (protectie la bug-uri Telegram).
const bypassChannels = (BYPASS_CHANNELS || "gtasixleak")
  .split(",")
  .map((c) => c.trim().toLowerCase());

// Persistarea bazei de date in git (doar cand e configurata, ex: pe GitHub
// Actions). Botul salveaza data.sqlite periodic + la oprire, ca istoricul de
// 72h sa nu se piarda intre rulari.
const dbPersistBranch = process.env.DB_PERSIST_BRANCH?.trim() || "";
const dbPersistIntervalMin = Number(process.env.DB_PERSIST_INTERVAL_MIN || 5);
if (dbPersistBranch) {
  console.log(`[persist] Baza de date se va salva in branch '${dbPersistBranch}' la fiecare ${dbPersistIntervalMin} min si la oprire`);
}

// Diagnostic rapid la pornire: confirma ca s-a incarcat cheia corecta din .env
// (doar prefix + lungime, fara sa afiseze cheia integrala)
const gemKey = process.env.GEMINI_API_KEY || "";
console.log(
  `[config] GEMINI_API_KEY: ${gemKey ? `incarcata (prefix ${gemKey.slice(0, 6)}, lungime ${gemKey.length})` : "LIPSESTE din .env!"}`
);
console.log(`[config] TG_SESSION: ${process.env.TG_SESSION ? "setat" : "LIPSESTE"}`);
console.log(`[config] NOTIFY_BOT_TOKEN: ${process.env.NOTIFY_BOT_TOKEN ? "setat" : "LIPSESTE"}`);
console.log(`[config] NOTIFY_CHAT_ID: ${process.env.NOTIFY_CHAT_ID ? "setat" : "LIPSESTE"}`);

// Bot-ul care iti trimite TIE mesaje private si asculta interactiuni (butoane)
const notifyBot = new TelegramBot(NOTIFY_BOT_TOKEN, {
  polling: { autoStart: false, params: { timeout: 10, allowed_updates: ["message", "callback_query"] } },
});
const approvalExpiryTimers = new Map();
notifyBot.on("polling_error", createPollingErrorHandler({ bot: notifyBot, chatId: NOTIFY_CHAT_ID }));

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function notify(text) {
  await notifyBot.sendMessage(NOTIFY_CHAT_ID, text, { parse_mode: "HTML" });
}

// Mesaj text simplu, fara parse_mode (postarea finala nu contine HTML, doar text)
async function notifyPlain(text) {
  for (const chunk of splitTelegramText(text)) {
    await notifyBot.sendMessage(NOTIFY_CHAT_ID, chunk);
  }
}

async function notifyWithImage(caption, imageBuffer) {
  await notifyBot.sendPhoto(NOTIFY_CHAT_ID, imageBuffer, { caption }, { filename: "imagine.jpg" });
}

async function timedStage(name, operation) {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    console.log(`[timing] ${name}=${Date.now() - startedAt}ms`);
  }
}

function approvalMarkup(id) {
  return { inline_keyboard: [[
    { text: "✅ Procesează știrea", callback_data: `proc_${id}` },
    { text: "❌ Ignoră", callback_data: `ign_${id}` },
  ]] };
}

async function sendApprovalPrompt(item) {
  return notifyBot.sendMessage(NOTIFY_CHAT_ID, formatApprovalText(item), {
    parse_mode: "HTML",
    reply_markup: approvalMarkup(item.id),
  });
}

async function persistPendingApprovals() {
  if (dbPersistBranch) await persistNow(dbPersistBranch);
}

function scheduleApprovalExpiry(item) {
  if (item.expires_at === null || item.expires_at === undefined) return;
  const oldTimer = approvalExpiryTimers.get(item.id);
  if (oldTimer) clearTimeout(oldTimer);
  const delay = Math.max(0, item.expires_at - Date.now());
  const timer = setTimeout(async () => {
    approvalExpiryTimers.delete(item.id);
    const expired = pendingApprovals.expire(item.id, Date.now());
    if (!expired) return;
    await persistPendingApprovals();
    if (expired.message_id) {
      try {
        await notifyBot.editMessageText(
          `⌛ <b>Cerere pentru link expirată (12 ore)</b>\n\n<b>Titlu:</b> ${escapeHtml(expired.article.title)}\n<b>Sursă:</b> ${escapeHtml(expired.url)}`,
          {
            chat_id: NOTIFY_CHAT_ID,
            message_id: expired.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch (err) {
        console.warn("[approval expiry] Nu am putut actualiza mesajul expirat:", err.message);
      }
    }
  }, delay);
  approvalExpiryTimers.set(item.id, timer);
}

async function createApprovalRequest(item) {
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  const stored = pendingApprovals.create({ ...item, id, createdAt: Date.now() });
  // Persistăm înainte de Telegram send; dacă procesul cade aici, la pornire
  // restaurăm cererea și îi trimitem din nou mesajul cu butoane.
  await persistPendingApprovals();
  scheduleApprovalExpiry(stored);
  const sent = await sendApprovalPrompt(stored);
  pendingApprovals.setMessageId(id, sent.message_id);
  const updated = pendingApprovals.get(id);
  scheduleApprovalExpiry(updated);
  await persistPendingApprovals();
  return updated;
}

let restoringPendingApprovals = false;
async function restorePendingApprovalRequests({ recoverInterrupted = false } = {}) {
  if (restoringPendingApprovals) return;
  restoringPendingApprovals = true;
  try {
    if (recoverInterrupted) {
      pendingApprovals.recoverInterrupted();
      await persistPendingApprovals();
    }
    const pendingItems = pendingApprovals.listPending();
    // Cererile create de vechiul prag permisiv nu trebuie să rămână blocate
    // după deploy. Revalidăm doar la boot, cu embeddingul deja salvat, fără API.
    if (recoverInterrupted) {
      const articleApprovals = pendingItems.filter((item) => item.kind === "article" && item.simResult?.embedding?.length);
      if (articleApprovals.length) {
        const history = getRecentNews(historyHours * 2);
        for (const pending of articleApprovals) {
          const updated = checkSimilarityEmbedding(
            pending.simResult.embedding,
            pending.article.title || "",
            pending.article.content || "",
            history.filter((entry) => entry.url !== pending.url),
            threshold,
            { embeddingModel: pending.simResult.embeddingModel }
          );
          console.log(`[approval recheck] ${pending.url}: ${updated.isDuplicate ? "duplicate păstrat" : "fals pozitiv vechi eliberat"}${updated.similarUrl ? ` (${updated.similarityZone}, ${(updated.similarity * 100).toFixed(1)}% vs ${updated.similarUrl})` : ""}`);
          if (updated.isDuplicate) continue;
          if (isUrlSeen(pending.url)) {
            pendingApprovals.setState(pending.id, "done");
            if (pending.message_id) {
              await notifyBot.editMessageText(
                `ℹ️ <b>Știrea fusese deja procesată; cererea veche a fost închisă.</b>\n\n<b>Titlu:</b> ${escapeHtml(pending.article.title)}\n<b>Sursă:</b> ${escapeHtml(pending.url)}`,
                { chat_id: NOTIFY_CHAT_ID, message_id: pending.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
              ).catch(() => {});
            }
            await persistPendingApprovals();
            continue;
          }

          const item = pendingApprovals.claim(pending.id);
          if (!item) continue;
          const timer = approvalExpiryTimers.get(item.id);
          if (timer) clearTimeout(timer);
          approvalExpiryTimers.delete(item.id);
          await persistPendingApprovals();
          if (item.message_id) {
            try {
              await notifyBot.editMessageText(
                `🔄 <b>Reverificată cu regulile noi de similaritate; știrea a fost eliberată pentru procesare.</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
                { chat_id: NOTIFY_CHAT_ID, message_id: item.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
              );
            } catch (err) { console.warn("[approval recheck] Nu am putut actualiza mesajul vechi:", err.message); }
          }
          enqueueProcess(async () => {
            try {
              const result = await finalizeAndSendArticle(item.article, item.url, item.simResult, item.matchedKeywords);
              pendingApprovals.setState(item.id, "done");
              await persistPendingApprovals();
              if (item.message_id) {
                const status = result?.status === "pending"
                  ? "Textul AI similar a fost pus într-o cerere separată de aprobare."
                  : "Știre procesată și trimisă cu succes!";
                await notifyBot.editMessageText(
                  `✅ <b>${status}</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
                  { chat_id: NOTIFY_CHAT_ID, message_id: item.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
                ).catch(() => {});
              }
            } catch (err) {
              console.error(`[approval recheck] Procesarea articolului ${item.url} a eșuat:`, err);
              pendingApprovals.setState(item.id, "pending");
              const retryItem = pendingApprovals.get(item.id);
              scheduleApprovalExpiry(retryItem);
              await persistPendingApprovals();
              await notify(`❌ Eroare la reprocesarea știrii eliberate:\n${item.url}\n${err.message}`).catch(() => {});
              if (item.message_id) {
                await notifyBot.editMessageText(
                  `❌ <b>Reverificarea a eliberat știrea, dar procesarea a eșuat; poți încerca din nou.</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
                  { chat_id: NOTIFY_CHAT_ID, message_id: item.message_id, parse_mode: "HTML", reply_markup: approvalMarkup(item.id) }
                ).catch(() => {});
              }
            }
          });
        }
      }
    }
    for (const item of pendingApprovals.listPending()) {
      scheduleApprovalExpiry(item);
      if (item.message_id) continue;
      try {
        const sent = await sendApprovalPrompt(item);
        pendingApprovals.setMessageId(item.id, sent.message_id);
        await persistPendingApprovals();
      } catch (err) {
        console.error(`[approval restore] Nu am putut retrimite cererea ${item.id}:`, err.message);
      }
    }
  } finally {
    restoringPendingApprovals = false;
  }
}

async function handleApprovalCallback(callbackQuery) {
  const action = parseApprovalCallback(callbackQuery.data || "");
  if (!action) return;
  if (String(callbackQuery.message?.chat?.id) !== String(NOTIFY_CHAT_ID)) {
    await answerCallbackSafely(notifyBot, callbackQuery, { text: "Acțiune neautorizată.", show_alert: true });
    return;
  }

  const { id } = action;
  if (action.action === "ignore") {
    const item = pendingApprovals.claim(id);
    if (!item) {
      await answerCallbackSafely(notifyBot, callbackQuery, { text: "Cererea a expirat sau a fost deja procesată.", show_alert: true });
      return;
    }
    const timer = approvalExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    approvalExpiryTimers.delete(id);
    pendingApprovals.setState(id, "ignored");
    await persistPendingApprovals();
    await answerCallbackSafely(notifyBot, callbackQuery, { text: "Știre ignorată." });
    try {
      await notifyBot.editMessageText(
        `❌ <b>Știre ignorată manual.</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
        { chat_id: NOTIFY_CHAT_ID, message_id: callbackQuery.message.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
      );
    } catch (err) { console.warn("[approval] Nu am putut actualiza mesajul ignorat:", err.message); }
    return;
  }

  const item = pendingApprovals.claim(id);
  if (!item) {
    await answerCallbackSafely(notifyBot, callbackQuery, { text: "Cererea a expirat sau a fost deja procesată.", show_alert: true });
    return;
  }
  const timer = approvalExpiryTimers.get(id);
  if (timer) clearTimeout(timer);
  approvalExpiryTimers.delete(id);
  await persistPendingApprovals();
  await answerCallbackSafely(notifyBot, callbackQuery, { text: "Se procesează știrea..." });
  try {
    await notifyBot.editMessageText(
      `⚙️ <b>Se procesează știrea aprobată...</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
      { chat_id: NOTIFY_CHAT_ID, message_id: callbackQuery.message.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
    );
  } catch {}

  await enqueueProcess(async () => {
    try {
      const result = await finalizeAndSendArticle(
        item.article,
        item.url,
        item.simResult,
        item.matchedKeywords,
        { approvedPost: item.formattedPost, aiEmbedding: item.aiEmbedding }
      );
      pendingApprovals.setState(id, "done");
      await persistPendingApprovals();
      try {
        const status = result?.status === "pending" ? "Textul AI similar a fost pus într-o cerere separată de aprobare." : "Știre procesată și trimisă cu succes!";
        await notifyBot.editMessageText(
          `✅ <b>${status}</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
          { chat_id: NOTIFY_CHAT_ID, message_id: callbackQuery.message.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
        );
      } catch {}
    } catch (err) {
      console.error("[callback proc eroare]", err);
      pendingApprovals.setState(id, "pending");
      const retryItem = pendingApprovals.get(id);
      scheduleApprovalExpiry(retryItem);
      await persistPendingApprovals();
      await notify(`❌ Eroare la procesarea știrii aprobate:\n${item.url}\n${err.message}`).catch(() => {});
      try {
        await notifyBot.editMessageText(
          `❌ <b>Procesarea a eșuat; poți încerca din nou.</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${escapeHtml(item.url)}`,
          { chat_id: NOTIFY_CHAT_ID, message_id: callbackQuery.message.message_id, parse_mode: "HTML", reply_markup: approvalMarkup(id) }
        );
      } catch {}
    }
  });
}

// Acțiunile inline citesc și revendică starea din SQLite; nu depind de RAM-ul
// procesului, astfel încât butonul rămâne funcțional după un restart.
notifyBot.on("callback_query", (query) => {
  handleApprovalCallback(query).catch((err) => {
    console.error("[approval callback] Eroare neașteptată (polling-ul rămâne activ):", err?.message || String(err));
  });
});

// Extrage link-ul din mesajul Telegram (butonul "Deschide"/link direct din text)
function extractLink(message) {
  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        return entity.url;
      }
    }
  }
  const urlMatch = message.message?.match(/https?:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : null;
}

// Finalizeaza generarea postarii, cautarea imaginii si trimiterea notificarii
async function finalizeAndSendArticle(article, url, simResult, matchedKeywords = [], approval = {}) {
  // 4. Rescriere AI și control al duplicatelor între texte AI aprobate anterior.
  let formattedPost = approval.approvedPost;
  let aiEmbedding = approval.aiEmbedding;
  if (!formattedPost) {
    const rewritten = await timedStage("rewrite", () => rewriteArticle(article.fullTextForKeywordCheck));
    formattedPost = rewritten.text;
    // Comparația AI este separată de compararea link-urilor și nu are limită
    // de vechime: numai postări redactate/aprobate anterior prin AI intră aici.
    const previousTexts = approval.bypassAiSimilarity ? [] : getAllAiPosts();
    const aiSimilarity = approval.bypassAiSimilarity
      ? null
      : await timedStage("ai_text_similarity", () => checkSimilarity(formattedPost, previousTexts, threshold));
    if (approval.bypassAiSimilarity) {
      try {
        aiEmbedding = await createNewsEmbedding(formattedPost);
      } catch (err) {
        console.warn(`[manual] Nu am putut salva embeddingul textului AI pentru viitoarele comparații: ${err.message}`);
      }
    } else if (aiSimilarity.isDuplicate) {
      aiEmbedding = aiSimilarity.embedding;
      const pending = await createApprovalRequest({
        kind: "ai_text",
        url,
        article,
        simResult,
        matchedKeywords,
        formattedPost,
        aiEmbedding,
        comparisonUrl: aiSimilarity.similarUrl,
        comparisonTitle: previousTexts.find((entry) => entry.url === aiSimilarity.similarUrl)?.title,
        similarity: aiSimilarity.similarity,
        expiresAt: null, // cererile pentru texte AI nu expiră
      });
      console.log(`[similar AI] Text pus în așteptare fără expirare: ${pending.id}`);
      return { status: "pending", pendingId: pending.id, reason: aiSimilarity.similarityReason };
    } else aiEmbedding = aiSimilarity.embedding;
  }

  // 6. Sistemul inteligent de imagini. Vorbitorul se determina AI-PRIMAR
  const regexSpeaker = detectSpeaker(article.title, matchedKeywords);
  const aiSpeaker = await timedStage("speaker", () => extractSpeakerFromArticle(
    article.title,
    (article.content || "").slice(0, 1500),
    [regexSpeaker, ...matchedKeywords].filter(Boolean).join(", ")
  ));
  const speaker = isPlausiblePersonName(aiSpeaker)
    ? aiSpeaker
    : isPlausiblePersonName(regexSpeaker)
      ? regexSpeaker
      : null;
  if (speaker) console.log(`[speaker] Vorbitor final: ${speaker}`);

  let imageResult = null;
  if (speaker) {
    try {
      imageResult = await timedStage("image_search", () => findImage(speaker, article.title));
    } catch (e) {
      console.warn("[image] findImage esuat:", e.message);
    }
  } else {
    console.log("[image] Fara persoana care declara - sarim cautarea de portret");
  }

  if (!imageResult && article.imageUrl) {
    try {
      imageResult = await timedStage("article_image", () => processArticleImage(article.imageUrl));
      console.log("[image] Fallback: imaginea articolului " + article.imageUrl);
    } catch {}
  }

  // 7. Trimitem TIE rezultatul, gata pregatit, pentru aprobare + postare MANUALA.
  const cleanPost = formattedPost.replace(/\*\*/g, "").trim();

  if (imageResult) {
    await timedStage("telegram_delivery", async () => {
      await notifyWithImage(url, imageResult.buffer);
      if (cleanPost) await notifyPlain(cleanPost);
    });
  } else {
    await timedStage("telegram_delivery", async () => {
      if (cleanPost) await notifyPlain(cleanPost);
      await notifyPlain(
        `Sursa: ${url}\n\n⚠️ Nu am gasit imagine noua automat, cauta manual pentru: ${speaker || "eveniment"}`
      );
    });
  }

  // Salvăm numai după livrarea reușită; articolele în așteptarea aprobării AI
  // nu devin false pozitive la următoarea verificare.
  saveNews({
    url,
    title: article.title,
    content: article.content,
    embedding: simResult?.embedding ?? null,
    embeddingModel: simResult?.embeddingModel ?? null,
    embeddingVersion: simResult?.embeddingVersion ?? null,
  });
  saveAiPost({ url, title: formattedPost.split(/\r?\n/, 1)[0] || article.title, content: formattedPost, embedding: aiEmbedding });
  console.log("[ok] Trimis pentru aprobare");
  return { status: "done" };
}

async function processArticleUrl(url, { bypassFilters = false, bypassSimilarity = false, forceManual = false } = {}) {
  const articleStartedAt = Date.now();
  const policy = createArticleProcessingPolicy({ bypassFilters, bypassSimilarity, forceManual });
  try {
    if (policy.checkSeenUrl && isUrlSeen(url)) {
      console.log(`[skip] URL deja procesat: ${url}`);
      return { status: "skipped", reason: "URL-ul a fost deja procesat." };
    }
    if (forceManual) console.log("[manual] Link solicitat explicit: procesare forțată, fără filtre editoriale sau verificări de similaritate.");
    if (forceManual && isUrlSeen(url)) console.log(`[manual] Retrimitere forțată a URL-ului deja procesat: ${url}`);

    console.log(`[procesare] ${url}`);
    const article = await timedStage("scrape", () => fetchArticle(url));

    if (policy.checkMinimumContent && (!article.content || article.content.length < 100)) {
      console.log(
        `[skip] Continut prea scurt / nu s-a putut extrage (${article.content?.length || 0} caractere, titlu: "${article.title}")`
      );
      return { status: "skipped", reason: "Nu am putut extrage suficient text din articol." };
    }
    if (!policy.checkMinimumContent && (!article.content || article.content.length < 100)) {
      console.log(`[manual] Continut extras scurt (${article.content?.length || 0} caractere); continuam deoarece linkul a fost solicitat explicit.`);
    }

    // 1. Verificare data (trebuie sa fie din ziua curenta)
    if (policy.checkPublishedToday && !isPublishedToday(article.isoDate)) {
      console.log(`[skip] Nu e din ziua curenta (data gasita: "${article.isoDate}")`);
      return { status: "skipped", reason: `Articolul nu pare publicat azi (data identificată: ${article.isoDate || "necunoscută"}).` };
    }

    // Textul esential al stirii = titlul + primul paragraf.
    const essentialText = `${article.title}\n${(article.content || "").slice(0, 500)}`;

    // 2. Verificare keywords (pe titlu + primul paragraf).
    const { matched, matchedKeywords } = matchesKeywords(essentialText, keywordsList);
    if (!matched) {
      if (!policy.checkKeywords) {
        console.log(`[pas] ${forceManual ? "Link manual" : "Canal bypass"} - NU sunt keywords gasite, dar continuam oricum`);
      } else if (policy.checkKeywords) {
        console.log("[skip] Niciun keyword gasit");
        return { status: "skipped", reason: "Nu am găsit niciun keyword configurat în titlu sau lead." };
      }
    } else {
      console.log(`[match] Keywords gasite: ${matchedKeywords.join(", ")}`);
    }

    // 2b. Filtru stiri straine (DINAMIC, cu AI)
    if (policy.checkForeignRelevance && !hasStrongRomanianContext(essentialText, romanianPersonalities)) {
      const relevant = await timedStage("relevance", () => isRelevantToRomania(
        article.title,
        (article.content || "").slice(0, 1500)
      ));
      const foreign =
        relevant === null
          ? isForeignOnly(essentialText, romanianPersonalities)
          : !relevant;
      if (foreign) {
        console.log("[skip] Stire straina fara implicare romaneasca");
        return { status: "skipped", reason: "Știrea pare străină și fără implicare românească." };
      }
    }

    // 3. Verificare similaritate cu ultimele 72h folosind articolul complet.
    let simResult = null;
    if (policy.checkArticleSimilarity) {
      const recentNews = getRecentNews(historyHours);
      // Păstrăm separatorul ca să delimităm titlul de corpul integral în arbitraj.
      const textToEmbed = `${article.title}\n${article.content || ""}`;
      simResult = await timedStage("article_similarity", () => checkSimilarity(textToEmbed, recentNews, threshold, {
        onReembed: saveNewsEmbedding,
      }));

      if (simResult.isDuplicate) {
        console.log(
          `[similar] ${simResult.similarityZone}: ${(simResult.similarity * 100).toFixed(1)}% cu ${simResult.similarUrl} - ${simResult.similarityReason}`
        );
        const comparison = recentNews.find((entry) => entry.url === simResult.similarUrl);
        await createApprovalRequest({
          kind: "article",
          url,
          article,
          simResult,
          matchedKeywords,
          comparisonUrl: simResult.similarUrl,
          comparisonTitle: comparison?.title,
          similarity: simResult.similarity,
          expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS,
        });
        return { status: "pending", reason: simResult.similarityReason };
      }
    } else if (bypassFilters && !forceManual) {
      console.log("[pas] Canal bypass - sarim peste filtrul de similaritate");
    } else {
      console.log("[pas] Sarim peste filtrul de similaritate");
      try {
        const articleEmbedding = await createArticleEmbedding(article.title, article.content || "");
        simResult = articleEmbedding;
      } catch (err) {
        // Eșecul embeddingului nu trebuie să blocheze un link solicitat manual.
        console.warn(`[manual] Nu am putut salva embeddingul pentru viitoarele comparații: ${err.message}`);
      }
    }

    // Daca a trecut toate filtrele sau e pe acelasi site / bypass, finalizam
    return await finalizeAndSendArticle(article, url, simResult, matchedKeywords, { bypassAiSimilarity: !policy.checkAiSimilarity });
  } catch (err) {
    console.error(`[eroare] la procesarea ${url}:`, err.message);
    await notify(`❌ Eroare la procesarea unui articol:\n${url}\n${err.message}`).catch(() => {});
    return { status: "error", reason: err.message };
  } finally {
    console.log(`[timing] article_total=${Date.now() - articleStartedAt}ms url=${url}`);
  }
}

// Coada de procesare: articolele sunt procesate UNUL CATE UNUL, chiar daca
// mai multe mesaje ajung aproape simultan (de pe canale diferite). Fara coada,
// doua articole s-ar compara cu similaritatea in paralel - inainte ca oricare
// sa fie salvat in istoric - si ambele ar trece de filtrul de duplicate.
let processQueue = Promise.resolve();
function enqueueProcess(fn) {
  processQueue = processQueue.then(fn, fn);
  return processQueue;
}

// Un link trimis botului în chatul privat configurat este procesat fără
// comparația de similaritate; restul filtrelor normale rămân active.
const handleManualMessage = createManualMessageHandler({
  bot: notifyBot,
  authorizedChatId: NOTIFY_CHAT_ID,
  enqueue: enqueueProcess,
  processUrl: processArticleUrl,
});
notifyBot.on("message", (message) => {
  handleManualMessage(message).catch((err) => {
    console.error("[notifyBot] Eroare neașteptată la handlerul de mesaje (polling-ul rămâne activ):", err?.message || String(err));
  });
});

async function main() {
  let botIdentity;
  try {
    botIdentity = await notifyBot.getMe();
    console.log(`[notifyBot] Tokenul este pentru @${botIdentity.username || `id:${botIdentity.id}`}.`);
  } catch (err) {
    console.error("[notifyBot] Nu am putut confirma identitatea botului:", err.message);
  }

  try {
    const webhookInfo = await notifyBot.getWebHookInfo();
    if (webhookInfo.url) {
      console.warn("[notifyBot] Webhook existent găsit; îl dezactivez păstrând update-urile în coadă, fiindcă acest proiect folosește long polling.");
      await notifyBot.deleteWebHook({ drop_pending_updates: false });
    }
  } catch (err) {
    // Polling-ul va porni oricum: biblioteca încearcă să elimine webhook-ul
    // dacă Telegram răspunde cu 409 la getUpdates.
    console.error("[notifyBot] Verificarea webhook-ului a eșuat; încerc totuși long polling:", err.message);
  }

  try {
    // Reîncărcăm cererile din SQLite înainte să livrăm callback-urile aflate
    // în coada Telegram; astfel un click nu poate concura cu recuperarea stării.
    await restorePendingApprovalRequests({ recoverInterrupted: true });
  } catch (err) {
    // O bază de date temporar indisponibilă nu trebuie să lase botul surd la
    // mesaje manuale. Restaurarea se reîncearcă periodic și la callback.
    console.error("[approval restore] Restaurarea inițială a eșuat; polling-ul Telegram pornește oricum:", err.message);
  }

  notifyBot.startPolling().catch((err) => {
    console.error("[notifyBot] Nu am putut porni long polling:", err.message);
  });
  console.log('[notifyBot] Long polling pornit pentru update-uri "message" și "callback_query".');
  setInterval(() => {
    restorePendingApprovalRequests().catch((err) => console.error("[approval restore]", err));
  }, 60 * 1000);
  const identityLabel = botIdentity?.username ? ` @${botIdentity.username}` : "";
  await notify(`🤖 Bot pornit${identityLabel}. Pentru procesare manuală, trimite-mi linkul știrii în acest chat privat.`)
    .catch((err) => console.error("[notifyBot] Polling-ul e pornit, dar notificarea de startup a eșuat:", err.message));

  const client = new TelegramClient(new StringSession(TG_SESSION), Number(TG_API_ID), TG_API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log("✅ Conectat la Telegram (MTProto)");

  // Curatam periodic istoricul vechi (o data la 6 ore)
  setInterval(() => cleanupOld(historyHours, Number(process.env.IMAGE_HISTORY_DAYS || 7)), 6 * 60 * 60 * 1000);

  // Salvam periodic baza de date in git (pe Actions filesystem-ul e efemer;
  // fara asta istoricul de 72h s-ar pierde la fiecare oprire).
  if (dbPersistBranch) {
    persistNow(dbPersistBranch).catch(() => {});
    setInterval(() => persistNow(dbPersistBranch).catch(() => {}), dbPersistIntervalMin * 60 * 1000);
  }

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message) return;

    const chat = await message.getChat();
    const chatUsername = chat?.username?.toLowerCase();

    const preview = (message.message || "").split(/\r?\n/, 1)[0].trim();
    const link = extractLink(message);
    console.log(formatChannelAudit({ channel: chatUsername, messageId: message.id, title: preview, url: link, status: "received" }));

    if (!chatUsername || !channelsList.includes(chatUsername)) {
      console.log(formatChannelAudit({
        channel: chatUsername,
        messageId: message.id,
        title: preview,
        url: link,
        status: "ignored",
        reason: !chatUsername
          ? "Canalul nu are username public; nu poate fi potrivit cu CHANNELS."
          : "Canalul nu este în lista CHANNELS configurată.",
      }));
      return;
    }

    if (!link) {
      console.log(formatChannelAudit({
        channel: chatUsername,
        messageId: message.id,
        title: preview,
        status: "ignored",
        reason: "Postarea nu conține un link HTTP(S) detectabil.",
      }));
      return;
    }

    const bypassFilters = bypassChannels.includes(chatUsername);
    if (bypassFilters) console.log(`[bypass] Canalul ${chatUsername} ocoleste filtrele (similaritate, keywords, straine)`);
    const result = await enqueueProcess(() => processArticleUrl(link, { bypassFilters }));
    console.log(formatChannelAudit({
      channel: chatUsername,
      messageId: message.id,
      title: preview,
      url: link,
      status: result?.status || "unknown",
      reason: result?.reason || null,
    }));
  }, new NewMessage({}));

  console.log(`👀 Monitorizez canalele: ${channelsList.join(", ")}`);

  const maxRuntimeMin = Number(process.env.BOT_MAX_RUNTIME_MIN || 0);
  if (maxRuntimeMin > 0) {
    console.log(`⏱️ [watchdog] Oprire automata programata peste ${maxRuntimeMin} minute`);
    setTimeout(() => {
      console.log(`⏱️ [watchdog] Timp maxim de rulare atins (${maxRuntimeMin} min) - salvare si oprire gratioasa...`);
      gracefulExit();
    }, maxRuntimeMin * 60 * 1000);
  }
}

main().catch((err) => {
  console.error("Eroare fatala:", err);
  // AUTH_KEY_DUPLICATED = aceeasi sesiune Telegram (TG_SESSION) e folosita
  // SIMULTAN de doua locatii (ex: bot local + bot pe GitHub Actions, sau doua
  // rulari Actions suprapuse). Telegram respinge conexiunea. Solutia: opreste
  // cealalta instanta si reporneste; daca persista, regenereaza TG_SESSION.
  if (String(err?.message || err).includes("AUTH_KEY_DUPLICATED")) {
    console.error(
      "\n" +
        "!! SESIUNE TELEGRAM FOLOSITA SIMULTAN IN DOUA LOCAZII !!\n" +
        "!! Opreste botul local (sau cealalta rulare Actions) si reporneste.\n" +
        "!! Nu rula niciodata botul local si cel din GitHub Actions in acelasi timp\n" +
        "!! cu acelasi TG_SESSION - Telegram blocheaza conexiunile duplicate.\n"
    );
  }
  process.exit(1);
});
