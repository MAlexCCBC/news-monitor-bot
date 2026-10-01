// Normalizeaza diacritice ca sa prinda si varianta fara diacritice din articole
import { parsePublicationDate } from "./publication-date.js";

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // scoate diacriticele
}

// Cerute explicit pentru acest flux editorial: prioritizează știrile despre
// Mureșan, Bolojan, PNL, USR și politică chiar dacă KEYWORDS extern e incomplet.
export const CORE_POLITICAL_KEYWORDS = [
  "Mureșan",
  "Bolojan",
  "PNL",
  "Partidul Național Liberal",
  "USR",
  "Uniunea Salvați România",
  "politic",
];

export const CORE_ROMANIAN_POLITICAL_CONTEXT = [
  "Mureșan",
  "Bolojan",
  "PNL",
  "Partidul Național Liberal",
  "USR",
  "Uniunea Salvați România",
];

const ROMANIAN_POLITICAL_HEADLINE_SIGNALS = [
  "psd", "pnl", "usr", "aur", "guvern", "ministr", "parlament", "senat",
  "deputat", "senator", "aleger", "politic", "presedint", "primar", "coalit",
  "vot", "legislativ", "opozit", "majoritat", "campan", "buget", "ordonant",
  "partid",
];
const PUBLIC_STATEMENT_SIGNALS = [
  "declar", "anunt", "spun", "afirm", "critic", "acuz", "reaction", "transmit",
  "mesaj", "solicit", "cer", "propun", "explic", "sustin", "avertiz", "intervin",
  "interviu", "pozitie", "reiter",
];
const PRIVATE_LIFE_SIGNALS = [
  "doliu", "murit", "muri", "deces", "deced", "inmormant", "funerar", "mama",
  "tata", "sotie", "sotul", "fiica", "fiul", "familie", "nunta", "divort",
];

// Archive/anniversary formats routinely mention Romanian elections and public
// officials while describing decades-old events. They are not current news
// candidates for this monitor, even if the article happens to contain political
// vocabulary in its first paragraphs.
export function isHistoricalRoundup(title = "", url = "") {
  const normalizedTitle = normalize(title);
  let pathname = "";
  try { pathname = new URL(url).pathname.toLowerCase(); } catch {}
  return /\/digistoria\//.test(pathname) ||
    /\b(?:digistoria|cele mai importante evenimente petrecute|evenimente petrecute pe|in aceasta zi|acum [0-9]+ de ani)\b/.test(normalizedTitle) ||
    /\/mediafax-35\//.test(pathname);
}

export function matchesKeywords(text, keywords) {
  const normText = normalize(text);
  const found = keywords.filter((kw) => {
    const normalized = normalize(String(kw)).trim();
    if (!normalized) return false;
    // Short party acronyms must not match ordinary words.
    return normalized.length <= 3 ? hasWord(normText, normalized) : normText.includes(normalized);
  });
  return {
    matched: found.length > 0,
    matchedKeywords: found,
  };
}

// Major, state-coordinated emergencies are public-interest coverage even when
// they are not political. This deliberately excludes ordinary local fires and
// accidents: require a vegetation/forest fire, an official response, and a
// strong scale signal such as multi-county operations or military aircraft.
export function hasMajorRomanianEmergencyContext(text) {
  const norm = normalize(String(text || ""));
  const vegetationFire = /\bincendi\w*\b/.test(norm) && /\b(?:vegetati\w*|padur\w*|fond forestier)\b/.test(norm);
  const officialResponse = /\b(?:autoritati|pompieri|isu|igsu|dsu|mapn|mai|interven\w*|mobiliz\w*)\b/.test(norm);
  const multiRegion = /\b(?:mai multe judete|doua judete|in doua judete|in mai multe judete|la nivel national)\b/.test(norm);
  const exceptionalResources = /\b(?:black hawk|spartan|aeronave? militare?|avioane? militare?)\b/.test(norm);
  const largeDeployment = /\b(?:peste|mai mult de)\s*(?:[1-9]\d{2,})\s*(?:de\s+)?(?:pompieri|salvatori|hectare)\b/.test(norm);
  return vegetationFire && officialResponse && (multiRegion || exceptionalResources || largeDeployment);
}

