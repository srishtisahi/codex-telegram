import fs from "node:fs/promises";
import { CHANGELOG_FILE } from "./config.js";

const HEADER = "# CHANGELOG\n\nKeep only the last 5 project changes. Each entry must stay very brief: 1-2 lines.\n";
const MAX_ENTRIES = 5;

export async function ensureChangelog() {
  try {
    await fs.access(CHANGELOG_FILE);
  } catch {
    await fs.writeFile(CHANGELOG_FILE, `${HEADER}\n`, "utf8");
  }
}

export async function normalizeChangelog() {
  await ensureChangelog();
  const raw = await fs.readFile(CHANGELOG_FILE, "utf8");
  const lines = raw.split(/\r?\n/);
  const body = [];
  let current = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.length) {
        body.push(current);
      }
      current = [line];
      continue;
    }
    if (current.length) {
      if (line.trim() || current[current.length - 1].trim()) {
        current.push(line);
      }
    }
  }

  if (current.length) {
    body.push(current);
  }

  const trimmed = body.slice(-MAX_ENTRIES);
  const output = [HEADER.trimEnd(), "", ...trimmed.flatMap((entry) => [...entry, ""])].join("\n").trimEnd() + "\n";
  await fs.writeFile(CHANGELOG_FILE, output, "utf8");
}
