import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./config.js";

const MEMORY_DIR = path.join(ROOT_DIR, "memory");
const SESSIONS_DIR = path.join(MEMORY_DIR, "sessions");
const STATE_FILE = path.join(MEMORY_DIR, "state.json");
const SESSION_LIST_FILE = path.join(ROOT_DIR, "sessionid.txt");
const MEMORY_UNDO_DIR = path.join(ROOT_DIR, ".memory-undo");
const MEMORY_UNDO_META_FILE = path.join(MEMORY_UNDO_DIR, "meta.json");
const MEMORY_UNDO_SNAPSHOT_DIR = path.join(MEMORY_UNDO_DIR, "memory");
const MEMORY_UNDO_SESSION_LIST_FILE = path.join(MEMORY_UNDO_DIR, "sessionid.txt");
const MAX_SESSIONS = 5;

function nowIso() {
  return new Date().toISOString();
}

function limitWords(text, maxWords = 10) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function normalizeSummary(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return limitWords(cleaned || "general chat");
}

function extractProjectHints(text) {
  const hints = [];
  const regex = /\b(?:project|repo|app)\s+([a-z0-9][a-z0-9._-]{1,30})/gi;
  let match = regex.exec(text);
  while (match) {
    hints.push(match[1].toLowerCase());
    match = regex.exec(text);
  }
  return [...new Set(hints)].slice(0, 10);
}

