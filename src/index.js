import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { getConfig, HEARTBEAT_FILE, loadDotEnv } from "./config.js";
import { ensureChangelog, normalizeChangelog } from "./changelog.js";
import { cancelActiveCodexRuns, runCodex } from "./codex.js";
import { getUpdates, sendMessage } from "./telegram.js";
import { parseControlCommand } from "./commands.js";
import { getRuntimeSettings, updateRuntimeSettings } from "./runtime-store.js";
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

const KNOWN_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2"
];

let currentModel = config.codexModel || "";
let concurrencyMode = "interrupt";
let defaultStatusMode = "periodic";
let defaultStatusEveryMinutes = 10;

let isProcessing = false;
const queuedPrompts = [];
let latestInterruptPrompt = null;
let activePrimaryPromptText = "";

const heartbeat = {
  active: false,
  awaitingConfirmation: null,
  pendingStart: null,
  chatId: "",
  startedAt: 0,
  stopAt: 0,
  durationMinutes: 30,
  intervalMinutes: 5,
  statusEveryMinutes: 10,
  statusMode: "periodic",
  lastPingAt: 0,
  lastStatusAt: 0,
  pingTimer: null,
  statusTimer: null,
  stopTimer: null,
  stopReason: "",
  taskText: "",
  workRuns: 0,
  lastWorkSummary: "",
  lastWorkAt: 0
};

const HEARTBEAT_BASE_CONTENT = [
  "# Heartbeat",
  "",
  "Tracks heartbeat lifecycle for long-running Telegram-driven tasks.",
  "",
  "- This file is append-only during runtime.",
  "- Entries use ISO timestamp format.",
  "- Pings are logged every 5 minutes while heartbeat is active.",
  ""
].join("\n");

function shortSummary(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 10).join(" ") || "general chat";
}

function chatAllowed(chatId) {
  return !config.allowedChatId || String(chatId) === String(config.allowedChatId);
}

function nowStamp() {
  return new Date().toISOString();
}

function cleanModelName(model) {
  return String(model || "").trim().replace(/^['"]|['"]$/g, "");
}

function shouldUseSubagents(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("subagent") || lower.includes("delegate") || lower.includes("parallel agents")) {
    return true;
  }
  const longTask = text.length > 300;
  const bigTaskSignals = ["refactor", "multi-step", "production", "migrate", "full workflow", "end-to-end", "comprehensive"];
  return longTask || bigTaskSignals.some((signal) => lower.includes(signal));
}

function extractControlSignals(rawOutput) {
  const lines = String(rawOutput || "").split(/\r?\n/);
  let subagentsUsed = false;
  let limitWarning = "";
  const cleaned = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[SUBAGENTS\]\s+used$/i.test(trimmed)) {
      subagentsUsed = true;
      continue;
    }
    if (/^\[SUBAGENTS\]\s+none$/i.test(trimmed)) {
      continue;
    }
    if (/^\[LIMIT_WARNING\]/i.test(trimmed)) {
      limitWarning = trimmed.replace(/^\[LIMIT_WARNING\]\s*/i, "").trim();
      continue;
    }
    cleaned.push(line);
  }

  return {
    subagentsUsed,
    limitWarning,
    cleanedOutput: cleaned.join("\n").trim()
  };
}

function hasLimitText(value) {
  return /daily limit|usage limit|quota|rate limit/i.test(String(value || ""));
}

function tokenSet(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return new Set(words);
}

function overlapRatio(aText, bText) {
  const a = tokenSet(aText);
  const b = tokenSet(bText);
  if (!a.size || !b.size) {
    return 0;
  }
  let shared = 0;
  for (const w of a) {
    if (b.has(w)) {
      shared += 1;
    }
  }
  return shared / Math.max(a.size, b.size);
}

function shouldForkParallelWhileBusy(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(?:unrelated|different topic|another topic|new topic|separate task)\b/.test(lower)) {
    return true;
  }
  const questionLike = /[?]|\b(?:who|what|when|where|why|how)\b/.test(lower);
  const overlap = overlapRatio(text, activePrimaryPromptText);
  return questionLike && overlap < 0.08;
}

