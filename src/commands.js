function extractArgument(text, regex) {
  const match = text.match(regex);
  return match?.[1]?.trim() || "";
}

function parseDurationMinutes(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) {
    return 0;
  }

  const heartbeatDirect = lower.match(/^\/heartbeat\s+(\d+)\b/);
  if (heartbeatDirect) {
    return Number.parseInt(heartbeatDirect[1], 10);
  }

  const forNumber = lower.match(/\b(?:for|run)\s+(\d+)\s*(?:minutes?|mins?|m)?\b/);
  if (forNumber) {
    return Number.parseInt(forNumber[1], 10);
  }

  if (/\ban?\s+hour\b/.test(lower)) {
    return 60;
  }
  if (/\bhalf\s+hour\b/.test(lower)) {
    return 30;
  }

  const hr = lower.match(/(\d+)\s*(?:hours?|hrs?|h)\b/);
  if (hr) {
    return Number.parseInt(hr[1], 10) * 60;
  }

  const min = lower.match(/(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (min) {
    return Number.parseInt(min[1], 10);
  }

  const bare = lower.match(/(?:for|run)\s+(\d+)\b/);
  if (bare) {
    return Number.parseInt(bare[1], 10);
  }

  return 0;
}

function parseStatusCadence(text) {
  const lower = String(text || "").toLowerCase();
  if (/\bone\s+at\s+the\s+end\b/.test(lower) || /\bonly\s+.*\bend\b/.test(lower)) {
    return { statusMode: "end", statusEveryMinutes: 0 };
  }
  const explicit = lower.match(/(?:status|update|progress)(?:\s+update)?s?.*?(?:every|each)\s+(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (explicit) {
    return {
      statusMode: "periodic",
      statusEveryMinutes: Number.parseInt(explicit[1], 10)
    };
  }
  const shorthand = lower.match(/\b(?:every|each)\s+(\d+)\s*(?:minutes?|mins?|m)\s+(?:updates?|status|progress)\b/);
  if (shorthand) {
    return {
      statusMode: "periodic",
      statusEveryMinutes: Number.parseInt(shorthand[1], 10)
    };
  }
  const withUpdates = lower.match(/\bwith\s+(\d+)\s*(?:minutes?|mins?|m)\s+(?:updates?|status|progress)\b/);
  if (withUpdates) {
    return {
      statusMode: "periodic",
      statusEveryMinutes: Number.parseInt(withUpdates[1], 10)
    };
  }
  return null;
}

function parseHeartbeatTask(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  const verbMatch = raw.match(/\b(?:work on|continue working on|build|implement|fix|finish|complete)\s+(.+)/i);
  if (verbMatch?.[1]) {
    return verbMatch[1].trim();
  }

  const tailMatch = raw.match(/\b(?:and|then)\s+(.+)/i);
  if (tailMatch?.[1]) {
    const tail = tailMatch[1].trim();
    if (tail && !/^status\s+updates?\b/i.test(tail)) {
      return tail;
    }
  }

  return "";
}

function parseTextBeforeHeartbeat(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  const idx = raw.search(/\bstart heartbeat\b/i);
  if (idx <= 0) {
    return "";
  }
  return raw.slice(0, idx).trim().replace(/[,\s]+$/, "");
}

export function parseControlCommand(rawText) {
  const text = (rawText || "").trim();
  const lower = text.toLowerCase();
  const lowerClean = lower.replace(/[^\w\s/.-]+/g, " ");
  const hasDurationToken =
    /\b\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b/.test(lower) ||
    /\ban?\s+hour\b/.test(lower) ||
    /\bhalf\s+hour\b/.test(lower);

  if (!text) {
    return { type: "none" };
  }

  if (lower === "/sessions" || lower === "list sessions" || lower.includes("show sessions")) {
    return { type: "list_sessions" };
  }

  if (
    lower === "/end others" ||
    lower === "/end other sessions" ||
    lowerClean.includes("end all other sessions") ||
    lowerClean.includes("close all other sessions") ||
    lowerClean.includes("end other sessions") ||
    lowerClean.includes("close other sessions")
  ) {
    return { type: "end_other_sessions" };
  }

  if (
    lower === "/end all" ||
    lower === "/end all sessions" ||
    lowerClean.includes("end all sessions") ||
    lowerClean.includes("close all sessions")
  ) {
    return { type: "end_all_sessions" };
  }

  if (
    lower === "/new" ||
    lower.startsWith("/new ") ||
    lower.includes("start a new chat") ||
    lower.includes("start new chat") ||
    (lower.includes("new session") && !lower.includes("with model"))
  ) {
    return {
      type: "new_session",
      summary: extractArgument(text, /(?:about|for)\s+(.+)/i) || "new chat"
    };
  }

  if (lower === "/models" || lower === "/model") {
    return { type: "models_show" };
  }

  if (lower.startsWith("/models set ") || lower.startsWith("/model ")) {
    const model = extractArgument(text, /^\/(?:models\s+set|model)\s+(.+)$/i);
    return { type: "model_set", model };
  }

  if (lower.startsWith("/models new ")) {
    const model = extractArgument(text, /^\/models\s+new\s+(.+)$/i);
    return { type: "model_new_session", model };
  }

  if (lower.includes("switch model to ") || lower.includes("change model to ")) {
    const model =
      extractArgument(text, /switch\s+model\s+to\s+(.+)/i) ||
      extractArgument(text, /change\s+model\s+to\s+(.+)/i);
    return { type: "model_set", model };
  }

  if (lower.includes("start a new session with model") || lower.includes("new session with model")) {
    const model =
      extractArgument(text, /start\s+a\s+new\s+session\s+with\s+model\s+(.+)/i) ||
      extractArgument(text, /new\s+session\s+with\s+model\s+(.+)/i);
    return { type: "model_new_session", model };
  }

  if (lower === "/health" || lower === "health") {
    return { type: "health" };
  }

  if (lower.startsWith("/heartbeat wipe")) {
    const query = extractArgument(text, /^\/heartbeat\s+wipe\s+(.+)$/i);
    if (!query || /^(?:all|sessions?|log|logs?)$/i.test(query)) {
      return { type: "heartbeat_wipe_all" };
    }
    return { type: "heartbeat_wipe_query", query };
  }

  if (
    (lower.includes("wipe heartbeat") || lower.includes("clear heartbeat") || lower.includes("delete heartbeat log")) &&
    !lower.includes("start heartbeat")
  ) {
    return { type: "heartbeat_wipe_all" };
  }

  if (lower === "/heartbeat confirm") {
    return { type: "heartbeat_confirm" };
  }

  if (lower.startsWith("/heartbeat stop") || lower === "/heartbeat off" || lower.includes("stop heartbeat") || lower.includes("terminate heartbeat")) {
    return { type: "heartbeat_stop" };
  }

  if (lower.startsWith("/heartbeat")) {
    const durationMinutes = parseDurationMinutes(text) || 30;
    const cadence = parseStatusCadence(text);
    return {
      type: "heartbeat_start",
      durationMinutes,
      statusEveryMinutes: cadence?.statusEveryMinutes ?? 10,
      statusMode: cadence?.statusMode || "periodic",
      taskText: parseHeartbeatTask(text)
    };
  }

  if (
    lower.includes("start heartbeat") ||
    (lower.includes("run for") && hasDurationToken) ||
    (lower.includes("start for") && hasDurationToken)
  ) {
    const durationMinutes = parseDurationMinutes(text) || 30;
    const cadence = parseStatusCadence(text);
    return {
      type: "heartbeat_start",
      durationMinutes,
      statusEveryMinutes: cadence?.statusEveryMinutes ?? 10,
      statusMode: cadence?.statusMode || "periodic",
      taskText: parseHeartbeatTask(text),
      contextTaskText: parseTextBeforeHeartbeat(text)
    };
  }

  if (lower.includes("status updates every") || lower.includes("only give me one at the end")) {
    const cadence = parseStatusCadence(text);
    if (cadence) {
      return { type: "heartbeat_status_prefs", ...cadence };
    }
  }

  if (lower.startsWith("/concurrency ")) {
    const mode = extractArgument(text, /^\/concurrency\s+(.+)$/i).toLowerCase();
    return { type: "concurrency_set", mode };
  }

  if (lower.includes("interrupt current session")) {
    return { type: "concurrency_set", mode: "interrupt" };
  }

  if (lower.includes("parallel session") || lower.includes("respond in parallel")) {
    return { type: "concurrency_set", mode: "parallel" };
  }

  if (lower.startsWith("/switch ") || lower.includes("switch to session") || lower.includes("switch session")) {
    const target = extractArgument(text, /^\/switch\s+(.+)$/i) || extractArgument(text, /switch(?:\s+to)?\s+session\s+(.+)/i) || extractArgument(text, /switch\s+to\s+(.+)/i);
    return { type: "switch_session", target };
  }

  if (
    lower === "/resume" ||
    lower.startsWith("/resume ") ||
    /\bresume\b.*\bsession\b/.test(lower) ||
    /\bresume\b.*\bchat\b/.test(lower)
  ) {
    const target =
      extractArgument(text, /^\/resume\s+(.+)$/i) ||
      extractArgument(text, /resume\s+session\s+(.+)/i) ||
      extractArgument(text, /resume\s+chat\s+(.+)/i) ||
      extractArgument(text, /resume\s+(.+)/i);
    return { type: "resume_session", target };
  }

  if (
    lower === "/end" ||
    /\bend\b.*\bsession\b/.test(lower) ||
    lower.includes("close session") ||
    lower.includes("self exit")
  ) {
    return { type: "end_session" };
  }

  if (
    lower === "stop" ||
    lower === "pause" ||
    lower === "revert" ||
    lower === "cancel" ||
    lower.startsWith("stop ") ||
    lower.startsWith("pause ") ||
    lower.startsWith("revert ") ||
    lower.startsWith("cancel ") ||
    lower.includes("stop current") ||
    lower.includes("pause current")
  ) {
    return { type: "hard_interrupt", text };
  }

  if (
    lower.includes("wipe previous memory") ||
    lower === "/wipe" ||
    lower === "/wipe all" ||
    lower.includes("wipe memory") ||
    (
      /\b(?:wipe|clear|delete|reset)\b/.test(lowerClean) &&
      /\bsessions?\b/.test(lowerClean) &&
      /\bmemory\b/.test(lowerClean)
    )
  ) {
    return { type: "wipe_memory_all" };
  }

  if (
    lower === "/undo" ||
    lower === "/undo wipe" ||
    lower.includes("undo memory wipe") ||
    lower.includes("undo wipe memory") ||
    lower.includes("restore wiped memory")
  ) {
    return { type: "undo_memory_wipe" };
  }

  if (lower === "yes" || lower === "confirm" || lower === "/confirm") {
    return { type: "confirm" };
  }

  if (lower.startsWith("/wipe ")) {
    const query = extractArgument(text, /^\/wipe\s+(.+)$/i);
    if (query && query.toLowerCase() !== "all") {
      return { type: "wipe_memory_query", query };
    }
  }

  if (lower.includes("delete the irrelevant parts from your memory") || lower.includes("delete irrelevant parts from your memory")) {
    return { type: "wipe_memory_irrelevant" };
  }

  if (lower.includes("delete") && lower.includes("from your memory")) {
    const query = extractArgument(text, /delete\s+(.+?)\s+from\s+your\s+memory/i);
    if (query) {
      return { type: "wipe_memory_query", query };
    }
  }

  return { type: "none" };
}
