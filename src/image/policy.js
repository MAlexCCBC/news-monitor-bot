export function isVerifiedPersonImageAllowed({ hasReference, samePerson, hasText }) {
  return hasReference === true && samePerson === true && hasText !== true;
}

export function shouldUseArticleThumbnail({ speaker, imageUrl, title = "" }) {
  if (speaker || !imageUrl) return false;
  const normalizedTitle = title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const statementCue = /\b(?:declar\w*|spun\w*|afirm\w*|sustin\w*|critic\w*|reaction\w*|transmit\w*|raspund\w*|anunt\w*|mesaj pentru)\b/.test(normalizedTitle);
  const lead = title.replace(/^[^\p{L}\p{N}]*/u, "");
  const nameLead = /^\p{Lu}[^:]{0,60}:/u.test(lead);
  return !statementCue && !nameLead;
}
