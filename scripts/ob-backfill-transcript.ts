/**
 * Transcript reading for ob-backfill (issue 864 L6 seam).
 *
 * Moved verbatim out of scripts/ob-backfill.ts so the entrypoint stays
 * within the repo file-size rule. Sampling behavior is unchanged.
 */

export interface JsonlEvent {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
}

// --- Conversation extraction ---

function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Transcript event types that carry a conversational turn, mapped to the
 * speaker label used in the extracted text. Replaces two byte-identical
 * branches in extractConversation; the labels are unchanged.
 */
const TURN_SPEAKERS: Record<string, string | undefined> = {
  human: "USER",
  user: "USER",
  assistant: "ASSISTANT",
};

const SNAPSHOT_PATH_RE = /(?:\/[\w.-]+)+(?:\.(?:ts|js|sql|md|json|py|sh|yml|yaml))/g;

/**
 * File paths mentioned inside a file-history-snapshot event's content.
 * Hoisted out of extractConversation so that loop stays within the repo
 * nesting rule; the matching itself is unchanged.
 */
function snapshotPaths(event: JsonlEvent): string[] {
  const msg = event.message;
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as Record<string, unknown>).content;
  if (typeof content !== "string" || !content.includes("/")) return [];
  return content.match(SNAPSHOT_PATH_RE) ?? [];
}

/**
 * Walks the transcript once, collecting turn text, mentioned file paths, and
 * the first git branch seen. Hoisted out of extractConversation so that
 * function stays within the repo complexity rule; the walk is unchanged.
 */
function collectTurns(lines: JsonlEvent[]): {
  parts: string[];
  filesChanged: Set<string>;
  branch?: string;
} {
  const parts: string[] = [];
  const filesChanged = new Set<string>();
  let branch: string | undefined;

  for (const event of lines) {
    if (event.gitBranch && !branch) branch = event.gitBranch;

    const speaker = TURN_SPEAKERS[event.type];
    if (speaker !== undefined) {
      const content = event.message?.content ?? "";
      const text = extractTextContent(content).slice(0, 2000);
      if (text) parts.push(`${speaker}: ${text}`);
    } else if (event.type === "file-history-snapshot") {
      for (const path of snapshotPaths(event)) filesChanged.add(path);
    }
  }

  return { parts, filesChanged, branch };
}

export function extractConversation(lines: JsonlEvent[]): {
  text: string;
  filesChanged: string[];
  branch?: string;
} {
  const { parts, filesChanged, branch } = collectTurns(lines);

  // Smart sampling: first 3 turns for context, last 30% for outcomes, sample middle
  const total = parts.length;
  if (total <= 30) {
    // Short session — include everything
    return {
      text: parts.join("\n\n").slice(0, 12000),
      filesChanged: Array.from(filesChanged).slice(0, 20),
      branch,
    };
  }

  const head = parts.slice(0, 6); // first 3 exchanges for context
  const tailStart = Math.floor(total * 0.7);
  const tail = parts.slice(tailStart); // last 30% for outcomes
  const midStart = Math.floor(total * 0.3);
  const midEnd = Math.floor(total * 0.5);
  const mid = parts.slice(midStart, midEnd); // middle 20% for core work

  const sampled = [
    "--- SESSION START ---",
    ...head,
    `--- MIDDLE (turns ${midStart}-${midEnd} of ${total}) ---`,
    ...mid,
    `--- FINAL SECTION (turns ${tailStart}-${total} of ${total}) ---`,
    ...tail,
  ];

  return {
    text: sampled.join("\n\n").slice(0, 14000),
    filesChanged: Array.from(filesChanged).slice(0, 20),
    branch,
  };
}
