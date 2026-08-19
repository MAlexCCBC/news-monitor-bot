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
