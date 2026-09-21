export function parseApprovalCallback(data = "") {
  if (data.startsWith("proc_")) return { action: "process", id: data.slice(5) };
  if (data.startsWith("ign_")) return { action: "ignore", id: data.slice(4) };
  return null;
}

export async function answerCallbackSafely(bot, callbackQuery, options, logger = console) {
  try {
    await bot.answerCallbackQuery(callbackQuery.id, options);
    return true;
  } catch (err) {
    // Callback updates can remain queued while the bot is offline; Telegram
    // only permits answering them briefly. A stale acknowledgement must never
    // abort the actual persisted approval action or crash the polling process.
    logger.warn("[approval callback] Nu am putut confirma callback-ul Telegram:", err?.message || String(err));
    return false;
  }
}