// Indicatori ca stirea are subiectul in ALTA tara (fara implicare romaneasca).
// Matching pe text normalizat (fara diacritice), pe LIMITE DE CUVINTE — altfel
// token-uri scurte ca "sua" s-ar potrivi si in cuvinte precum "insua".
const FOREIGN_INDICATORS = [
  // Rusia / spatiul post-sovietic
  "rusia", "rusiei", "rusii", "ruseasca", "rusesc", "putin", "kremlin", "moscova",
  "ucraina", "ucrainei", "ucrainean", "zelenski", "cernobil", "cernobyl", "chernobyl",
  "belarus", "bielorus", "lucasenko",
  // Vest / America de Nord
  "sua", "america", "americii", "american", "trump", "biden", "vance", "washington",
  "canada", "mexic",
  // Asia
  "china", "chinez", "beijing", "xi jinping", "japonia", "japonez", "coreea",
  "india", "indian", "pakistan", "indonezia", "tailanda", "vietnam",
  // Orientul Mijlociu
  "israel", "israelian", "netanyahu", "iran", "iranian", "teheran", "irak",
  "arabia", "saudit", "emirate", "qatar", "turcia", "turc", "erdogan", "ankara",
  "syria", "siria", "damasc", "liban", "yemen",
  // Europa
  "bulgaria", "bulgar", "ungaria", "unguresc", "ungar",
  "germania", "german", "merz", "franta", "francez", "macron", "paris",
  "polonia", "polonez", "marea britanie", "britanic", "starmer", "londra",
  "spania", "spaniol", "italia", "italian", "meloni", "olanda", "olandez",
  "austria", "austriac", "elvetia", "elvetian", "suedia", "suedez", "norvegia",
  "finlanda", "danemarca", "irlanda", "portugalia", "cehia", "ceh", "slovacia",
  "slovac", "fico", "croatia", "croat", "serbia", "sarb", "vucic", "bosnia",
  "albania", "albanez", "macedonia", "grecia", "grec", "atena",
  "nato", "bruxelles", "comisia europeana",
];

// Indicatori ca stirea e legata de Romania (tara, popor, orase mari, institutii)
const ROMANIA_INDICATORS = [
  "roman", "romania", "romaniei", "romanesc", "romaneasca", "bucuresti", "diaspora",
  "cluj", "timisoara", "iasi", "brasov", "sibiu", "constanta", "craiova",
  "galati", "oradea", "bacau", "arad", "suceava", "pitesti", "targu mures",
  "transilvania", "moldova", "dobrogea", "banat", "olt", "mures", "prut",
  "guvernul roman", "parlamentul roman", "presedintele roman",
];

// Potrivire pe limite de cuvinte: \b in JS e ASCII-based, dar textul e deja
// normalizat (diacriticele scoase), deci functioneaza corect.
function hasWord(normText, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(normText);
}

// Pre-check IEFTIN (fara AI): daca textul are context romanesc clar, nu mai
// cheltuim un apel Gemini la clasificarea de relevanta. Returneaza true doar
// cand e evident ca stirea priveste Romania (indicator RO sau personalitate).
export function hasStrongRomanianContext(text, personalities) {
  const norm = normalize(text);
  if (ROMANIA_INDICATORS.some((w) => hasWord(norm, w))) return true;
  return personalities.some((kw) => norm.includes(normalize(kw)));
}

function hasTokenPrefix(normText, roots) {
  const words = normText.match(/[a-z0-9]+/g) || [];
  return roots.some((root) => words.some((word) => word.startsWith(root)));
}

