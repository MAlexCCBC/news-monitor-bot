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
import { matchesKeywords, isPublishedToday, isForeignOnly, hasStrongRomanianContext, detectSpeaker, isPlausiblePersonName } from "./filter/keywords.js";
import { checkSimilarity, createNewsEmbedding } from "./similarity/embedding.js";
import { rewriteArticle } from "./ai/rewrite.js";
import { isRelevantToRomania } from "./ai/relevance.js";
import { extractSpeakerFromArticle } from "./ai/speaker.js";
import { findImage, processArticleImage } from "./image/search.js";
import { saveNews, saveAiPost, getRecentNews, getRecentAiPosts, isUrlSeen, cleanupOld, pendingApprovals } from "./storage/db.js";
import { persistNow } from "./storage/persist.js";
import { extractBotMessageLink } from "./telegram/manual-links.js";
import { parseApprovalCallback } from "./telegram/approval-callback.js";

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

const keywordsList = KEYWORDS.split(",").map((k) => k.trim());
// Numele reale de personalitati romanesti (NU cuvinte generice ca "ministru"/
// "premier"). Folosit la filtrul de stiri straine: o stire straina e acceptata
// DOAR daca mentioneaza una dintre aceste persoane.
const romanianPersonalities = (
  ROMANIAN_PERSONALITIES ||
  "Ilie Bolojan,Bolojan,Nicusor Dan,Nicușor Dan,Dominic Fritz,Fritz,Diana Buzoianu,Buzoianu"
)
  .split(",")
  .map((k) => k.trim());
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
let pollingConflictAlerted = false;
notifyBot.on("polling_error", (err) => {
  if (err?.message?.includes("ETELEGRAM: 409")) {
    console.error("[notifyBot polling] Conflict 409: alt proces foloseste acelasi token sau webhook-ul este activ. Linkurile trimise botului nu pot fi primite pana nu ramane un singur poller.");
    if (!pollingConflictAlerted && NOTIFY_CHAT_ID) {
      pollingConflictAlerted = true;
      notifyBot.sendMessage(NOTIFY_CHAT_ID, "⚠️ Nu pot asculta mesajele: Telegram raportează un poller/webhook concurent pentru bot. Oprește celelalte instanțe ale botului și repornește-l.").catch(() => {});
    }
    return;
  }
  console.warn("[notifyBot polling]", err.message);
});

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
  await notifyBot.sendMessage(NOTIFY_CHAT_ID, text);
}

async function notifyWithImage(caption, imageBuffer) {
  await notifyBot.sendPhoto(NOTIFY_CHAT_ID, imageBuffer, { caption }, { filename: "imagine.jpg" });
}

function approvalMarkup(id) {
  return { inline_keyboard: [[
    { text: "✅ Procesează știrea", callback_data: `proc_${id}` },
    { text: "❌ Ignoră", callback_data: `ign_${id}` },
  ]] };
}

function approvalText(item) {
  const title = escapeHtml(item.article.title || "(fără titlu)");
  const comparisonTitle = escapeHtml(item.comparisonTitle || "Știre anterioară");
  const comparisonUrl = escapeHtml(item.comparisonUrl || "");
  const score = `${(Number(item.similarity || 0) * 100).toFixed(0)}%`;
  if (item.kind === "ai_text") {
    const preview = escapeHtml((item.formattedPost || "").slice(0, 700));
    return `🤖⏭️ <b>Textul generat de AI pare similar (${score})</b>\n\n` +
      `<b>Titlu articol:</b> ${title}\n<b>Sursă:</b> ${escapeHtml(item.url)}\n` +
      `<b>Similar cu:</b> ${comparisonTitle} — ${comparisonUrl}\n\n` +
      `<b>Previzualizare:</b>\n${preview}\n\n` +
      `<i>Cererea nu expiră. Dorești să primești știrea oricum?</i>`;
  }
  return `⏭️ <b>Știre similară (${score})</b>\n\n` +
    `<b>Titlu:</b> ${title}\n<b>Sursă:</b> ${escapeHtml(item.url)}\n\n` +
    `<b>Similară cu:</b> ${comparisonTitle} — ${comparisonUrl}\n\n` +
    `<i>Dorești să fie procesată și trimisă oricum? Cererea expiră într-o oră.</i>`;
}

