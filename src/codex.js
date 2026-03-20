import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AGENTS_FILE, CHANGELOG_FILE, ROOT_DIR, SAFETY_GUIDE_FILE } from "./config.js";
import { normalizeChangelog } from "./changelog.js";

const activeChildren = new Set();

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function cancelActiveCodexRuns() {
  let cancelled = 0;
  for (const child of activeChildren) {
    try {
      child.kill("SIGTERM");
      cancelled += 1;
    } catch {
      // Ignore processes that already exited.
    }
  }
  return cancelled;
}

async function readIfPresent(filePath, fallback) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function buildPrompt({
  userText,
  relativeFiles,
  agentsText,
  changelogText,
  safetyGuideText,
  sessionId,
  contextText,
  modelName,
  forceSubagents
}) {
  const fileSummary = relativeFiles.length
    ? `Relevant project files right now:\n${relativeFiles.map((file) => `- ${file}`).join("\n")}`
    : "Relevant project files right now:\n- No files found yet.";

  return [
    "You are Codex running in non-interactive exec mode for this repository.",
    "The Telegram user is named Srishti. Always address the user as Srishti.",
    "Use this active session id for continuity:",
    sessionId,
    `Current requested model: ${modelName || "default"}`,
    "This project uses AGENTS.md for repo behavior and CHANGELOG.md for recent context.",
    "Read AGENTS.md, CHANGELOG.md, and SAFETY_GUIDE.md as project context before answering or making changes.",
    "If you make a meaningful project change, update CHANGELOG.md in place and keep only the last 5 entries.",
    "Each changelog entry must be extremely brief: 1-2 lines.",
    "For Linear task titles, prefix with '<session-id> - '. Example: '12345 - make landing page responsive'.",
    "When user starts a project, create and maintain a Linear TODO list and execute tasks added by user.",
    "Use subagents for large tasks, or whenever the user asks for subagents.",
    `Subagent request for this task: ${forceSubagents ? "required" : "optional based on task size"}.`,
    "If subagents are used, include this exact first line in your final answer: [SUBAGENTS] used",
    "If no subagents are used, include this exact first line in your final answer: [SUBAGENTS] none",
    "If close to daily Codex usage limit, include this exact first line: [LIMIT_WARNING] <short warning>",
    "Reply with a concise user-facing answer suitable for a Telegram message.",
    "Prefer compact responses unless asked for detail.",
    "",
    "AGENTS.md",
    agentsText.trim() || "(empty)",
    "",
    "CHANGELOG.md",
    changelogText.trim() || "(empty)",
    "",
    "SAFETY_GUIDE.md",
    safetyGuideText.trim() || "(empty)",
    "",
    "Session memory context (compact):",
    contextText.trim() || "(empty)",
    "",
    fileSummary,
    "",
    "User request from Telegram:",
    userText.trim()
  ].join("\n");
}

function parseThreadIdFromJsonl(stdoutText) {
  const lines = stdoutText.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt?.thread_id) {
        return String(evt.thread_id);
      }
      if (evt?.type === "thread.started" && evt?.thread_id) {
        return String(evt.thread_id);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return "";
}

async function listProjectFiles() {
  const entries = await fs.readdir(ROOT_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(ROOT_DIR, entry.name))
    .map((filePath) => path.relative(ROOT_DIR, filePath))
    .sort();
}

export async function runCodex({
  userText,
  sessionId,
  createNewSession,
  codexBin,
  codexModel,
  codexSandbox = "danger-full-access",
  codexAskForApproval = "never",
  codexEphemeral = false,
  codexBypassSandbox = false,
  contextText = "",
  forceSubagents = false
}) {
  await normalizeChangelog();
  const [agentsText, changelogText, safetyGuideText, relativeFiles] = await Promise.all([
    readIfPresent(AGENTS_FILE, ""),
    readIfPresent(CHANGELOG_FILE, ""),
    readIfPresent(SAFETY_GUIDE_FILE, ""),
    listProjectFiles()
  ]);

  const prompt = buildPrompt({
    userText,
    relativeFiles,
    agentsText,
    changelogText,
    safetyGuideText,
    sessionId: sessionId || "(pending)",
    contextText,
    modelName: codexModel,
    forceSubagents
  });

  const outputFile = path.join(os.tmpdir(), `codex-telegram-last-message-${Date.now()}.txt`);
  const args = [
    "--ask-for-approval",
    codexAskForApproval,
    "exec"
  ];
  if (codexBypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (!createNewSession) {
    args.push("resume", "--json", "--output-last-message", outputFile);
    if (codexEphemeral) {
      args.push("--ephemeral");
    }
    if (codexModel) {
      args.push("--model", codexModel);
    }
    args.push(sessionId || "", "-");
  } else {
    args.push(
      "--skip-git-repo-check",
      "--sandbox",
      codexSandbox,
      "--color",
      "never",
      "--json",
      "--output-last-message",
      outputFile
    );
    if (codexEphemeral) {
      args.push("--ephemeral");
    }
    if (codexModel) {
      args.push("--model", codexModel);
    }
    args.push("-");
  }

  const child = spawn(codexBin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      OTEL_SDK_DISABLED: "true"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeChildren.add(child);

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.stdin.write(prompt);
  child.stdin.end();

  let exitCode = 1;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    activeChildren.delete(child);
  }

  await normalizeChangelog();

  const cleanedStdout = stripAnsi(stdout).trim();
  const cleanedStderr = stripAnsi(stderr).trim();
  let lastMessage = "";
  try {
    lastMessage = (await fs.readFile(outputFile, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  } finally {
    await fs.rm(outputFile, { force: true });
  }

  const threadId = parseThreadIdFromJsonl(cleanedStdout) || sessionId || "";
  let output = lastMessage || cleanedStderr || "Codex returned no output.";

  if (!lastMessage && cleanedStderr.includes("model is not supported when using Codex with a ChatGPT account")) {
    output = [
      "The configured Codex model is not supported on this account.",
      "Set `CODEX_MODEL=\"\"` in `.env`, restart `./start-bridge.sh`, and try again."
    ].join("\n");
  }

  return {
    ok: exitCode === 0,
    output,
    threadId,
    stderr: cleanedStderr,
    stdout: cleanedStdout
  };
}
