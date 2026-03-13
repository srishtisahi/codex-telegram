import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AGENTS_FILE, CHANGELOG_FILE, ROOT_DIR } from "./config.js";
import { normalizeChangelog } from "./changelog.js";

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
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

function buildPrompt({ userText, relativeFiles, agentsText, changelogText }) {
  const fileSummary = relativeFiles.length
    ? `Relevant project files right now:\n${relativeFiles.map((file) => `- ${file}`).join("\n")}`
    : "Relevant project files right now:\n- No files found yet.";

  return [
    "You are Codex running in non-interactive exec mode for this repository.",
    "Always start a fresh conversation. Never rely on or refer to prior session ids.",
    "This project uses AGENTS.md for a concise repo overview and CHANGELOG.md for recent context.",
    "Read both files as project context before answering or making changes.",
    "If you make a meaningful project change, update CHANGELOG.md in place and keep only the last 5 entries.",
    "Each changelog entry must be extremely brief: 1-2 lines.",
    "Reply with a concise user-facing answer suitable for a Telegram message.",
    "",
    "AGENTS.md",
    agentsText.trim() || "(empty)",
    "",
    "CHANGELOG.md",
    changelogText.trim() || "(empty)",
    "",
    fileSummary,
    "",
    "User request from Telegram:",
    userText.trim()
  ].join("\n");
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
  codexBin,
  codexModel,
  codexSandbox = "danger-full-access",
  codexAskForApproval = "never",
  codexEphemeral = false
}) {
  await normalizeChangelog();
  const [agentsText, changelogText, relativeFiles] = await Promise.all([
    readIfPresent(AGENTS_FILE, ""),
    readIfPresent(CHANGELOG_FILE, ""),
    listProjectFiles()
  ]);

  const prompt = buildPrompt({ userText, relativeFiles, agentsText, changelogText });
  const outputFile = path.join(os.tmpdir(), `codex-telegram-last-message-${Date.now()}.txt`);
  const args = [
    "--ask-for-approval",
    codexAskForApproval,
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    codexSandbox,
    "--color",
    "never",
    "--output-last-message",
    outputFile
  ];

  if (codexEphemeral) {
    args.push("--ephemeral");
  }

  if (codexModel) {
    args.push("--model", codexModel);
  }

  args.push("-");

  const child = spawn(codexBin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      OTEL_SDK_DISABLED: "true"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

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

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

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

  let output = lastMessage || cleanedStdout || cleanedStderr || "Codex returned no output.";

  if (!lastMessage && cleanedStderr.includes("model is not supported when using Codex with a ChatGPT account")) {
    output = [
      "The configured Codex model is not supported on this account.",
      'Set `CODEX_MODEL=""` in `.env`, restart `./start-bridge.sh`, and try again.'
    ].join("\n");
  }

  return {
    ok: exitCode === 0,
    output
  };
}
