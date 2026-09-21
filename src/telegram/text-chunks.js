const TELEGRAM_TEXT_LIMIT = 3500;

// Text simplu, deci îl putem împărți la paragrafe fără a afecta entități HTML.
// Măsurăm în code units UTF-16 și evităm să rupem caractere emoji/surrogate.
export function splitTelegramText(text, maxLength = TELEGRAM_TEXT_LIMIT) {
  const remaining = String(text ?? "");
  if (!Number.isInteger(maxLength) || maxLength < 100) {
    throw new RangeError("Limita unui fragment Telegram trebuie să fie cel puțin 100.");
  }
  if (remaining.length <= maxLength) return remaining ? [remaining] : [];

  const chunks = [];
  let rest = remaining;
  while (rest.length > maxLength) {
    let cut = maxLength;
    const paragraphBreak = rest.lastIndexOf("\n\n", maxLength);
    const lineBreak = rest.lastIndexOf("\n", maxLength);
    if (paragraphBreak > Math.floor(maxLength * 0.55)) {
      cut = paragraphBreak + 2;
    } else if (lineBreak > Math.floor(maxLength * 0.55)) {
      cut = lineBreak + 1;
    }

    // Nu separăm perechile UTF-16 care reprezintă emoji non-BMP.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