// Fast-path public political statements by known Romanian figures and
// unmistakable political events. Match Romanian inflections ("guvernul",
// "miniștrii", "parlamentului"), not only dictionary forms. Personal-life
// headlines remain subject to the AI classifier even if a politician is named.
export function hasStrongRomanianPoliticalContext(text, personalities) {
  const norm = normalize(text || "");
  const rawTitle = String(text || "").split("\n", 1)[0];
  const title = normalize(rawTitle);
  const privateLifeHeadline = hasTokenPrefix(title, PRIVATE_LIFE_SIGNALS);
  if (privateLifeHeadline) return false;

  const namedRomanianFigure = personalities.some((name) => hasWord(title, normalize(name)));
  // "Republica Moldova" is a separate state; its domestic politics alone is
  // not proof of Romanian political relevance. Let the classifier judge it.
  const isMoldovanStateOnly = /\brepublic(?:a|ii) moldova\b/.test(norm) &&
    !ROMANIA_INDICATORS.filter((w) => w !== "moldova").some((w) => hasWord(norm, w)) &&
    !namedRomanianFigure;
  const hasRomanianContext = (!isMoldovanStateOnly &&
    ROMANIA_INDICATORS.some((w) => hasWord(norm, w))) || namedRomanianFigure;
  if (!hasRomanianContext) return false;

  const hasPoliticalSignal = hasTokenPrefix(title, ROMANIAN_POLITICAL_HEADLINE_SIGNALS.filter((root) => !["psd", "pnl", "usr", "aur"].includes(root))) ||
    ["psd", "pnl", "usr", "aur"].some((party) => hasWord(title, party));
  const explicitlyQuotedFigureStatement = namedRomanianFigure && /^[^:\n]{1,80}:\s/.test(rawTitle);
  const knownFigureMakingPublicStatement = namedRomanianFigure &&
    (explicitlyQuotedFigureStatement || hasTokenPrefix(title, PUBLIC_STATEMENT_SIGNALS));
  // Foreign headlines with incidental Romanian background need a classifier.
  const foreignHeadline = FOREIGN_INDICATORS.some((word) => hasWord(title, word));
  const romanianHeadline = ROMANIA_INDICATORS.some((word) => hasWord(title, word)) || namedRomanianFigure;
  if (foreignHeadline && !romanianHeadline) return false;
  return hasPoliticalSignal || knownFigureMakingPublicStatement;
}

// FALLBACK (doar cand AI-ul de relevanta nu e disponibil): returneaza true daca
// stirea e despre un subiect strain fara nicio legatura cu Romania sau cu
// personalitati politice romanesti reale.
// `personalities` = DOAR numele reale (ex. "Bolojan", "Fritz"), NU cuvinte
// generice precum "ministrul" sau "premierul" (ele apar si in stiri straine,
// ex. "ministrul federal Carsten Schneider" si ar lasa stiri straine sa treaca).
export function isForeignOnly(text, personalities) {
  const norm = normalize(text);
  const hasForeign = FOREIGN_INDICATORS.some((w) => hasWord(norm, w));
  if (!hasForeign) return false;
  const hasRomanianContext = ROMANIA_INDICATORS.some((w) => hasWord(norm, w));
  const hasRomanianPerson = personalities.some((kw) => norm.includes(normalize(kw)));
  return !hasRomanianContext && !hasRomanianPerson;
}

// Verifica daca un sir arata ca nume de persoana (2-5 cuvinte, lungime mica,
// fara cuvinte institutionale, fara acronime). Protejeaza impotriva cazurilor
// in care detectSpeaker sau AI-ul returneaza titluri/institutii/partide in loc
// de nume.
export function isPlausiblePersonName(name) {
  if (!name || typeof name !== "string") return false;
  const t = name.trim();
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (t.length > 60) return false;
  const INSTITUTION = /\b(legea|legii|parlament|senat|senatului|guvern|guvernul|partid|alegeri|campanie|sesiune|sedinta|hidrogen|buget|pensii|criza|accident|cutremur|incendiu)\b/i;
  if (INSTITUTION.test(t)) return false;
  // Acronime/partide (USR, CCR, PSD...) = toate literele mari, fara nimic mic.
  // Numele reale contin cel putin o litera mica undeva in cuvant.
  const hasAcronym = words.some(
    (w) => w.replace(/[^A-Za-zĂÂÎȘȚăâîșț]/g, "").length >= 2 &&
           w.replace(/[^A-Za-zĂÂÎȘȚăâîșț]/g, "") === w.replace(/[^A-Za-zĂÂÎȘȚăâîșț]/g, "").toUpperCase()
  );
  return !hasAcronym;
}

