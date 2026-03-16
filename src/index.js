import { spawn } from "node:child_process";
import { getConfig, loadDotEnv } from "./config.js";
import { ensureChangelog, normalizeChangelog } from "./changelog.js";
import { runCodex } from "./codex.js";
import { getUpdates, sendMessage } from "./telegram.js";
import { parseControlCommand } from "./commands.js";
import {
  appendUserMemory,
  endSession,
  ensureSessionRecord,
  findSessionByIdOrSummary,
  getActiveSession,
  listSessions,
  pruneMemory,
  readSessionMemory,
  setActiveSession,
  undoLastMemoryWipe,
  updateSessionSummary
} from "./session-store.js";

loadDotEnv();
const config = getConfig();
let queue = Promise.resolve();

function shortSummary(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 10).join(" ") || "general chat";
}

function chatAllowed(chatId) {
  return !config.allowedChatId || String(chatId) === String(config.allowedChatId);
}

async function openResumeTerminal(sessionId) {
  if (!sessionId) {
    return;
  }
  const child = spawn("./start-bridge.sh", ["open-session", sessionId], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true
  });
  child.unref();
}

async function terminateSessionTerminal(sessionId) {
  if (!sessionId) {
    return;
  }
  await new Promise((resolve) => {
    const child = spawn("./start-bridge.sh", ["end-session", sessionId], {
      cwd: process.cwd(),
      stdio: "ignore"
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function renderSessions(sessions, activeSessionId) {
  if (!sessions.length) {
    return "No saved sessions yet.";
  }
  const lines = sessions.map((s, idx) => {
    const active = s.id === activeSessionId ? " (active)" : "";
    const ended = s.endedAt ? " [ended]" : "";
    return `${idx + 1}. ${s.id}${active}${ended} | ${s.summary || "general chat"}`;
  });
  return lines.join("\n");
}

async function handleControlCommand(command, text, chatId) {
  if (command.type === "list_sessions") {
    const sessions = await listSessions();
    const active = await getActiveSession();
    await sendMessage(config.telegramToken, chatId, renderSessions(sessions, active));
    return true;
  }

  if (command.type === "new_session") {
    const bootstrap = await runCodex({
      userText: "Start a fresh chat session. Reply in one short line.",
      sessionId: "",
      createNewSession: true,
      contextText: "",
      codexBin: config.codexBin,
      codexModel: config.codexModel,
      codexSandbox: config.codexSandbox,
      codexAskForApproval: config.codexAskForApproval,
      codexEphemeral: config.codexEphemeral
    });

    if (!bootstrap.threadId) {
      await setActiveSession("");
      await sendMessage(
        config.telegramToken,
        chatId,
        "Could not create a new session right now. Please try again."
      );
      return true;
    }

    const summary = shortSummary(command.summary || "new chat");
    await ensureSessionRecord(bootstrap.threadId, summary);
    await setActiveSession(bootstrap.threadId);
    await updateSessionSummary(bootstrap.threadId, summary);
    await appendUserMemory(bootstrap.threadId, `Started new chat: ${summary}`);
    const note = `Started new session ${bootstrap.threadId}.`;
    await sendMessage(config.telegramToken, chatId, note);
    return true;
  }

  if (command.type === "switch_session" || command.type === "resume_session") {
    const sessions = await listSessions();
    const target = findSessionByIdOrSummary(sessions, command.target);
    if (!target) {
      await sendMessage(config.telegramToken, chatId, "Session not found. Use /sessions to view available sessions.");
      return true;
    }
    await setActiveSession(target.id);
    if (/\bopen terminal\b/i.test(text) || /\bterminal\b/i.test(text)) {
      await openResumeTerminal(target.id);
    }
    await sendMessage(config.telegramToken, chatId, `Switched to session ${target.id}.`);
    return true;
  }

  if (command.type === "end_session") {
    const active = await getActiveSession();
    if (!active) {
      await sendMessage(config.telegramToken, chatId, "No active session to end.");
      return true;
    }
    await endSession(active);
    await terminateSessionTerminal(active);
    await sendMessage(config.telegramToken, chatId, `Ended session ${active}.`);
    return true;
  }

  if (command.type === "wipe_memory_all") {
    await pruneMemory({ mode: "all" });
    await sendMessage(config.telegramToken, chatId, "Memory wiped: all saved session memory removed.");
    return true;
  }

  if (command.type === "wipe_memory_irrelevant") {
    const res = await pruneMemory({ mode: "irrelevant" });
    await sendMessage(config.telegramToken, chatId, `Irrelevant memory removed from ${res.changedFiles || 0} session file(s).`);
    return true;
  }

  if (command.type === "wipe_memory_query") {
    const query = command.query.trim();
    if (!query) {
      await sendMessage(config.telegramToken, chatId, "Provide text to remove. Example: /wipe landing page");
      return true;
    }
    const res = await pruneMemory({ mode: "query", query });
    await sendMessage(config.telegramToken, chatId, `Removed memory entries matching '${query}' in ${res.changedFiles || 0} session file(s).`);
    return true;
  }

  if (command.type === "undo_memory_wipe") {
    const res = await undoLastMemoryWipe();
    if (!res.restored) {
      await sendMessage(config.telegramToken, chatId, "No recent memory wipe to undo.");
      return true;
    }
    await sendMessage(config.telegramToken, chatId, "Restored memory from the most recent wipe.");
    return true;
  }

  return false;
}

async function handlePrompt(text, chatId) {
  const command = parseControlCommand(text);
  if (await handleControlCommand(command, text, chatId)) {
    return;
  }

  let sessionId = await getActiveSession();
  let createNewSession = false;

  if (!sessionId) {
    createNewSession = true;
    sessionId = "pending";
  }

  const contextText = createNewSession ? "" : await readSessionMemory(sessionId);
  const result = await runCodex({
    userText: text,
    sessionId: createNewSession ? "" : sessionId,
    createNewSession,
    contextText,
    codexBin: config.codexBin,
    codexModel: config.codexModel,
    codexSandbox: config.codexSandbox,
    codexAskForApproval: config.codexAskForApproval,
    codexEphemeral: config.codexEphemeral
  });

  const resolvedSessionId = result.threadId || (createNewSession ? "" : sessionId);
  if (resolvedSessionId) {
    await ensureSessionRecord(resolvedSessionId, shortSummary(text));
    await setActiveSession(resolvedSessionId);
    await updateSessionSummary(resolvedSessionId, shortSummary(text));
    await appendUserMemory(resolvedSessionId, text);
  }

  const replyPrefix = resolvedSessionId ? `[session ${resolvedSessionId}]\n` : "";
  const replyBody = result.ok ? result.output : `Codex exec failed.\n\n${result.output}`;
  const reply = `${replyPrefix}${replyBody}`;

  if (chatId) {
    await sendMessage(config.telegramToken, chatId, reply);
  }
}

function enqueuePrompt(text, chatId) {
  const run = queue.then(() => handlePrompt(text, chatId));
  queue = run.catch(() => {});
  return queue;
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
            "Hi Srishti. Send a message to chat with Codex. Commands: /new, /sessions, /switch <id>, /resume <id|summary>, /end, /wipe, /undo"
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
