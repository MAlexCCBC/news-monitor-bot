function isUnchangedMessageError(error) {
  const description = error?.response?.body?.description || error?.message || "";
  return /message is not modified/i.test(description);
}

// Telegram returns HTTP 400 for an edit that would leave both text and
// buttons unchanged. Treat it as an idempotent no-op; other API failures still
// propagate to the caller for normal logging/recovery.
export async function editMessageUnlessUnchanged(bot, text, options) {
  try {
    await bot.editMessageText(text, options);
    return true;
  } catch (error) {
    if (isUnchangedMessageError(error)) return false;
    throw error;
  }
}
