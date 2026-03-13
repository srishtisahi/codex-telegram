import path from "node:path";
import fs from "node:fs";

export const ROOT_DIR = process.cwd();
export const AGENTS_FILE = path.join(ROOT_DIR, "AGENTS.md");
export const CHANGELOG_FILE = path.join(ROOT_DIR, "CHANGELOG.md");

export function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function getConfig() {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  const codexBin = process.env.CODEX_BIN || "codex";
  const codexModel = process.env.CODEX_MODEL || "";
  const codexSandbox = process.env.BRIDGE_CODEX_SANDBOX || "danger-full-access";
  const codexAskForApproval = process.env.BRIDGE_CODEX_ASK_FOR_APPROVAL || "never";
  const codexEphemeral = /^(1|true|yes)$/i.test(process.env.BRIDGE_CODEX_EPHEMERAL || "");

  if (!telegramToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  return {
    telegramToken,
    allowedChatId: allowedChatId || "",
    codexBin,
    codexModel,
    codexSandbox,
    codexAskForApproval,
    codexEphemeral
  };
}