// Detecteaza CINE face declaratia (vorbitorul), nu despre cine se vorbeste.
// Functioneaza cu ORICE persoana, nu doar cele din lista KEYWORDS.
// Ex: "Dragoș Pîslaru despre Nicușor Dan" → "Dragoș Pîslaru"
//     "Ciprian Ciucu a declarat că..." → "Ciprian Ciucu"
//     "Primarul sectorului 6 a anunțat..." → null (nu e nume propriu)
//
// Algoritm: extragem toate secventele de cuvinte cu litera mare din titlu
// (potential nume proprii), apoi folosim "despre" / "a declarat" / "a spus"
// pentru a afla CINE vorbeste.
// Gaseste PRIMUL candidat viabil la statutul de "nume de vorbitor" intr-un
// text: secventa de 2-3 cuvinte cu initiale mari, aflata LA INCEPUTUL textului
// sau urmată imediat de ":" / "," (tipare clasice de titlu de stire). Strict
// intentionat: regulile permisive produceau nume false ("Fritz Putem",
// "Constituției Fritz", "Mița Biciclista").
function firstSpeakerCandidate(text) {
  if (!text) return null;
  const seqRe = /[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){1,2}/g;
  const TITLES = /^(?:ministrul|ministra|premierul|premiera|presedintele|presedintia|primarul|primara|deputatul|deputata|senatorul|senatoarea)\s+/i;
  let m;
  while ((m = seqRe.exec(text)) !== null) {
    let name = m[0];
    // Scoatem functia de la inceput ("Primarul Ciprian Ciucu" -> "Ciprian
    // Ciucu") - cautarea Wikipedia nu gaseste pagini cu titluri in nume.
    if (TITLES.test(name)) {
      name = name.replace(TITLES, "");
      if (name.split(/\s+/).length < 2) continue;
    }
    if (!isPlausiblePersonName(name)) continue;
    const after = text.slice(m.index + m[0].length);
    if (m.index === 0 || /^[:,]/.test(after)) return name;
  }
  return null;
}

export function detectSpeaker(title, matchedKeywords) {
  const t = title || "";

  // 1. "X despre Y" -> X e vorbitorul (doar daca X contine un nume clar)
  const despreIdx = t.toLowerCase().indexOf("despre");
  if (despreIdx !== -1) {
    const name = firstSpeakerCandidate(t.slice(0, despreIdx).trim());
    if (name) return name;
  }

  // 2. Pattern-uri de verbe de declaratie: "X a declarat", "X a spus" etc.
  const verbPatterns = /\b(a declarat|a spus|a anunțat|a anunțа|a precizat|a subliniat|a menționat|transmite|consideră|susține|critică|reactionează|reactioneaza|iese la atac|vine cu)/i;
  const verbMatch = t.match(verbPatterns);
  if (verbMatch && verbMatch.index > 0) {
    const name = firstSpeakerCandidate(t.slice(0, verbMatch.index).trim());
    if (name) return name;
  }

  // 3. Nume la începutul titlului sau urmat de ":" / ","
  const direct = firstSpeakerCandidate(t);
  if (direct) return direct;

  // 4. Fallback: cel mai LUNG keyword potrivit care arata a nume de persoana.
  //    "Dominic Fritz" bate "Fritz"; acronimele de partid (USR, CCR) sunt
  //    respinse de isPlausiblePersonName. Un simplu nume de familie e ambiguu
  //    pe Wikipedia (ex: cautarea "Fritz" returna portretul lui Fritz Bauer!).
  if (matchedKeywords && matchedKeywords.length > 0) {
    const sorted = [...matchedKeywords].sort(
      (a, b) => b.split(/\s+/).length - a.split(/\s+/).length
    );
    for (const kw of sorted) {
      if (isPlausiblePersonName(kw)) return kw;
    }
  }

  return null;
}

// Verifica daca data articolului (ISO, din meta tags: article:published_time)

// Verifica daca data articolului (ISO, din meta tags: article:published_time)
// e din ziua curenta, comparat in ora Romaniei (Europe/Bucharest).
export function isPublishedToday(isoDate, now = Date.now()) {
  if (!isoDate) return false;

  const timestamp = parsePublicationDate(isoDate);
  if (timestamp === null || timestamp > now + 5 * 60_000) return false;
  const articleDate = new Date(timestamp);

  const fmt = (d) =>
    new Intl.DateTimeFormat("ro-RO", {
      timeZone: "Europe/Bucharest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  return fmt(articleDate) === fmt(new Date(now));
}
