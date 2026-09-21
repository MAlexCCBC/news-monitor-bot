export function extractBotMessageLink(message) {
  const text = message?.text || message?.caption || "";
  const entities = message?.entities || message?.caption_entities || [];
  const linkedEntity = entities.find((entity) => entity.type === "text_link" && entity.url);
  const urlEntity = entities.find((entity) => entity.type === "url");
  const entityUrl = urlEntity
    ? text.slice(urlEntity.offset, urlEntity.offset + urlEntity.length)
    : null;
  const rawUrl = linkedEntity?.url || entityUrl || text.match(/https?:\/\/[^\s<>]+/)?.[0];
  if (!rawUrl) return null;

  const cleanUrl = rawUrl.replace(/[),.!?;:\]]+$/g, "");
  try {
    const parsed = new URL(cleanUrl);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
