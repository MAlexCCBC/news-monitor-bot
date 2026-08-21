// Normalizeaza diacritice ca sa prinda si varianta fara diacritice din articole
function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // scoate diacriticele
}

export function matchesKeywords(text, keywords) {
  const normText = normalize(text);
  const found = keywords.filter((kw) => normText.includes(normalize(kw)));
  return {
    matched: found.length > 0,
    matchedKeywords: found,
  };
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
// fara cuvinte institutionale). Protejeaza impotriva cazurilor in care
// detectSpeaker sau AI-ul returneaza titluri/institutii in loc de nume.
export function isPlausiblePersonName(name) {
  if (!name || typeof name !== "string") return false;
  const t = name.trim();
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (t.length > 60) return false;
  const INSTITUTION = /\b(legea|legii|parlament|senat|senatului|guvern|guvernul|partid|alegeri|campanie|sesiune|sedinta|hidrogen|buget|pensii|criza|accident|cutremur|incendiu)\b/i;
  return !INSTITUTION.test(t);
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
export function detectSpeaker(title, matchedKeywords) {
  const t = title || "";

  // 1. Gasim "despre" — tot ce e INAINTE de "despre" e vorbitorul
  const despreIdx = t.toLowerCase().indexOf("despre");
  if (despreIdx !== -1) {
    const before = t.slice(0, despreIdx).trim();
    const name = extractLastName(before);
    if (name) return name;
  }

  // 2. Pattern-uri comune: "X a declarat", "X a spus", "X a anunțat",
  //    "X transmite", "X consideră", "X susține"
  const verbPatterns = /\b(a declarat|a spus|a anunțat|a precizat|a subliniat|a menționat|transmite|consideră|susține|critică|reactionează|reactioneaza|critică la adresa|iese la atac|vine cu)/i;
  const verbMatch = t.match(verbPatterns);
  if (verbMatch && verbMatch.index > 0) {
    const before = t.slice(0, verbMatch.index).trim();
    const name = extractLastName(before);
    if (name) return name;
  }

  // 3. Titlu care incepe cu nume: "Nume Nume, ..." sau "Nume Nume:" 
  const firstName = extractLastName(t);
  if (firstName) return firstName;

  // 4. Fallback: primul keyword potrivit (metoda veche, pentru compatibilitate)
  if (matchedKeywords && matchedKeywords.length > 0) {
    return matchedKeywords[0];
  }

  return null;
}

// Extrage ultimul nume propriu (2-3 cuvinte cu litera mare) dintr-un text.
// Ex: "Ministrul interimar Dragoș Pîslaru" → "Dragoș Pîslaru"
//     "Premierul interimar Ilie Bolojan:" → "Ilie Bolojan"
function extractLastName(text) {
  // Pattern: 2-3 cuvinte care incep cu litera mare (cu sau fara diacritice)
  // Ignoram cuvinte comune care NU sunt parte din nume
  const SKIP = new Set([
    "ministrul", "ministra", "premierul", "premiera", "presedintele", "presedintia",
    "primarul", "primara", "deputatul", "deputata", "senatorul", "senatoarea",
    "domnul", "doamna", "directorul", "directoarea", "secretarul", "secretara",
    "interimar", "interimara", " interim", "general", "generalul",
    "a", "al", "ale", "ai", "la", "de", "din", "pe", "cu", "si", "sau",
    "că", "ca", "dar", "iar", "unei", "unui", "un", "o", "the", "for",
    "sectorului", "bucurestiului", "romaniei", "guvernului",
    "video", "foto", "live", "breaking", "urgent",
  ]);

  const words = text.split(/[\s,;:!?]+/).filter(Boolean);
  const candidates = [];
  let current = [];

  for (const w of words) {
    const clean = w.replace(/[.:;,!?]+$/, "");
    if (!clean) continue;
    const isCapitalized = /^[A-ZĂÂÎȘȚ]/.test(clean) && !/^[A-ZĂÂÎȘȚ]{2,}$/.test(clean);
    const isLowerSkip = SKIP.has(clean.toLowerCase());

    if (isCapitalized && !isLowerSkip) {
      current.push(clean);
    } else {
      if (current.length >= 2) candidates.push(current.join(" "));
      current = [];
    }
  }
  if (current.length >= 2) candidates.push(current.join(" "));

  // Returnam ULTIMUL nume gasit (de obicei e vorbitorul, nu titlul functional)
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// Verifica daca data articolului (ISO, din meta tags: article:published_time)
// e din ziua curenta, comparat in ora Romaniei (Europe/Bucharest).
export function isPublishedToday(isoDate) {
  if (!isoDate) return false;

  const articleDate = new Date(isoDate);
  if (isNaN(articleDate.getTime())) return false;

  const fmt = (d) =>
    new Intl.DateTimeFormat("ro-RO", {
      timeZone: "Europe/Bucharest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  return fmt(articleDate) === fmt(new Date());
}
