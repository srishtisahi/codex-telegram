function extractArgument(text, regex) {
  const match = text.match(regex);
  return match?.[1]?.trim() || "";
}

export function parseControlCommand(rawText) {
  const text = (rawText || "").trim();
  const lower = text.toLowerCase();

  if (!text) {
    return { type: "none" };
  }

  if (lower === "/sessions" || lower === "list sessions" || lower.includes("show sessions")) {
    return { type: "list_sessions" };
  }

  if (
    lower === "/new" ||
    lower.startsWith("/new ") ||
    lower.includes("start a new chat") ||
    lower.includes("start new chat") ||
    lower.includes("new session")
  ) {
    return {
      type: "new_session",
      summary: extractArgument(text, /(?:about|for)\s+(.+)/i) || "new chat"
    };
  }

  if (lower.startsWith("/switch ") || lower.includes("switch to session") || lower.includes("switch session")) {
    const target = extractArgument(text, /^\/switch\s+(.+)$/i) || extractArgument(text, /switch(?:\s+to)?\s+session\s+(.+)/i) || extractArgument(text, /switch\s+to\s+(.+)/i);
    return { type: "switch_session", target };
  }

  if (lower.startsWith("/resume ") || lower.includes("resume session")) {
    const target = extractArgument(text, /^\/resume\s+(.+)$/i) || extractArgument(text, /resume\s+session\s+(.+)/i) || extractArgument(text, /resume\s+(.+)/i);
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
    lower.includes("wipe previous memory") ||
    lower === "/wipe" ||
    lower === "/wipe all" ||
    lower.includes("wipe memory")
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
