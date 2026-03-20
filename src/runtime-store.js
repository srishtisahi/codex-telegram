import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./config.js";

const MEMORY_DIR = path.join(ROOT_DIR, "memory");
const RUNTIME_FILE = path.join(MEMORY_DIR, "runtime.json");

const DEFAULT_RUNTIME = {
  preferredModel: "",
  concurrencyMode: "interrupt",
  statusMode: "periodic",
  statusEveryMinutes: 10
};

async function ensureDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
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

function normalizeRuntime(raw) {
  const next = { ...DEFAULT_RUNTIME, ...(raw || {}) };
  if (!["queue", "interrupt", "parallel"].includes(next.concurrencyMode)) {
    next.concurrencyMode = DEFAULT_RUNTIME.concurrencyMode;
  }
  if (!["periodic", "end"].includes(next.statusMode)) {
    next.statusMode = DEFAULT_RUNTIME.statusMode;
  }
  const cadence = Number.parseInt(next.statusEveryMinutes, 10);
  next.statusEveryMinutes = Number.isFinite(cadence) && cadence > 0 ? cadence : DEFAULT_RUNTIME.statusEveryMinutes;
  next.preferredModel = String(next.preferredModel || "").trim();
  return next;
}

export async function getRuntimeSettings() {
  await ensureDir();
  const raw = await readJsonIfPresent(RUNTIME_FILE, DEFAULT_RUNTIME);
  return normalizeRuntime(raw);
}

export async function updateRuntimeSettings(patch) {
  const current = await getRuntimeSettings();
  const next = normalizeRuntime({ ...current, ...(patch || {}) });
  await fs.writeFile(RUNTIME_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
