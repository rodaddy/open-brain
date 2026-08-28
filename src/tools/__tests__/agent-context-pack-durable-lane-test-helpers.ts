import type { setupAgentContextPackToolClient } from "./agent-context-pack-test-helpers.ts";

/**
 * The structural pool shape the agent_context_pack tool client accepts. Named
 * here so a test can widen a real `Pool` or a mock into it without `any`.
 */
export type ToolClientPool = Parameters<typeof setupAgentContextPackToolClient>[1];

/** A recorded SQL call, as the mock query functions in these suites push it. */
export type RecordedQuery = { sql: string; params?: unknown[] };

/** An event object as it arrives inside a parsed durable_lane_context. */
export interface PackEvent {
  id: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Returns `value` when it is neither null nor undefined, and throws otherwise.
 * Replaces the non-null assertions the oxlint standard forbids while keeping
 * the assertion that follows it reading against a defined value.
 */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * The parts of an agent_context_pack result these suites assert against. Only
 * the read properties are declared, so a typo in a test is a typecheck error
 * rather than a silent `undefined`.
 */
export interface PackPayload {
  sections: { durable_lane_context?: DurableLaneSection };
  warnings: {
    degraded_sources?: unknown;
    scope_denials?: unknown;
    truncation?: unknown;
  };
  budget: {
    durable_lane_context: {
      max_events: number;
      max_event_chars: number;
      content_chars_used: number;
      content_char_limit: number;
    };
  };
  citations: unknown[];
}

/** The durable lane section of a pack, as the suites read it. */
export interface DurableLaneSection {
  events: PackEvent[];
  event_count: number;
  truncated: boolean;
  label: string;
  exact_scope_required: boolean;
  lane: { current_context_md: string; [key: string]: unknown };
}

/** The text payload of the first content block of a tool result, parsed. */
export function parsePackPayload(content: unknown): PackPayload {
  const blocks = content as Array<{ text: string }>;
  return JSON.parse(expectDefined(blocks[0], "first content block").text);
}
