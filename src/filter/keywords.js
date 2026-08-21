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
// Matching pe text normalizat (fara diacritice).
const FOREIGN_INDICATORS = [
  "rusia", "rusiei", "rusii", "ruseasca", "rusesc", "putin", "kremlin", "moscova",
  "ucraina", "ucrainei", "ucrainean", "zelenski", "cernobil", "cernobyl", "chernobyl",
  "belarus", "bielorus",
  "sua", "america", "americii", "american", "trump", "biden",
  "china", "chinez", "israel", "israelian", "iran", "iranian",
  "bulgaria", "bulgar", "ungaria", "unguresc", "ungar",
  "germania", "german", "frant", "france", "polonia", "polonez",
  "marea britanie", "britanic", "spania", "italia", "italian", "nato",
];

// Indicatori ca stirea e legata de Romania (tara, popor, Bucuresti)
const ROMANIA_INDICATORS = ["roman", "bucuresti"];

// Returneaza true daca stirea e despre un subiect strain fara nicio legatura
// cu Romania sau cu personalitati politice romanesti reale.
// `personalities` = DOAR numele reale (ex. "Bolojan", "Fritz"), NU cuvinte
// generice precum "ministrul" sau "premierul" (ele apar si in stiri straine,
// ex. "ministrul federal Carsten Schneider" si ar lasa stiri straine sa treaca).
export function isForeignOnly(text, personalities) {
  const norm = normalize(text);
  const hasForeign = FOREIGN_INDICATORS.some((w) => norm.includes(w));
  if (!hasForeign) return false;
  const hasRomanianContext = ROMANIA_INDICATORS.some((w) => norm.includes(w));
  const hasRomanianPerson = personalities.some((kw) => norm.includes(normalize(kw)));
  return !hasRomanianContext && !hasRomanianPerson;
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
