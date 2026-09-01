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
  try {
    if (typeof pendingSimilarArticles !== "undefined") {
      for (const item of pendingSimilarArticles.values()) {
        if (item.timeoutId) clearTimeout(item.timeoutId);
      }
    }
  } catch {}
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
import { checkSimilarity } from "./similarity/embedding.js";
import { rewriteArticle } from "./ai/rewrite.js";
import { isRelevantToRomania } from "./ai/relevance.js";
import { extractSpeakerFromArticle } from "./ai/speaker.js";
import { findImage, processArticleImage } from "./image/search.js";
import { saveNews, getRecentNews, isUrlSeen, cleanupOld } from "./storage/db.js";
import { persistNow } from "./storage/persist.js";

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
const notifyBot = new TelegramBot(NOTIFY_BOT_TOKEN, { polling: true });
notifyBot.on("polling_error", (err) => {
  if (!err?.message?.includes("ETELEGRAM: 409")) {
    console.warn("[notifyBot polling]", err.message);
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Harta pentru stiri similare in asteptare de aprobare manuala
const pendingSimilarArticles = new Map();

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

// Handler pentru butoanele inline (✅ Proceseaza stirea / ❌ Ignora)
notifyBot.on("callback_query", async (callbackQuery) => {
  const data = callbackQuery.data || "";
  const msgId = callbackQuery.message?.message_id;

  if (data.startsWith("proc_")) {
    const pendingId = data.replace("proc_", "");
    const item = pendingSimilarArticles.get(pendingId);

    if (!item) {
      await notifyBot.answerCallbackQuery(callbackQuery.id, {
        text: "Această cerere a expirat sau a fost deja procesată.",
        show_alert: true,
      });
      return;
    }

    clearTimeout(item.timeoutId);
    pendingSimilarArticles.delete(pendingId);

    await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Se procesează știrea..." });

    try {
      await notifyBot.editMessageText(
        `⚙️ <b>Se procesează știrea aprobată...</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${item.url}`,
        {
          chat_id: NOTIFY_CHAT_ID,
          message_id: msgId,
          parse_mode: "HTML",
        }
      );
    } catch {}

    await enqueueProcess(async () => {
      try {
        await finalizeAndSendArticle(item.article, item.url, item.simResult, item.matchedKeywords);
        try {
          await notifyBot.editMessageText(
            `✅ <b>Știre procesată și trimisă cu succes!</b>\n\n<b>Titlu:</b> ${escapeHtml(item.article.title)}\n<b>Sursă:</b> ${item.url}`,
            {
              chat_id: NOTIFY_CHAT_ID,
              message_id: msgId,
              parse_mode: "HTML",
            }
          );
        } catch {}
      } catch (err) {
        console.error("[callback proc eroare]", err);
        await notify(`❌ Eroare la procesarea știrii aprobate:\n${item.url}\n${err.message}`);
      }
    });
  } else if (data.startsWith("ign_")) {
    const pendingId = data.replace("ign_", "");
    const item = pendingSimilarArticles.get(pendingId);
    if (item) {
      clearTimeout(item.timeoutId);
      pendingSimilarArticles.delete(pendingId);
    }

    await notifyBot.answerCallbackQuery(callbackQuery.id, { text: "Știre ignorată." });
    try {
      await notifyBot.editMessageText(
        `❌ <b>Știre ignorată manual.</b>\n\n<b>Titlu:</b> ${item ? escapeHtml(item.article.title) : ""}\n<b>Sursă:</b> ${item ? item.url : ""}`,
        {
          chat_id: NOTIFY_CHAT_ID,
          message_id: msgId,
          parse_mode: "HTML",
        }
      );
    } catch {}
  }
});

// Extrage domeniul unui URL, normalizat (fara www.): ex. "www.mediafax.ro" -> "mediafax.ro"
function normalizeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

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
async function finalizeAndSendArticle(article, url, simResult, matchedKeywords = []) {
  // 4. Reformatare cu AI (cascada de modele)
  const { text: formattedPost } = await rewriteArticle(article.fullTextForKeywordCheck);

  // 5. Salvam in istoric ACUM (ca sa nu se re-proceseze si sa prindem embedding-ul deja calculat)
  saveNews({
    url,
    title: article.title,
    content: article.content,
    embedding: simResult?.embedding ?? null,
  });

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

  console.log("[ok] Trimis pentru aprobare");
}

async function processArticleUrl(url, { bypassFilters = false } = {}) {
  try {
    if (isUrlSeen(url)) {
      console.log(`[skip] URL deja procesat: ${url}`);
      return;
    }

    console.log(`[procesare] ${url}`);
    const article = await fetchArticle(url);

    if (!article.content || article.content.length < 100) {
      console.log(
        `[skip] Continut prea scurt / nu s-a putut extrage (${article.content?.length || 0} caractere, titlu: "${article.title}")`
      );
      return;
    }

    // 1. Verificare data (trebuie sa fie din ziua curenta)
    if (!isPublishedToday(article.isoDate)) {
      console.log(`[skip] Nu e din ziua curenta (data gasita: "${article.isoDate}")`);
      return;
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
        return;
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
        return;
      }
    }

    // 3. Verificare similaritate cu ultimele 72h pe amprenta concentrata (Titlu + Lead 300 caractere).
    let simResult = null;
    if (!bypassFilters) {
      const recentNews = getRecentNews(historyHours);
      const textToEmbed = `${article.title}. ${(article.content || "").slice(0, 300)}`;
      simResult = await checkSimilarity(textToEmbed, recentNews, threshold);

      if (simResult.isDuplicate) {
        const sameSite =
          simResult.similarUrl && normalizeHost(simResult.similarUrl) === normalizeHost(url);
        if (sameSite) {
          console.log(
            `[pas] Similar ${(simResult.similarity * 100).toFixed(0)}% dar e ACELASI site (${normalizeHost(url)}) - articol diferit, continuam`
          );
        } else {
          console.log(
            `[similar] Similaritate ${(simResult.similarity * 100).toFixed(1)}% cu ${simResult.similarUrl} - trimit cerere interactiva cu butoane`
          );
          
          const pendingId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const escapedTitle = escapeHtml(article.title);

          const msgText = `⏭️ <b>Știre similară (${(simResult.similarity * 100).toFixed(0)}%)</b>\n\n` +
            `<b>Titlu:</b> ${escapedTitle}\n` +
            `<b>Sursă:</b> ${url}\n\n` +
            `<b>Similară cu:</b> ${simResult.similarUrl}\n\n` +
            `<i>Dorești să fie procesată și trimisă oricum? (Apasă un buton sau va expira automat într-o oră)</i>`;

          try {
            const sentMsg = await notifyBot.sendMessage(NOTIFY_CHAT_ID, msgText, {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ Procesează știrea", callback_data: `proc_${pendingId}` },
                    { text: "❌ Ignoră", callback_data: `ign_${pendingId}` },
                  ],
                ],
              },
            });

            const timeoutId = setTimeout(async () => {
              if (pendingSimilarArticles.has(pendingId)) {
                pendingSimilarArticles.delete(pendingId);
                try {
                  await notifyBot.editMessageText(
                    `⌛ <b>Știre similară (${(simResult.similarity * 100).toFixed(0)}%) - Expirată automat (1 oră)</b>\n\n<b>Titlu:</b> ${escapedTitle}\n<b>Sursă:</b> ${url}`,
                    {
                      chat_id: NOTIFY_CHAT_ID,
                      message_id: sentMsg.message_id,
                      parse_mode: "HTML",
                    }
                  );
                } catch {}
              }
            }, 60 * 60 * 1000); // 1 ora expirare automata

            pendingSimilarArticles.set(pendingId, {
              article,
              url,
              simResult,
              matchedKeywords,
              timeoutId,
              messageId: sentMsg.message_id,
            });
          } catch (e) {
            console.error("[similar notify eroare]", e.message);
          }

          // Continuam procesarea altor stiri fara blocaj
          return;
        }
      }
    } else {
      console.log("[pas] Canal bypass - sarim peste filtrul de similaritate");
    }

    // Daca a trecut toate filtrele sau e pe acelasi site / bypass, finalizam
    await finalizeAndSendArticle(article, url, simResult, matchedKeywords);
  } catch (err) {
    console.error(`[eroare] la procesarea ${url}:`, err.message);
    await notify(`❌ Eroare la procesarea unui articol:\n${url}\n${err.message}`).catch(() => {});
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

async function main() {
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
  await notify("🤖 Bot pornit. Monitorizez canalele și îți trimit stiri filtrate pentru aprobare.");

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