function toIdLike(value) {
  return String(value || "").trim();
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function ensureMemoryLayout() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

async function backupLastWipe({ mode, query = "" }) {
  await fs.rm(MEMORY_UNDO_DIR, { recursive: true, force: true });
  await fs.mkdir(MEMORY_UNDO_DIR, { recursive: true });

  const meta = {
    createdAt: nowIso(),
    mode,
    query: query || ""
  };
  await fs.writeFile(MEMORY_UNDO_META_FILE, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  try {
    await fs.cp(MEMORY_DIR, MEMORY_UNDO_SNAPSHOT_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const sessionList = await fs.readFile(SESSION_LIST_FILE, "utf8");
    await fs.writeFile(MEMORY_UNDO_SESSION_LIST_FILE, sessionList, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function loadState() {
  await ensureMemoryLayout();
  const state = await readJsonIfPresent(STATE_FILE, {
    activeSessionId: "",
    sessions: []
  });

  if (!Array.isArray(state.sessions)) {
    state.sessions = [];
  }

  return state;
}

export async function saveState(state) {
  await ensureMemoryLayout();
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeSessionList(state.sessions);
}

async function writeSessionList(sessions) {
  const recent = [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, MAX_SESSIONS);
  const lines = recent.map((s) => `${s.id} | ${normalizeSummary(s.summary || "general chat")}`);
  const output = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  await fs.writeFile(SESSION_LIST_FILE, output, "utf8");
}

function upsertSession(state, session) {
  const idx = state.sessions.findIndex((x) => x.id === session.id);
  if (idx >= 0) {
    state.sessions[idx] = { ...state.sessions[idx], ...session };
  } else {
    state.sessions.push(session);
  }

  state.sessions = state.sessions
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_SESSIONS);
}

function sessionContextPath(sessionId) {
  return path.join(SESSIONS_DIR, toIdLike(sessionId), "context.md");
}

async function ensureSessionDir(sessionId) {
  await fs.mkdir(path.dirname(sessionContextPath(sessionId)), { recursive: true });
}

export async function ensureSessionRecord(sessionId, description = "general chat") {
  const id = toIdLike(sessionId);
  if (!id) {
    return;
  }
  const state = await loadState();
  const existing = state.sessions.find((x) => x.id === id);
  const stamp = nowIso();
  upsertSession(state, {
    id,
    summary: normalizeSummary(existing?.summary || description),
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
    endedAt: existing?.endedAt || ""
  });
  await saveState(state);
  await ensureSessionDir(id);
}

export async function setActiveSession(sessionId) {
  const state = await loadState();
  state.activeSessionId = toIdLike(sessionId);
  await saveState(state);
}

export async function getActiveSession() {
  const state = await loadState();
  return state.activeSessionId || "";
}

export async function endSession(sessionId) {
  const id = toIdLike(sessionId);
  const state = await loadState();
  const target = state.sessions.find((x) => x.id === id);
  if (target) {
    target.endedAt = nowIso();
    target.updatedAt = nowIso();
  }
  if (state.activeSessionId === id) {
    state.activeSessionId = "";
  }
  await saveState(state);
}

export async function listSessions() {
  const state = await loadState();
  return [...state.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function updateSessionSummary(sessionId, summary) {
  const id = toIdLike(sessionId);
  if (!id) {
    return;
  }
  const state = await loadState();
  const stamp = nowIso();
  const existing = state.sessions.find((x) => x.id === id);
  upsertSession(state, {
    id,
    summary: normalizeSummary(summary || existing?.summary || "general chat"),
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
    endedAt: existing?.endedAt || ""
  });
  await saveState(state);
}

export async function appendUserMemory(sessionId, userText) {
  const id = toIdLike(sessionId);
  if (!id) {
    return;
  }

  await ensureSessionRecord(id);
  await ensureSessionDir(id);

  const ctxPath = sessionContextPath(id);
  const summary = normalizeSummary(userText);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  let raw = "";
  try {
    raw = await fs.readFile(ctxPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = raw.trim() ? raw.split(/\r?\n/) : [];
  const summaryLine = `- ${stamp} | ${summary}`;
  const userEntries = lines.filter((line) => line.startsWith("- ") && line.includes(" | "));
  userEntries.push(summaryLine);
  const trimmedEntries = userEntries.slice(-40);

  const existingProjects = lines
    .filter((line) => line.startsWith("- ") && !line.includes(" | "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  const nextProjects = [
    ...new Set([...existingProjects, ...extractProjectHints(userText)])
  ].slice(0, 10);

  const output = [
    "# Context",
    "",
    "User: Srishti",
    `Session: ${id}`,
    "",
    "## Projects",
    ...(nextProjects.length ? nextProjects.map((p) => `- ${p}`) : ["- none"]),
    "",
    "## User Summaries",
    ...trimmedEntries,
    ""
  ].join("\n");
  await fs.writeFile(ctxPath, output, "utf8");
}

export async function readSessionMemory(sessionId) {
  const id = toIdLike(sessionId);
  if (!id) {
    return "";
  }

  try {
    return await fs.readFile(sessionContextPath(id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function isGenericLine(line) {
  const text = line.toLowerCase();
  const genericPatterns = [
    /\b(ok|okay|thanks|thank you|cool|nice|done)\b/,
    /\bhi\b/,
    /\bhello\b/
  ];
  const words = text.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  return words.length < 3 || genericPatterns.some((pattern) => pattern.test(text));
}

export async function pruneMemory({ mode, query }) {
  await backupLastWipe({ mode, query });
  const state = await loadState();
  const q = (query || "").trim().toLowerCase();

  if (mode === "all") {
    await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    await fs.writeFile(SESSION_LIST_FILE, "", "utf8");
    return { removed: "all" };
  }

  let changedFiles = 0;

  for (const s of state.sessions) {
    const ctxPath = sessionContextPath(s.id);
    let raw = "";
    try {
      raw = await fs.readFile(ctxPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const lines = raw.split(/\r?\n/);
    const kept = lines.filter((line) => {
      if (!line.startsWith("- ") || !line.includes(" | ")) {
        return true;
      }
      const lower = line.toLowerCase();
      if (mode === "query" && q) {
        return !lower.includes(q);
      }
      if (mode === "irrelevant") {
        return !isGenericLine(line);
      }
      return true;
    });

    if (kept.join("\n") !== lines.join("\n")) {
      changedFiles += 1;
      await fs.writeFile(ctxPath, `${kept.join("\n").trimEnd()}\n`, "utf8");
    }
  }

  return { removed: "partial", changedFiles };
}

export async function undoLastMemoryWipe() {
  const meta = await readJsonIfPresent(MEMORY_UNDO_META_FILE, null);
  if (!meta) {
    return { restored: false };
  }

  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  try {
    await fs.cp(MEMORY_UNDO_SNAPSHOT_DIR, MEMORY_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const sessionList = await fs.readFile(MEMORY_UNDO_SESSION_LIST_FILE, "utf8");
    await fs.writeFile(SESSION_LIST_FILE, sessionList, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.writeFile(SESSION_LIST_FILE, "", "utf8");
    } else {
      throw error;
    }
  }

  await fs.rm(MEMORY_UNDO_DIR, { recursive: true, force: true });
  return {
    restored: true,
    mode: meta.mode || "",
    createdAt: meta.createdAt || ""
  };
}

export function findSessionByIdOrSummary(sessions, text) {
  const query = (text || "").trim().toLowerCase();
  if (!query) {
    return null;
  }

  const exactId = sessions.find((s) => s.id.toLowerCase() === query);
  if (exactId) {
    return exactId;
  }

  const idPrefix = sessions.find((s) => s.id.toLowerCase().startsWith(query));
  if (idPrefix) {
    return idPrefix;
  }

  const bySummary = sessions.find((s) => (s.summary || "").toLowerCase().includes(query));
  return bySummary || null;
}
