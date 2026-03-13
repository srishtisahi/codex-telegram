import { getConfig, loadDotEnv } from "./config.js";
import { ensureChangelog, normalizeChangelog } from "./changelog.js";
import { runCodex } from "./codex.js";
import { getUpdates, sendMessage } from "./telegram.js";

loadDotEnv();
const config = getConfig();
let queue = Promise.resolve();

async function handlePrompt(text, chatId) {
  const result = await runCodex({
    userText: text,
    codexBin: config.codexBin,
    codexModel: config.codexModel
  });
  const reply = result.ok ? result.output : `Codex exec failed.\n\n${result.output}`;
  if (chatId) {
    await sendMessage(config.telegramToken, chatId, reply);
  }
  return { ok: result.ok, reply };
}

function enqueuePrompt(text, chatId) {
  const run = queue.then(() => handlePrompt(text, chatId));
  queue = run.catch(() => {});
  return run;
}

function chatAllowed(chatId) {
  return !config.allowedChatId || String(chatId) === String(config.allowedChatId);
}

async function startTelegramLoop() {
  let offset = 0;
  while (true) {
    try {
      const updates = await getUpdates(config.telegramToken, offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        const text = message?.text?.trim();
        const chatId = message?.chat?.id;

        if (!text || !chatId) {
          continue;
        }

        if (text === "/chatid") {
          await sendMessage(config.telegramToken, chatId, `Chat ID: ${chatId}`);
          continue;
        }

        if (text === "/start") {
          await sendMessage(
            config.telegramToken,
            chatId,
            "Send any message to run a fresh codex exec in this folder. Use /chatid to see your Telegram chat id."
          );
          continue;
        }

        if (!chatAllowed(chatId)) {
          await sendMessage(config.telegramToken, chatId, "This bot is restricted to the configured chat.");
          continue;
        }

        await enqueuePrompt(text, chatId);
      }
    } catch (error) {
      const note = `Telegram loop error: ${error.message}`;
      console.error(note);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  await ensureChangelog();
  await normalizeChangelog();

  console.log("Telegram-only bridge started.");

  startTelegramLoop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
