const TELEGRAM_API = "https://api.telegram.org";

export async function telegramRequest(token, method, body) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Telegram ${method} failed with ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram ${method} error: ${payload.description || "unknown error"}`);
  }
  return payload.result;
}

export async function getUpdates(token, offset) {
  return telegramRequest(token, "getUpdates", {
    offset,
    timeout: 45,
    allowed_updates: ["message"]
  });
}

export async function sendMessage(token, chatId, text) {
  const chunks = chunkText(text, 3900);
  for (const chunk of chunks) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: chunk
    });
  }
}

function chunkText(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf("\n", maxLength);
    if (split < 1) {
      split = maxLength;
    }
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
