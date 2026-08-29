import { logger } from "../../src/logger.ts";

export type BackgroundObservationType = "span" | "generation" | "embedding";

export interface BackgroundObservation {
  name: string;
  type: BackgroundObservationType;
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  model?: string;
  usageDetails?: Record<string, number>;
  level?: "DEFAULT" | "ERROR" | "WARNING";
  statusMessage?: string;
}

export interface BackgroundTraceBody {
  name: string;
  input?: unknown;
  output?: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
  observations: BackgroundObservation[];
  startedAt: number;
  endedAt: number;
  sessionId?: string;
  userId?: string;
}

export interface BackgroundTraceEmitter {
  emitBackground(body: BackgroundTraceBody): void;
}

export interface BackgroundTraceStart {
  name: string;
  input?: unknown;
  tags: string[];
  metadata?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}

export interface ObservationOptions<T> {
  input?: unknown;
  output?: (result: T) => unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  usageDetails?: (result: T) => Record<string, number> | undefined;
}

/** The call context one observation record is built from. */
interface ObservationContext<T> {
  type: BackgroundObservationType;
  name: string;
  options: ObservationOptions<T>;
  startedAt: number;
}

function errorOutput(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { error_class: error.name, error_message: error.message };
  }
  return { error_class: typeof error, error_message: String(error) };
}

/**
 * In-memory job trace recorder. It changes no job control flow: with no emitter,
 * every observation method calls the work directly and allocates no records.
 */
export class BackgroundTraceRecorder {
  private readonly observations: BackgroundObservation[] = [];
  private readonly startedAt: number;

  constructor(
    private readonly emitter: BackgroundTraceEmitter | undefined,
    private readonly trace: BackgroundTraceStart,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get active(): boolean {
    return this.emitter !== undefined;
  }

  span<T>(
    name: string,
    work: () => Promise<T>,
    options: ObservationOptions<T> = {},
  ): Promise<T> {
    return this.observe("span", name, work, options);
  }

  generation<T>(
    name: string,
    work: () => Promise<T>,
    options: ObservationOptions<T> & { model: string },
  ): Promise<T> {
    return this.observe("generation", name, work, options);
  }

  embedding<T>(
    name: string,
    work: () => Promise<T>,
    options: ObservationOptions<T> & { model: string },
  ): Promise<T> {
    return this.observe("embedding", name, work, options);
  }

  finish(output: unknown): void {
    this.emit(output, "success");
  }

  fail(error: unknown): void {
    this.emit(errorOutput(error), "exception");
  }

  private async observe<T>(
    type: BackgroundObservationType,
    name: string,
    work: () => Promise<T>,
    options: ObservationOptions<T>,
  ): Promise<T> {
    if (!this.emitter) return work();
    const startedAt = this.now();
    let result: T;
    try {
      result = await work();
    } catch (error: unknown) {
      this.recordFailure({ type, name, options, startedAt }, error);
      throw error;
    }

    this.recordSuccess({ type, name, options, startedAt }, result);
    return result;
  }

  private recordFailure<T>(context: ObservationContext<T>, error: unknown): void {
    const { type, name, options, startedAt } = context;
    this.recordSafely({
      name,
      type,
      input: options.input,
      output: errorOutput(error),
      metadata: options.metadata ?? {},
      startedAt,
      endedAt: this.now(),
      ...(options.model === undefined ? {} : { model: options.model }),
      level: "ERROR",
      statusMessage: error instanceof Error ? error.name : typeof error,
    });
  }

  private recordSuccess<T>(context: ObservationContext<T>, result: T): void {
    const { type, name, options, startedAt } = context;
    try {
      const usageDetails = options.usageDetails?.(result);
      this.observations.push({
        name,
        type,
        input: options.input,
        output: options.output?.(result),
        metadata: options.metadata ?? {},
        startedAt,
        endedAt: this.now(),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(usageDetails === undefined ? {} : { usageDetails }),
        level: "DEFAULT",
      });
    } catch (error: unknown) {
      logger.warn("background_tracing_observation_failed", {
        error_category: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private recordSafely(observation: BackgroundObservation): void {
    try {
      this.observations.push(observation);
    } catch (error: unknown) {
      logger.warn("background_tracing_observation_failed", {
        error_category: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private emit(output: unknown, status: "success" | "exception"): void {
    if (!this.emitter) return;
    try {
      this.emitter.emitBackground({
        name: this.trace.name,
        input: this.trace.input,
        output,
        tags: this.trace.tags,
        metadata: { ...this.trace.metadata, status },
        observations: this.observations,
        startedAt: this.startedAt,
        endedAt: this.now(),
        ...(this.trace.sessionId === undefined
          ? {}
          : { sessionId: this.trace.sessionId }),
        ...(this.trace.userId === undefined ? {} : { userId: this.trace.userId }),
      });
    } catch (error: unknown) {
      // Tracing is diagnostic-only. Keep this content-free because a custom
      // emitter error may carry an endpoint, payload, or credential.
      logger.warn("background_tracing_emit_failed", {
        error_category: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

/** Resolve a session key carried by a durable job payload or provenance. */
export function backgroundSessionId(input: {
  payload?: Record<string, unknown> | null;
  provenance?: Record<string, unknown> | null;
}): string | undefined {
  for (const source of [input.payload, input.provenance]) {
    const value = source?.session_key;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
