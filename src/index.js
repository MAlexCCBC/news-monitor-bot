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
import { isNewDevelopment } from "./ai/duplicate.js";
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
const threshold = Number(SIMILARITY_THRESHOLD || 0.4);
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

// Bot-ul care iti trimite TIE mesaje private (separat de contul tau personal)
const notifyBot = new TelegramBot(NOTIFY_BOT_TOKEN, { polling: false });

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

    // Textul esential al stirii = titlul + primul paragraf. Il folosim pentru
    // keywords, filtru straine si similaritate (nu tot textul, care include
    // nume din sidebar/recomandari si provoaca false pozitive).
    const essentialText = `${article.title}\n${(article.content || "").slice(0, 500)}`;

    // 2. Verificare keywords (pe titlu + primul paragraf).
    // Canalele din BYPASS_CHANNELS (ex: canalul tau de rezerva) nu sunt blocate
    // de lipsa keywords, dar LOGAM daca sunt sau nu gasite.
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

    // 2b. Filtru stiri straine (DINAMIC, cu AI): daca textul nu are context
    // romanesc clar (tara, orase, personalitati), intrebam Gemini daca subiectul
    // principal priveste Romania. Astfel prindem ORICE tara straina (Austria,
    // Serbia, Grecia, India...), nu doar cele aflate pe o lista fixa. Daca
    // AI-ul nu e disponibil, cadem pe vechiul filtru pe cuvinte cheie.
    // Canalele bypass trec si peste acest filtru.
    if (!bypassFilters && !hasStrongRomanianContext(essentialText, romanianPersonalities)) {
      const relevant = await isRelevantToRomania(
        article.title,
        (article.content || "").slice(0, 1500)
      );
      const foreign =
        relevant === null
          ? isForeignOnly(essentialText, romanianPersonalities) // fallback fara AI
          : !relevant;
      if (foreign) {
        console.log("[skip] Stire straina fara implicare romaneasca");
        return;
      }
    }

    // 3. Verificare similaritate cu ultimele 72h, pe titlu + primul paragraf.
    // Canalele din BYPASS_CHANNELS (ex: canalul tau de rezerva) ocolesc complet
    // acest filtru - nu se compara si nu se blocheaza nimic, ca sa poti pune
    // orice acolo daca da prost.
    // Regula de site: daca match-ul cel mai apropiat e de pe ACELASI site,
    // nu-l consideram duplicat - un site nu isi republiceaza singur aceeasi
    // stire cu alt URL, deci e un articol diferit (chiar daca similar ca subiect,
    // ex. doua declaratii Bolojan in aceeasi zi). Duplicatele reale apar pe
    // SITE-URI DIFERITE (aceeasi stire preluata in toate canalele).
    let simResult = null;
    if (!bypassFilters) {
      const recentNews = getRecentNews(historyHours);
      simResult = await checkSimilarity(essentialText, recentNews, threshold);

      if (simResult.isDuplicate) {
        const sameSite =
          simResult.similarUrl && normalizeHost(simResult.similarUrl) === normalizeHost(url);
        if (sameSite) {
          console.log(
            `[pas] Similar ${(simResult.similarity * 100).toFixed(0)}% dar e ACELASI site (${normalizeHost(url)}) - articol diferit, continuam`
          );
        } else {
          // Arbitraj AI: similaritate mare != mereu duplicat. Ex: stirea 1 e
          // "decizia CCR care il vizeaza pe Fritz", stirea 2 e "Fritz comenteaza
          // decizia CCR" - embedding-ul le vede ~85% similare, dar a doua are o
          // DECLARATIE noua => nu e duplicat. Intrebam Gemini daca stirea aduce
          // ceva nou (declaratie, citat, detalii) sau doar reformuleaza.
          const prevRow = recentNews.find((r) => r.url === simResult.similarUrl);
          const verdict = prevRow
            ? await isNewDevelopment(
                `${prevRow.title || ""}\n${(prevRow.content || "").slice(0, 1200)}`,
                `${article.title}\n${(article.content || "").slice(0, 1200)}`
              )
            : null;

          if (verdict === "NOU") {
            console.log(
              `[pas] Similar ${(simResult.similarity * 100).toFixed(0)}% DAR aduce elemente noi (declaratie/detalii) - continuam`
            );
          } else {
            console.log(
              `[skip] Prea similar (${(simResult.similarity * 100).toFixed(1)}%) cu ${simResult.similarUrl}${verdict === "DUBLURA" ? " - confirmat DUBLURA de AI" : ""}`
            );
            await notify(
              `⏭️ <b>Stire ignorata (similaritate ${(simResult.similarity * 100).toFixed(0)}%)</b>\n${article.title}\n${url}\n\nSimilara cu: ${simResult.similarUrl}`
            );
            return;
          }
        }
      }
    } else {
      console.log("[pas] Canal bypass - sarim peste filtrul de similaritate");
    }

    // 4. Reformatare cu AI (cascada de modele)
    const { text: formattedPost } = await rewriteArticle(article.fullTextForKeywordCheck);

    // 5. Salvam in istoric ACUM (ca sa nu se re-proceseze si sa prindem embedding-ul deja calculat)
    saveNews({
      url,
      title: article.title,
      content: article.content,
      embedding: simResult?.embedding ?? null,
    });

    // 6. Sistemul inteligent de imagini. Vorbitorul se determina in 2 pasi:
    //    a) regex rapid pe titlu (detectSpeaker);
    //    b) daca regex-ul nu gaseste un nume plauzibil, AI-ul CITESTE stirea
    //       si extrage numele persoanei care declara. Daca nici AI-ul nu
    //       gaseste o persoana (stiri despre legi/institutii/evenimente),
    //       NU mai cautam poze de persoana deloc - trecem direct la imaginea
    //       articolului, fara sa ardem apeluri de verificare faciala.
    let speaker = detectSpeaker(article.title, matchedKeywords);
    if (!isPlausiblePersonName(speaker)) {
      speaker = await extractSpeakerFromArticle(
        article.title,
        (article.content || "").slice(0, 1500)
      );
    }

    let imageResult = null;
    if (speaker && isPlausiblePersonName(speaker)) {
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
    // Postarea finala e doar textul curat (fara header, fara nota imagine,
    // fara asteriscuri markdown) - exact ce se poate posta asa cum e.
    // Link-ul sursei sta CAPTION sub imagine (ca sa stii care stire e preluata),
    // NU in textul rescris.
    const cleanPost = formattedPost.replace(/\*\*/g, "").trim();

    if (imageResult) {
      // Poza cu link-ul articolului sub ea, textul rescris ca mesaj separat.
      await notifyWithImage(url, imageResult.buffer);
      if (cleanPost) await notifyPlain(cleanPost);
    } else {
      // Fara imagine: textul intai, apoi SEPARAT sursa + avertismentul,
      // ca sa nu se amestece cu postarea.
      if (cleanPost) await notifyPlain(cleanPost);
      await notifyPlain(
        `Sursa: ${url}\n\n⚠️ Nu am gasit imagine noua automat, cauta manual pentru: ${speaker}`
      );
    }

    console.log("[ok] Trimis pentru aprobare");
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
}

main().catch((err) => {
  console.error("Eroare fatala:", err);
  process.exit(1);
});
