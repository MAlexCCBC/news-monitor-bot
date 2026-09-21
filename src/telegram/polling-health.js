export function createPollingErrorHandler({ bot, chatId, logger = console }) {
  const alertedCodes = new Set();

  return function handlePollingError(err) {
    const code = String(
      err?.response?.body?.error_code ??
      err?.response?.statusCode ??
      err?.code ??
      "unknown"
    );
    logger.warn("[notifyBot polling]", code, err?.response?.body?.description || err?.message || "Eroare necunoscută");

    if (!chatId || alertedCodes.has(code)) return;
    alertedCodes.add(code);

    const detail = code === "409"
      ? "Telegram a detectat alt poller sau un webhook concurent pentru acest bot."
      : `Telegram a returnat eroarea ${code}.`;
    bot.sendMessage(
      chatId,
      `⚠️ Polling-ul Telegram nu poate primi mesaje acum. ${detail} Verifică logurile GitHub Actions.`
    ).catch((sendError) => logger.warn("[notifyBot polling] Nu am putut trimite alerta privată:", sendError.message));
  };
}