async function sendApprovalPrompt(item) {
  return notifyBot.sendMessage(NOTIFY_CHAT_ID, approvalText(item), {
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
          `⌛ <b>Cerere expirată (1 oră)</b>\n\n<b>Titlu:</b> ${escapeHtml(expired.article.title)}\n<b>Sursă:</b> ${escapeHtml(expired.url)}`,
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
    await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Acțiune neautorizată.", show_alert: true });
    return;
  }

  const { id } = action;
  if (action.action === "ignore") {
    const item = pendingApprovals.claim(id);
    if (!item) {
      await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Cererea a expirat sau a fost deja procesată.", show_alert: true });
      return;
    }
    const timer = approvalExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    approvalExpiryTimers.delete(id);
    pendingApprovals.setState(id, "ignored");
    await persistPendingApprovals();
    await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Știre ignorată." });
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
    await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Cererea a expirat sau a fost deja procesată.", show_alert: true });
    return;
  }
  const timer = approvalExpiryTimers.get(id);
  if (timer) clearTimeout(timer);
  approvalExpiryTimers.delete(id);
  await persistPendingApprovals();
  await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Se procesează știrea..." });
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
notifyBot.on("callback_query", handleApprovalCallback);

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
  // 4. Rescriere AI și al doilea control pe textul care va fi trimis efectiv.
  // Comparăm atât cu articolele-sursă, cât și cu postările AI aprobate anterior.
  let formattedPost = approval.approvedPost;
  let aiEmbedding = approval.aiEmbedding;
  if (!formattedPost) {
    const rewritten = await rewriteArticle(article.fullTextForKeywordCheck);
    formattedPost = rewritten.text;
    const previousTexts = [...getRecentNews(historyHours), ...getRecentAiPosts(historyHours)];
    const aiSimilarity = await checkSimilarity(formattedPost, previousTexts, threshold);
    aiEmbedding = aiSimilarity.embedding;
    if (aiSimilarity.isDuplicate) {
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
      return { status: "pending", pendingId: pending.id };
    }
  }

  // 6. Sistemul inteligent de imagini. Vorbitorul se determina AI-PRIMAR
  const regexSpeaker = detectSpeaker(article.title, matchedKeywords);
  const aiSpeaker = await extractSpeakerFromArticle(
    article.title,
    (article.content || "").slice(0, 1500),
    [regexSpeaker, ...matchedKeywords].filter(Boolean).join(", ")
  );
  const speaker = isPlausiblePersonName(aiSpeaker)
    ? aiSpeaker
    : isPlausiblePersonName(regexSpeaker)
      ? regexSpeaker
      : null;
  if (speaker) console.log(`[speaker] Vorbitor final: ${speaker}`);

  let imageResult = null;
  if (speaker) {
    try {
      imageResult = await findImage(speaker, article.title);
    } catch (e) {
      console.warn("[image] findImage esuat:", e.message);
    }
  } else {
    console.log("[image] Fara persoana care declara - sarim cautarea de portret");
  }

  if (!imageResult && article.imageUrl) {
    try {
      imageResult = await processArticleImage(article.imageUrl);
      console.log("[image] Fallback: imaginea articolului " + article.imageUrl);
    } catch {}
  }

  // 7. Trimitem TIE rezultatul, gata pregatit, pentru aprobare + postare MANUALA.
  const cleanPost = formattedPost.replace(/\*\*/g, "").trim();

  if (imageResult) {
    await notifyWithImage(url, imageResult.buffer);
    if (cleanPost) await notifyPlain(cleanPost);
  } else {
    if (cleanPost) await notifyPlain(cleanPost);
    await notifyPlain(
      `Sursa: ${url}\n\n⚠️ Nu am gasit imagine noua automat, cauta manual pentru: ${speaker || "eveniment"}`
    );
  }

  // Salvăm numai după livrarea reușită; articolele în așteptarea aprobării AI
  // nu devin false pozitive la următoarea verificare.
  saveNews({
    url,
    title: article.title,
    content: article.content,
    embedding: simResult?.embedding ?? null,
  });
  saveAiPost({ url, title: formattedPost.split(/\r?\n/, 1)[0] || article.title, content: formattedPost, embedding: aiEmbedding });
  console.log("[ok] Trimis pentru aprobare");
  return { status: "done" };
}

async function processArticleUrl(url, { bypassFilters = false, bypassSimilarity = false } = {}) {
  try {
    if (isUrlSeen(url)) {
      console.log(`[skip] URL deja procesat: ${url}`);
      return { status: "skipped", reason: "URL-ul a fost deja procesat." };
    }

    console.log(`[procesare] ${url}`);
    const article = await fetchArticle(url);

    if (!article.content || article.content.length < 100) {
      console.log(
        `[skip] Continut prea scurt / nu s-a putut extrage (${article.content?.length || 0} caractere, titlu: "${article.title}")`
      );
      return { status: "skipped", reason: "Nu am putut extrage suficient text din articol." };
    }

    // 1. Verificare data (trebuie sa fie din ziua curenta)
    if (!isPublishedToday(article.isoDate)) {
      console.log(`[skip] Nu e din ziua curenta (data gasita: "${article.isoDate}")`);
      return { status: "skipped", reason: `Articolul nu pare publicat azi (data identificată: ${article.isoDate || "necunoscută"}).` };
    }

    // Textul esential al stirii = titlul + primul paragraf.
    const essentialText = `${article.title}\n${(article.content || "").slice(0, 500)}`;

    // 2. Verificare keywords (pe titlu + primul paragraf).
    const { matched, matchedKeywords } = matchesKeywords(essentialText, keywordsList);
    if (!matched) {
      if (bypassFilters) {
        console.log("[pas] Canal bypass - NU sunt keywords gasite, dar continuam oricum");
      } else {
        console.log("[skip] Niciun keyword gasit");
        return { status: "skipped", reason: "Nu am găsit niciun keyword configurat în titlu sau lead." };
      }
    } else {
      console.log(`[match] Keywords gasite: ${matchedKeywords.join(", ")}`);
    }

    // 2b. Filtru stiri straine (DINAMIC, cu AI)
    if (!bypassFilters && !hasStrongRomanianContext(essentialText, romanianPersonalities)) {
      const relevant = await isRelevantToRomania(
        article.title,
        (article.content || "").slice(0, 1500)
      );
      const foreign =
        relevant === null
          ? isForeignOnly(essentialText, romanianPersonalities)
          : !relevant;
      if (foreign) {
        console.log("[skip] Stire straina fara implicare romaneasca");
        return { status: "skipped", reason: "Știrea pare străină și fără implicare românească." };
      }
    }

    // 3. Verificare similaritate cu ultimele 72h pe amprenta concentrata (Titlu + Lead 300 caractere).
    let simResult = null;
    if (!bypassFilters && !bypassSimilarity) {
      const recentNews = getRecentNews(historyHours);
      // checkSimilarity separa titlul de lead folosind newline pentru
      // arbitrajul pe titluri. Pastreaza delimitatorul in textul embed-uit.
      const textToEmbed = `${article.title}\n${(article.content || "").slice(0, 300)}`;
      simResult = await checkSimilarity(textToEmbed, recentNews, threshold);

      if (simResult.isDuplicate) {
        console.log(
          `[similar] Similaritate ${(simResult.similarity * 100).toFixed(1)}% cu ${simResult.similarUrl} - cer confirmare indiferent de domeniu`
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
          expiresAt: Date.now() + 60 * 60 * 1000,
        });
        return { status: "pending" };
      }
    } else if (bypassFilters) {
      console.log("[pas] Canal bypass - sarim peste filtrul de similaritate");
    } else {
      console.log("[pas] Link trimis direct in chat - sarim peste filtrul de similaritate");
      try {
        const textToEmbed = `${article.title}\n${(article.content || "").slice(0, 300)}`;
        simResult = { embedding: await createNewsEmbedding(textToEmbed) };
      } catch (err) {
        // Eșecul embeddingului nu trebuie să blocheze un link solicitat manual.
        console.warn(`[manual] Nu am putut salva embeddingul pentru viitoarele comparații: ${err.message}`);
      }
    }

    // Daca a trecut toate filtrele sau e pe acelasi site / bypass, finalizam
    return await finalizeAndSendArticle(article, url, simResult, matchedKeywords);
  } catch (err) {
    console.error(`[eroare] la procesarea ${url}:`, err.message);
    await notify(`❌ Eroare la procesarea unui articol:\n${url}\n${err.message}`).catch(() => {});
    return { status: "error", reason: err.message };
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
notifyBot.on("message", async (message) => {
  if (message.from?.is_bot) return;
  if (String(message.chat?.id) !== String(NOTIFY_CHAT_ID)) {
    console.log(`[notifyBot] Mesaj privat primit; chat configurat: ${String(message.chat?.type) === "private" && String(message.chat?.id) === String(NOTIFY_CHAT_ID) ? "da" : "nu"}`);
    return;
  }
  if (message.chat?.type !== "private") {
    console.warn("[notifyBot] Link ignorat: trimite-l în chatul privat cu botul, nu într-un grup.");
    return;
  }
  if (message.text?.trim().split(/\s+/)[0]?.split("@")[0] === "/start" || message.text?.trim().split(/\s+/)[0]?.split("@")[0] === "/help") {
    await notifyBot.sendMessage(message.chat.id, "Trimite-mi linkul complet al unei știri. O voi procesa și îți voi confirma aici dacă a fost filtrată sau dacă necesită aprobare.");
    return;
  }
  const link = extractBotMessageLink(message);
  if (!link) return;
  console.log("[notifyBot] Link primit din chatul privat configurat; încep procesarea.");
  let acknowledgement;
  try {
    acknowledgement = await notifyBot.sendMessage(message.chat.id, "⏳ Am primit linkul; îl verific și îl procesez acum…", {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
    });
    const result = await enqueueProcess(() => processArticleUrl(link, { bypassSimilarity: true }));
    const response = result?.status === "done"
      ? "✅ Gata — ți-am trimis rezultatul mai sus în chat."
      : result?.status === "pending"
        ? "⏭️ Am găsit o posibilă similaritate. Uită-te la mesajul cu butoane de aprobare; cererea rămâne salvată și după restart."
        : result?.status === "error"
          ? `❌ Nu am putut procesa linkul: ${result.reason}`
          : `ℹ️ Linkul a fost primit, dar nu a fost procesat: ${result?.reason || "motiv necunoscut"}`;
    await notifyBot.editMessageText(response, { chat_id: message.chat.id, message_id: acknowledgement.message_id });
  } catch (err) {
    console.error("[notifyBot manual-link error]", err);
    if (acknowledgement) {
      await notifyBot.editMessageText(`❌ Eroare la procesarea linkului: ${err.message}`, {
        chat_id: message.chat.id,
        message_id: acknowledgement.message_id,
      }).catch(() => {});
    }
  }
});

async function main() {
  try {
    const webhookInfo = await notifyBot.getWebHookInfo();
    if (webhookInfo.url) {
      console.warn("[notifyBot] Webhook existent găsit; îl dezactivez păstrând update-urile în coadă, fiindcă acest proiect folosește long polling.");
      await notifyBot.deleteWebHook({ drop_pending_updates: false });
    }
    // Reîncărcăm cererile din SQLite înainte să livrăm callback-urile aflate
    // în coada Telegram; astfel un click nu poate concura cu recuperarea stării.
    await restorePendingApprovalRequests({ recoverInterrupted: true });
    notifyBot.startPolling().catch((err) => {
      console.error("[notifyBot] Nu am putut porni long polling:", err.message);
    });
    console.log('[notifyBot] Long polling pornit pentru update-uri "message" și "callback_query".');
    setInterval(() => {
      restorePendingApprovalRequests().catch((err) => console.error("[approval restore]", err));
    }, 60 * 1000);
    await notify("🤖 Bot pornit. Pentru procesare manuală, trimite-mi linkul știrii în acest chat privat.");
  } catch (err) {
    console.error("[notifyBot] Inițializarea API-ului Telegram a eșuat:", err.message);
  }

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

    console.log(`[mesaj primit] de la: ${chatUsername || "(fara username)"}`);

    if (!chatUsername || !channelsList.includes(chatUsername)) {
      if (chatUsername) console.log(`[skip] "${chatUsername}" nu e in lista CHANNELS: [${channelsList.join(", ")}]`);
      return;
    }

    const link = extractLink(message);
    if (!link) return; // mesaj fara link, il ignoram (nu e stire)

    const bypassFilters = bypassChannels.includes(chatUsername);
    if (bypassFilters) console.log(`[bypass] Canalul ${chatUsername} ocoleste filtrele (similaritate, keywords, straine)`);
    await enqueueProcess(() => processArticleUrl(link, { bypassFilters }));
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