function hasPrimaryWorkInFlightOrQueued() {
  if (isProcessing && activePrimaryPromptText.trim()) {
    return true;
  }
  return queuedPrompts.some((item) => !item?.options?.fromHeartbeat);
}

function isImmediateControlCommand(commandType) {
  return [
    "heartbeat_start",
    "heartbeat_confirm",
    "heartbeat_stop",
    "heartbeat_wipe_all",
    "heartbeat_wipe_query",
    "heartbeat_status_prefs",
    "health"
  ].includes(commandType);
}

function buildHeartbeatTaskPrompt(taskText, runIndex, minsLeft) {
  const phase = runIndex === 0 ? "initial" : "continuation";
  return [
    `Heartbeat ${phase} work chunk.`,
    `Primary objective: ${taskText}`,
    `Approximate minutes left in run window: ${Math.max(0, minsLeft)}`,
    "Make concrete progress now.",
    "Start your response with [TASK_DONE] if fully complete, else [TASK_CONTINUE].",
    "Then provide a concise one-paragraph progress summary."
  ].join("\n");
}

async function appendHeartbeatEvent(message) {
  const entry = `- ${nowStamp()} | ${message}\n`;
  try {
    await fs.appendFile(HEARTBEAT_FILE, entry, "utf8");
  } catch {
    const initial = `${HEARTBEAT_BASE_CONTENT}${entry}`;
    await fs.writeFile(HEARTBEAT_FILE, initial, "utf8");
  }
}

function isHeartbeatEventLine(line) {
  return /^\s*-\s+\d{4}-\d{2}-\d{2}T/.test(String(line || ""));
}

