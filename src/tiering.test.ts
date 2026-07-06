import { describe, it, expect } from "bun:test";
import {
  classifyLaneEvent,
  DEFAULT_MIN_CONTENT_LENGTH,
  type Classification,
  type EventType,
  type Importance,
} from "./tiering.ts";

const EVENT_TYPES: EventType[] = [
  "fact",
  "decision",
  "blocker",
  "action",
  "artifact",
  "receipt",
  "question",
  "correction",
  "handoff",
];

const IMPORTANCES: Importance[] = ["hot", "warm", "cold"];

const GRADUATE_TYPES = new Set<EventType>(["fact", "decision", "handoff"]);
const ARCHIVE_TYPES = new Set<EventType>(["question", "action"]);
// "keep" default: blocker, artifact, receipt, correction (when not cold).
const KEEP_TYPES = new Set<EventType>([
  "blocker",
  "artifact",
  "receipt",
  "correction",
]);

/** Content comfortably above the default min length (24). */
const LONG = "x".repeat(DEFAULT_MIN_CONTENT_LENGTH + 10);
/** Content below the default min length. */
const SHORT = "x".repeat(DEFAULT_MIN_CONTENT_LENGTH - 1);

/** Oracle the matrix tests assert against (mirrors the rule spec). */
function expected(
  type: EventType,
  importance: Importance,
  content: string,
  minLen: number,
): Classification {
  if (importance === "cold" || ARCHIVE_TYPES.has(type)) return "archive";
  if (GRADUATE_TYPES.has(type)) {
    return content.trim().length >= minLen ? "graduate" : "manual-review";
  }
  return "keep";
}

describe("classifyLaneEvent — full matrix", () => {
  for (const type of EVENT_TYPES) {
    for (const importance of IMPORTANCES) {
      for (const [label, content] of [
        ["long", LONG],
        ["short", SHORT],
        ["empty", ""],
      ] as const) {
        it(`${type}/${importance}/${label}`, () => {
          const got = classifyLaneEvent({
            event_type: type,
            importance,
            content,
          });
          expect(got).toBe(
            expected(type, importance, content, DEFAULT_MIN_CONTENT_LENGTH),
          );
        });
      }
    }
  }
});

describe("classifyLaneEvent — graduate rule", () => {
  for (const type of GRADUATE_TYPES) {
    it(`graduates ${type} hot+long`, () => {
      expect(
        classifyLaneEvent({ event_type: type, importance: "hot", content: LONG }),
      ).toBe("graduate");
    });
    it(`graduates ${type} warm+long`, () => {
      expect(
        classifyLaneEvent({ event_type: type, importance: "warm", content: LONG }),
      ).toBe("graduate");
    });
    it(`archives ${type} when cold even if long (cold precedence)`, () => {
      expect(
        classifyLaneEvent({ event_type: type, importance: "cold", content: LONG }),
      ).toBe("archive");
    });
    it(`manual-review for ${type} warm+short (ambiguous)`, () => {
      expect(
        classifyLaneEvent({
          event_type: type,
          importance: "warm",
          content: SHORT,
        }),
      ).toBe("manual-review");
    });
  }
});

describe("classifyLaneEvent — memory lifecycle boundary", () => {
  it("keeps candidate lifecycle facts instead of graduating them", () => {
    expect(
      classifyLaneEvent({
        event_type: "fact",
        importance: "hot",
        content: LONG,
        metadata: {
          memory_lifecycle_action: "candidate",
          candidate_type: "negative_example",
          candidate_reason: "User correction requires review before durable memory.",
        },
      }),
    ).toBe("keep");
  });

  it("allows explicit shared nominations to use normal own-durable graduation", () => {
    expect(
      classifyLaneEvent({
        event_type: "fact",
        importance: "hot",
        content: LONG,
        metadata: {
          share_candidate: true,
          memory_lifecycle_action: "nominate_shared",
          candidate_type: "shared_kb_nomination",
          candidate_reason:
            "Shared nomination should not block own-durable graduation.",
        },
      }),
    ).toBe("graduate");
  });
});

describe("classifyLaneEvent — archive rule", () => {
  for (const type of ARCHIVE_TYPES) {
    for (const importance of IMPORTANCES) {
      it(`archives ${type}/${importance} regardless of length`, () => {
        expect(
          classifyLaneEvent({ event_type: type, importance, content: LONG }),
        ).toBe("archive");
      });
    }
  }
  it("archives any type when importance is cold", () => {
    for (const type of EVENT_TYPES) {
      expect(
        classifyLaneEvent({ event_type: type, importance: "cold", content: LONG }),
      ).toBe("archive");
    }
  });
});

describe("classifyLaneEvent — keep default", () => {
  for (const type of KEEP_TYPES) {
    it(`keeps ${type} hot+long`, () => {
      expect(
        classifyLaneEvent({ event_type: type, importance: "hot", content: LONG }),
      ).toBe("keep");
    });
    it(`keeps ${type} warm+short`, () => {
      expect(
        classifyLaneEvent({
          event_type: type,
          importance: "warm",
          content: SHORT,
        }),
      ).toBe("keep");
    });
  }
});

describe("classifyLaneEvent — minContentLength boundary", () => {
  it("graduates at exactly minContentLength (>= boundary)", () => {
    const content = "y".repeat(DEFAULT_MIN_CONTENT_LENGTH);
    expect(
      classifyLaneEvent({ event_type: "fact", importance: "warm", content }),
    ).toBe("graduate");
  });

  it("manual-review one char below minContentLength", () => {
    const content = "y".repeat(DEFAULT_MIN_CONTENT_LENGTH - 1);
    expect(
      classifyLaneEvent({ event_type: "fact", importance: "warm", content }),
    ).toBe("manual-review");
  });

  it("respects a custom minContentLength", () => {
    const content = "y".repeat(10);
    expect(
      classifyLaneEvent(
        { event_type: "decision", importance: "hot", content },
        5,
      ),
    ).toBe("graduate");
    expect(
      classifyLaneEvent(
        { event_type: "decision", importance: "hot", content },
        50,
      ),
    ).toBe("manual-review");
  });

  it("trims whitespace before measuring length", () => {
    const padded = `   ${"z".repeat(5)}   `;
    // 5 real chars, well under default 24 → manual-review for a graduate type.
    expect(
      classifyLaneEvent({
        event_type: "handoff",
        importance: "warm",
        content: padded,
      }),
    ).toBe("manual-review");
  });

  it("minContentLength of 0 graduates even empty graduate-type content", () => {
    expect(
      classifyLaneEvent(
        { event_type: "fact", importance: "warm", content: "" },
        0,
      ),
    ).toBe("graduate");
  });
});
