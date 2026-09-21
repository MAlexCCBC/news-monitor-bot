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

export function createManualMessageHandler({ bot, authorizedChatId, enqueue, processUrl, logger = console }) {
  return async function handleManualMessage(message) {
    if (message.from?.is_bot) return;
    if (message.chat?.type !== "private") {
      logger.log(`[notifyBot] Update message primit (chatType=${message.chat?.type || "necunoscut"}); ignorat deoarece nu este chat privat.`);
      return;
    }

    const authorizedChat = String(message.chat?.id) === String(authorizedChatId);
    const link = extractBotMessageLink(message);
    logger.log(`[notifyBot] Mesaj privat primit; chat configurat: ${authorizedChat ? "da" : "nu"}; link detectabil: ${link ? "da" : "nu"}.`);

    if (!authorizedChat) {
      await bot.sendMessage(
        message.chat.id,
        "Am primit mesajul, dar acest bot procesează linkuri doar din chatul privat autorizat. Verifică valoarea secretului NOTIFY_CHAT_ID din configurația botului."
      ).catch((err) => logger.warn("[notifyBot] Nu am putut răspunde chatului neautorizat:", err.message));
      return;
    }

    const command = message.text?.trim().split(/\s+/)[0]?.split("@")[0];
    if (command === "/start" || command === "/help") {
      await bot.sendMessage(message.chat.id, "Trimite-mi linkul complet al unei știri. O voi procesa și îți voi confirma aici dacă a fost filtrată sau dacă necesită aprobare.");
      return;
    }

    if (!link) {
      await bot.sendMessage(message.chat.id, "Am primit mesajul, dar nu am găsit un link http:// sau https://. Trimite URL-ul direct sau ca text-link/caption.", {
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      }).catch((err) => logger.warn("[notifyBot] Nu am putut confirma mesajul fără link:", err.message));
      return;
    }

    logger.log("[notifyBot] Link primit din chatul privat configurat; încep procesarea.");
    let acknowledgement;
    try {
      acknowledgement = await bot.sendMessage(message.chat.id, "⏳ Am primit linkul; îl verific și îl procesez acum…", {
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
      const result = await enqueue(() => processUrl(link, { bypassSimilarity: true, forceManual: true }));
      const response = result?.status === "done"
        ? "✅ Gata — ți-am trimis rezultatul mai sus în chat."
        : result?.status === "pending"
          ? "⏭️ Am găsit o posibilă similaritate. Uită-te la mesajul cu butoane de aprobare; cererea rămâne salvată și după restart."
          : result?.status === "error"
            ? `❌ Nu am putut procesa linkul: ${result.reason}`
            : `ℹ️ Linkul a fost primit, dar nu a fost procesat: ${result?.reason || "motiv necunoscut"}`;
      await bot.editMessageText(response, { chat_id: message.chat.id, message_id: acknowledgement.message_id });
    } catch (err) {
      logger.error("[notifyBot manual-link error]", err);
      if (acknowledgement) {
        await bot.editMessageText(`❌ Eroare la procesarea linkului: ${err.message}`, {
          chat_id: message.chat.id,
          message_id: acknowledgement.message_id,
        }).catch(() => {});
      }
    }
  };
}