async function readHeartbeatRaw() {
  try {
    return await fs.readFile(HEARTBEAT_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function wipeHeartbeatAll() {
  const raw = await readHeartbeatRaw();
  const removed = raw
    .split(/\r?\n/)
    .filter((line) => isHeartbeatEventLine(line))
    .length;
  await fs.writeFile(HEARTBEAT_FILE, HEARTBEAT_BASE_CONTENT, "utf8");
  return { removed };
}

async function wipeHeartbeatQuery(query) {
  const raw = await readHeartbeatRaw();
  if (!raw.trim()) {
    return { removed: 0 };
  }
  const lines = raw.split(/\r?\n/);
  const needle = query.toLowerCase();
  let removed = 0;
  const kept = lines.filter((line) => {
    if (!isHeartbeatEventLine(line)) {
      return true;
    }
    if (line.toLowerCase().includes(needle)) {
      removed += 1;
      return false;
    }
    return true;
  });

  const next = `${kept.join("\n").replace(/\n+$/g, "")}\n`;
  await fs.writeFile(HEARTBEAT_FILE, next, "utf8");
  return { removed };
}

function clearHeartbeatTimers() {
  if (heartbeat.pingTimer) {
    clearInterval(heartbeat.pingTimer);
    heartbeat.pingTimer = null;
  }
  if (heartbeat.statusTimer) {
    clearInterval(heartbeat.statusTimer);
    heartbeat.statusTimer = null;
  }
  if (heartbeat.stopTimer) {
    clearTimeout(heartbeat.stopTimer);
    heartbeat.stopTimer = null;
  }
}

function renderHeartbeatHealth() {
  if (!heartbeat.active) {
    return "Heartbeat: inactive";
  }
  const minsLeft = Math.max(0, Math.ceil((heartbeat.stopAt - Date.now()) / 60000));
  return [
    "Heartbeat: active",
    `Duration: ${heartbeat.durationMinutes}m`,
    `Ping every: ${heartbeat.intervalMinutes}m`,
    `Status mode: ${heartbeat.statusMode === "end" ? "one-at-end" : `every ${heartbeat.statusEveryMinutes}m`}`,
    `Task: ${heartbeat.taskText || "none"}`,
    `Latest progress: ${heartbeat.lastWorkSummary || "none yet"}`,
    `Last ping: ${heartbeat.lastPingAt ? new Date(heartbeat.lastPingAt).toISOString() : "none"}`,
    `Minutes left: ${minsLeft}`
  ].join("\n");
}

async function stopHeartbeat(reason, notify = true, chatId = "") {
  if (!heartbeat.active) {
    return;
  }

  clearHeartbeatTimers();
  heartbeat.active = false;
  heartbeat.stopReason = reason;
  await appendHeartbeatEvent(`STOP | ${reason}`);

  const targetChat = chatId || heartbeat.chatId;
  if (!targetChat || !notify) {
    return;
  }

  if (heartbeat.statusMode === "end") {
    await sendMessage(
      config.telegramToken,
      targetChat,
      `Heartbeat finished: ${reason}. Elapsed ${Math.max(1, Math.round((Date.now() - heartbeat.startedAt) / 60000))}m. Latest progress: ${heartbeat.lastWorkSummary || "none recorded"}.`
    );
    return;
  }

  await sendMessage(
    config.telegramToken,
    targetChat,
    `Heartbeat stopped: ${reason}. Latest progress: ${heartbeat.lastWorkSummary || "none recorded"}.`
  );
}

async function startHeartbeat({ chatId, durationMinutes, statusEveryMinutes, statusMode, taskText }) {
  clearHeartbeatTimers();

  heartbeat.active = true;
  heartbeat.chatId = chatId;
  heartbeat.intervalMinutes = 5;
  heartbeat.durationMinutes = Math.max(1, Number.parseInt(durationMinutes, 10) || 30);
  heartbeat.statusEveryMinutes = Math.max(1, Number.parseInt(statusEveryMinutes, 10) || defaultStatusEveryMinutes);
  heartbeat.statusMode = statusMode === "end" ? "end" : "periodic";
  heartbeat.startedAt = Date.now();
  heartbeat.stopAt = heartbeat.startedAt + heartbeat.durationMinutes * 60 * 1000;
  heartbeat.lastPingAt = 0;
  heartbeat.lastStatusAt = 0;
  heartbeat.stopReason = "";
  heartbeat.taskText = String(taskText || "").trim();
  heartbeat.workRuns = 0;
  heartbeat.lastWorkSummary = "";
  heartbeat.lastWorkAt = 0;

  await appendHeartbeatEvent(
    `START | duration=${heartbeat.durationMinutes}m | ping=5m | status=${heartbeat.statusMode === "end" ? "end" : `${heartbeat.statusEveryMinutes}m`}`
  );

  heartbeat.pingTimer = setInterval(async () => {
    heartbeat.lastPingAt = Date.now();
    await appendHeartbeatEvent("PING | Continue active task and keep context warm.");
    if (heartbeat.active && heartbeat.taskText) {
      const minsLeft = Math.ceil((heartbeat.stopAt - Date.now()) / 60000);
      const workPrompt = buildHeartbeatTaskPrompt(heartbeat.taskText, heartbeat.workRuns, minsLeft);
      enqueuePrompt(workPrompt, chatId, { fromHeartbeat: true, silentQueueNote: true }).catch((error) => {
        console.error(error);
      });
    }
  }, heartbeat.intervalMinutes * 60 * 1000);

  if (heartbeat.statusMode === "periodic") {
    heartbeat.statusTimer = setInterval(async () => {
      heartbeat.lastStatusAt = Date.now();
      const minsLeft = Math.max(0, Math.ceil((heartbeat.stopAt - Date.now()) / 60000));
      const progress = heartbeat.lastWorkSummary || "working, no summary yet";
      await sendMessage(config.telegramToken, chatId, `Heartbeat status: active, ${minsLeft}m left. Progress: ${progress}`);
    }, heartbeat.statusEveryMinutes * 60 * 1000);
  }

  heartbeat.stopTimer = setTimeout(async () => {
    await stopHeartbeat("time limit reached", true, chatId);
  }, heartbeat.durationMinutes * 60 * 1000);

  await sendMessage(
    config.telegramToken,
    chatId,
    `Heartbeat started for ${heartbeat.durationMinutes}m. Ping every 5m. ${heartbeat.statusMode === "end" ? "One status at end." : `Status every ${heartbeat.statusEveryMinutes}m.`}${heartbeat.taskText ? ` Working on: ${heartbeat.taskText}` : ""}`
  );

  if (heartbeat.taskText) {
    const initialPrompt = buildHeartbeatTaskPrompt(heartbeat.taskText, heartbeat.workRuns, heartbeat.durationMinutes);
    enqueuePrompt(initialPrompt, chatId, { fromHeartbeat: true, silentQueueNote: true }).catch((error) => {
      console.error(error);
    });
  }
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

function resolveSessionTarget(sessions, targetText, activeSessionId, allowRecentFallback = false) {
  const query = String(targetText || "").trim().toLowerCase();
  const wantsRecent =
    !query ||
    query === "session" ||
    /^(?:the\s+)?(?:previous|last|latest|most\s+recent|recent)(?:\s+(?:session|chat))?$/.test(query);

  if (allowRecentFallback && wantsRecent) {
    if (!sessions.length) {
      return null;
    }
    if (!activeSessionId) {
      return sessions[0];
    }
    return sessions.find((s) => s.id !== activeSessionId) || sessions.find((s) => s.id === activeSessionId) || null;
  }

  return findSessionByIdOrSummary(sessions, targetText);
}

async function createNewSession(chatId, summary, model, forceSubagents = false) {
  const bootstrap = await runCodex({
    userText: "Start a fresh chat session. Reply in one short line.",
    sessionId: "",
    createNewSession: true,
    contextText: "",
    codexBin: config.codexBin,
    codexModel: model,
    codexSandbox: config.codexSandbox,
    codexAskForApproval: config.codexAskForApproval,
    codexEphemeral: config.codexEphemeral,
    codexBypassSandbox: config.codexBypassSandbox,
    forceSubagents
  });

  if (!bootstrap.threadId) {
    await setActiveSession("");
    await sendMessage(config.telegramToken, chatId, "Could not create a new session right now. Please try again.");
    return null;
  }

  const nextSummary = shortSummary(summary || "new chat");
  await ensureSessionRecord(bootstrap.threadId, nextSummary);
  await setActiveSession(bootstrap.threadId);
  await updateSessionSummary(bootstrap.threadId, nextSummary);
  await appendUserMemory(bootstrap.threadId, `Started new chat: ${nextSummary}`);
  await sendMessage(config.telegramToken, chatId, `Started new session ${bootstrap.threadId} using model ${model || "default"}.`);
  return bootstrap.threadId;
}

async function handleControlCommand(command, text, chatId) {
  if (command.type === "list_sessions") {
    const sessions = await listSessions();
    const active = await getActiveSession();
    await sendMessage(config.telegramToken, chatId, renderSessions(sessions, active));
    return true;
  }

  if (command.type === "hard_interrupt") {
    const cancelled = cancelActiveCodexRuns();
    queuedPrompts.length = 0;
    latestInterruptPrompt = null;
    heartbeat.awaitingConfirmation = null;
    heartbeat.pendingStart = null;
    if (heartbeat.active) {
      await stopHeartbeat("stopped by user", false, chatId);
    }
    await sendMessage(
      config.telegramToken,
      chatId,
      `Stopped active work. Cancelled runs: ${cancelled}. Queued prompts cleared.`
    );
    return true;
  }

  if (command.type === "end_all_sessions") {
    const cancelled = cancelActiveCodexRuns();
    queuedPrompts.length = 0;
    latestInterruptPrompt = null;
    heartbeat.awaitingConfirmation = null;
    heartbeat.pendingStart = null;
    if (heartbeat.active) {
      await stopHeartbeat("ended all sessions", false, chatId);
    }
    const sessions = await listSessions();
    for (const s of sessions) {
      await endSession(s.id);
      await terminateSessionTerminal(s.id);
    }
    await setActiveSession("");
    await sendMessage(
      config.telegramToken,
      chatId,
      `Ended all sessions (${sessions.length}) and cancelled ${cancelled} active run(s).`
    );
    return true;
  }

  if (command.type === "end_other_sessions") {
    const cancelled = cancelActiveCodexRuns();
    queuedPrompts.length = 0;
    latestInterruptPrompt = null;
    heartbeat.awaitingConfirmation = null;
    heartbeat.pendingStart = null;
    if (heartbeat.active) {
      await stopHeartbeat("ended other sessions", false, chatId);
    }
    const sessions = await listSessions();
    const active = await getActiveSession();
    const targets = active ? sessions.filter((s) => s.id !== active) : sessions;
    for (const s of targets) {
      await endSession(s.id);
      await terminateSessionTerminal(s.id);
    }
    await sendMessage(
      config.telegramToken,
      chatId,
      `Ended other sessions (${targets.length})${active ? `. Kept active: ${active}.` : "."} Cancelled ${cancelled} active run(s).`
    );
    return true;
  }

  if (command.type === "models_show") {
    const lines = [
      `Current model: ${currentModel || "default"}`,
      "Known models:",
      ...KNOWN_MODELS.map((m) => `- ${m}`),
      "",
      "Usage:",
      "- /models set <model>",
      "- /models new <model>"
    ];
    await sendMessage(config.telegramToken, chatId, lines.join("\n"));
    return true;
  }

  if (command.type === "model_set") {
    const model = cleanModelName(command.model);
    if (!model) {
      await sendMessage(config.telegramToken, chatId, "Provide a model. Example: /models set gpt-5.4");
      return true;
    }
    currentModel = model;
    await updateRuntimeSettings({ preferredModel: model });
    await sendMessage(config.telegramToken, chatId, `Model updated to ${model} for this chat.`);
    return true;
  }

  if (command.type === "model_new_session") {
    const model = cleanModelName(command.model);
    if (!model) {
      await sendMessage(config.telegramToken, chatId, "Provide a model. Example: /models new gpt-5.4");
      return true;
    }
    currentModel = model;
    await updateRuntimeSettings({ preferredModel: model });
    await createNewSession(chatId, `new chat on ${model}`, model, false);
    return true;
  }

  if (command.type === "health") {
    const status = [
      renderHeartbeatHealth(),
      `Model: ${currentModel || "default"}`,
      `Concurrency: ${concurrencyMode}`,
      `Processing: ${isProcessing ? "yes" : "no"}`,
      `Queued messages: ${queuedPrompts.length}${latestInterruptPrompt ? " (+1 interrupt)" : ""}`
    ].join("\n");
    await sendMessage(config.telegramToken, chatId, status);
    return true;
  }

  if (command.type === "heartbeat_status_prefs") {
    defaultStatusMode = command.statusMode === "end" ? "end" : "periodic";
    if (defaultStatusMode === "periodic") {
      defaultStatusEveryMinutes = Math.max(1, Number.parseInt(command.statusEveryMinutes, 10) || defaultStatusEveryMinutes);
    }
    await updateRuntimeSettings({
      statusMode: defaultStatusMode,
      statusEveryMinutes: defaultStatusEveryMinutes
    });
    const msg = defaultStatusMode === "end"
      ? "Status preference saved: one update at the end."
      : `Status preference saved: every ${defaultStatusEveryMinutes} minutes.`;
    await sendMessage(config.telegramToken, chatId, msg);
    return true;
  }

  if (command.type === "heartbeat_start") {
    if (heartbeat.awaitingConfirmation && /^\/heartbeat\s*$/i.test(String(text || "").trim())) {
      const pending = heartbeat.awaitingConfirmation;
      await sendMessage(
        config.telegramToken,
        chatId,
        `Heartbeat start is already pending for ${pending.durationMinutes}m. Reply /heartbeat confirm.`
      );
      return true;
    }

    const contextTaskText = String(command.contextTaskText || "").trim();
    if (contextTaskText) {
      enqueuePrompt(contextTaskText, chatId, { silentQueueNote: true }).catch((error) => {
        console.error(error);
      });
    }

    heartbeat.awaitingConfirmation = {
      chatId,
      durationMinutes: Math.max(1, Number.parseInt(command.durationMinutes, 10) || 30),
      statusMode: command.statusMode || defaultStatusMode,
      statusEveryMinutes: Math.max(1, Number.parseInt(command.statusEveryMinutes, 10) || defaultStatusEveryMinutes),
      taskText: String(command.taskText || "").trim()
    };
    const taskSuffix = heartbeat.awaitingConfirmation.taskText ? ` and work on: ${heartbeat.awaitingConfirmation.taskText}` : "";
    await sendMessage(
      config.telegramToken,
      chatId,
      `Confirm heartbeat start for ${heartbeat.awaitingConfirmation.durationMinutes}m${taskSuffix}? Reply /heartbeat confirm.`
    );
    return true;
  }

  if (command.type === "heartbeat_confirm" || (command.type === "confirm" && heartbeat.awaitingConfirmation)) {
    if (!heartbeat.awaitingConfirmation) {
      await sendMessage(config.telegramToken, chatId, "No heartbeat start request pending.");
      return true;
    }
    const pending = heartbeat.awaitingConfirmation;
    heartbeat.awaitingConfirmation = null;
    if (!hasPrimaryWorkInFlightOrQueued()) {
      heartbeat.pendingStart = pending;
      await sendMessage(
        config.telegramToken,
        chatId,
        `Heartbeat armed for ${pending.durationMinutes}m. It will start automatically when the next project task starts.`
      );
      return true;
    }

    await startHeartbeat({
      chatId: pending.chatId,
      durationMinutes: pending.durationMinutes,
      statusEveryMinutes: pending.statusEveryMinutes,
      statusMode: pending.statusMode,
      taskText: pending.taskText || activePrimaryPromptText
    });
    return true;
  }

  if (command.type === "heartbeat_stop") {
    heartbeat.awaitingConfirmation = null;
    if (heartbeat.pendingStart) {
      heartbeat.pendingStart = null;
      await sendMessage(config.telegramToken, chatId, "Cancelled pending heartbeat start.");
      return true;
    }
    if (!heartbeat.active) {
      await sendMessage(config.telegramToken, chatId, "No active heartbeat right now.");
      return true;
    }
    await stopHeartbeat("manually terminated", true, chatId);
    return true;
  }

  if (command.type === "heartbeat_wipe_all") {
    const res = await wipeHeartbeatAll();
    await sendMessage(config.telegramToken, chatId, `Heartbeat log wiped. Removed ${res.removed} event(s).`);
    return true;
  }

  if (command.type === "heartbeat_wipe_query") {
    const query = String(command.query || "").trim();
    if (!query) {
      await sendMessage(config.telegramToken, chatId, "Provide text to remove. Example: /heartbeat wipe STOP");
      return true;
    }
    const res = await wipeHeartbeatQuery(query);
    await sendMessage(config.telegramToken, chatId, `Heartbeat entries matching '${query}' removed: ${res.removed}.`);
    return true;
  }

  if (command.type === "concurrency_set") {
    const mode = String(command.mode || "").toLowerCase();
    if (!["queue", "interrupt", "parallel"].includes(mode)) {
      await sendMessage(config.telegramToken, chatId, "Use /concurrency queue|interrupt|parallel");
      return true;
    }
    concurrencyMode = mode;
    await updateRuntimeSettings({ concurrencyMode: mode });
    await sendMessage(config.telegramToken, chatId, `Concurrency mode set to ${mode}.`);
    return true;
  }

  if (command.type === "new_session") {
    await createNewSession(chatId, command.summary || "new chat", currentModel, false);
    return true;
  }

  if (command.type === "switch_session" || command.type === "resume_session") {
    const sessions = await listSessions();
    const active = await getActiveSession();
    const target = resolveSessionTarget(
      sessions,
      command.target,
      active,
      command.type === "resume_session"
    );
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
    const cancelled = cancelActiveCodexRuns();
    queuedPrompts.length = 0;
    latestInterruptPrompt = null;
    heartbeat.awaitingConfirmation = null;
    heartbeat.pendingStart = null;
    if (heartbeat.active) {
      await stopHeartbeat("memory/session wipe", false, chatId);
    }
    const sessions = await listSessions();
    for (const s of sessions) {
      await endSession(s.id);
      await terminateSessionTerminal(s.id);
    }
    await pruneMemory({ mode: "all" });
    await setActiveSession("");
    await sendMessage(
      config.telegramToken,
      chatId,
      `Wiped all sessions and memory. Ended ${sessions.length} session(s) and cancelled ${cancelled} active run(s).`
    );
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

async function handlePrompt(text, chatId, options = {}) {
  if (!options.fromHeartbeat) {
    const command = parseControlCommand(text);
    if (await handleControlCommand(command, text, chatId)) {
      return;
    }
  }

  const activeBefore = await getActiveSession();
  const forceNewSession = options.forceNewSession === true;
  const preserveActiveSession = options.preserveActiveSession === true;

  let sessionId = activeBefore;
  let createNewSession = false;

  if (forceNewSession || !sessionId) {
    createNewSession = true;
    sessionId = "pending";
  }

  const forceSubagents = shouldUseSubagents(text);
  if (forceSubagents && !options.fromHeartbeat) {
    await sendMessage(config.telegramToken, chatId, "Subagents planned for this task.");
  }

  const contextText = createNewSession ? "" : await readSessionMemory(sessionId);
  const result = await runCodex({
    userText: text,
    sessionId: createNewSession ? "" : sessionId,
    createNewSession,
    contextText,
    codexBin: config.codexBin,
    codexModel: currentModel,
    codexSandbox: config.codexSandbox,
    codexAskForApproval: config.codexAskForApproval,
    codexEphemeral: config.codexEphemeral,
    codexBypassSandbox: config.codexBypassSandbox,
    forceSubagents
  });

  const signals = extractControlSignals(result.output);
  const resolvedSessionId = result.threadId || (createNewSession ? "" : sessionId);

  if (resolvedSessionId) {
    await ensureSessionRecord(resolvedSessionId, shortSummary(text));
    if (!preserveActiveSession) {
      await setActiveSession(resolvedSessionId);
    }
    await updateSessionSummary(resolvedSessionId, shortSummary(text));
    await appendUserMemory(resolvedSessionId, text);
    if (options.openTerminal) {
      await openResumeTerminal(resolvedSessionId);
    }
  }

  if (signals.subagentsUsed && !options.fromHeartbeat) {
    await sendMessage(config.telegramToken, chatId, "Subagents were used for this task.");
  }

  if ((signals.limitWarning || hasLimitText(result.stderr) || hasLimitText(result.output)) && !options.fromHeartbeat) {
    const detail = signals.limitWarning || "Codex usage appears close to a limit.";
    await sendMessage(config.telegramToken, chatId, `Limit warning: ${detail}`);
  }

  const replyPrefixParts = [];
  if (resolvedSessionId) {
    replyPrefixParts.push(`[session ${resolvedSessionId}]`);
  }
  if (options.forceNewSession) {
    replyPrefixParts.push("[parallel]");
  }
  const replyPrefix = replyPrefixParts.length ? `${replyPrefixParts.join(" ")}\n` : "";
  const replyBodyBase = result.ok ? (signals.cleanedOutput || result.output) : `Codex exec failed.\n\n${result.output}`;
  const replyBody = replyBodyBase || "Codex returned no output.";
  const reply = `${replyPrefix}${replyBody}`;

  if (options.fromHeartbeat) {
    heartbeat.workRuns += 1;
    heartbeat.lastWorkAt = Date.now();
    const rawSummary = replyBody.replace(/^\[(?:TASK_DONE|TASK_CONTINUE)\]\s*/i, "").trim();
    heartbeat.lastWorkSummary = shortSummary(rawSummary);
    await appendHeartbeatEvent(`WORK | ${heartbeat.lastWorkSummary}`);
    if (/^\[TASK_DONE\]/i.test(replyBody.trim())) {
      await stopHeartbeat("project task completed", true, chatId);
    }
  } else if (chatId) {
    await sendMessage(config.telegramToken, chatId, reply);
  }

  if (heartbeat.active && !options.fromHeartbeat && !heartbeat.taskText) {
    await stopHeartbeat("task completed", true, chatId);
  }

  if (preserveActiveSession && activeBefore) {
    await setActiveSession(activeBefore);
  }
}

async function processNextPrompt() {
  if (isProcessing) {
    return;
  }

  let next = null;
  if (latestInterruptPrompt) {
    next = latestInterruptPrompt;
    latestInterruptPrompt = null;
    queuedPrompts.length = 0;
  } else if (queuedPrompts.length) {
    next = queuedPrompts.shift();
  }

  if (!next) {
    return;
  }

  isProcessing = true;
  try {
    if (!next?.options?.fromHeartbeat) {
      activePrimaryPromptText = String(next.text || "");
      if (heartbeat.pendingStart && !heartbeat.active) {
        const pending = heartbeat.pendingStart;
        heartbeat.pendingStart = null;
        await startHeartbeat({
          chatId: pending.chatId || next.chatId,
          durationMinutes: pending.durationMinutes,
          statusEveryMinutes: pending.statusEveryMinutes,
          statusMode: pending.statusMode,
          taskText: pending.taskText || activePrimaryPromptText
        });
      }
    }
    await handlePrompt(next.text, next.chatId, next.options || {});
  } catch (error) {
    console.error(error);
    await sendMessage(config.telegramToken, next.chatId, `Request failed: ${error.message}`);
  } finally {
    isProcessing = false;
    if (!queuedPrompts.length && !latestInterruptPrompt) {
      activePrimaryPromptText = "";
    }
    processNextPrompt().catch((error) => console.error(error));
  }
}

async function enqueuePrompt(text, chatId, options = {}) {
  if (!isProcessing && queuedPrompts.length === 0 && !latestInterruptPrompt) {
    queuedPrompts.push({ text, chatId, options });
    await processNextPrompt();
    return;
  }

  if (concurrencyMode === "queue") {
    queuedPrompts.push({ text, chatId, options });
    if (!options.silentQueueNote) {
      await sendMessage(config.telegramToken, chatId, "Queued. I will process this after the current task.");
    }
    return;
  }

  if (concurrencyMode === "interrupt") {
    if (shouldForkParallelWhileBusy(text)) {
      const wantsTerminal = /\bopen terminal\b/i.test(text);
      if (!options.silentQueueNote) {
        await sendMessage(config.telegramToken, chatId, "Parallel session opened for unrelated request.");
      }
      handlePrompt(text, chatId, {
        forceNewSession: true,
        preserveActiveSession: true,
        openTerminal: wantsTerminal,
        ...options
      }).catch((error) => {
        console.error(error);
        sendMessage(config.telegramToken, chatId, `Parallel request failed: ${error.message}`).catch(() => {});
      });
      return;
    }
    queuedPrompts.push({ text, chatId, options });
    if (!options.silentQueueNote) {
      await sendMessage(config.telegramToken, chatId, "Current project still running. I queued this in the same flow.");
    }
    return;
  }

  if (concurrencyMode === "parallel") {
    sendMessage(config.telegramToken, chatId, "Parallel mode: starting a separate session for this request.").catch(() => {});
    handlePrompt(text, chatId, {
      forceNewSession: true,
      preserveActiveSession: true,
      ...options
    }).catch((error) => {
      console.error(error);
      sendMessage(config.telegramToken, chatId, `Parallel request failed: ${error.message}`).catch(() => {});
    });
  }
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
            "Hi Srishti. I am max codestappen. Commands: /new, /sessions, /switch <id>, /resume <id|summary>, /models, /heartbeat, /heartbeat wipe, /health, /end, /end all, /wipe, /undo"
          );
          continue;
        }

        if (!chatAllowed(chatId)) {
          await sendMessage(config.telegramToken, chatId, "This bot is restricted to the configured chat.");
          continue;
        }

        await sendMessage(config.telegramToken, chatId, Math.random() < 0.5 ? "working" : "thinking");

        const command = parseControlCommand(text);
        if (isImmediateControlCommand(command.type)) {
          if (await handleControlCommand(command, text, chatId)) {
            continue;
          }
        }

        enqueuePrompt(text, chatId).catch((error) => {
          console.error(error);
          sendMessage(config.telegramToken, chatId, `Queueing failed: ${error.message}`).catch(() => {});
        });
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

  const settings = await getRuntimeSettings();
  if (settings.preferredModel) {
    currentModel = settings.preferredModel;
  }
  concurrencyMode = settings.concurrencyMode;
  defaultStatusMode = settings.statusMode;
  defaultStatusEveryMinutes = settings.statusEveryMinutes;

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
