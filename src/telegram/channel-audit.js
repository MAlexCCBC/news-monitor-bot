export function formatChannelAudit(entry) {
  const normalized = {
    channel: entry.channel || null,
    messageId: entry.messageId || null,
    title: entry.title ? String(entry.title).replace(/\s+/g, " ").trim().slice(0, 200) : null,
    url: entry.url || null,
    status: entry.status || "received",
    reason: entry.reason || null,
  };
  return `[channel-audit] ${JSON.stringify(normalized)}`;
}
