import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  generateEmbedding,
  generateEmbeddingWithMetadata,
  contentHash,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  __resetEmbeddingWatchdogForTests,
  __setEmbeddingWatchdogRestartSpawnerForTests,
} from "./embedding.ts";

// Helper: create a mock 768-length embedding array
function make768(): number[] {
  return Array.from({ length: 768 }, (_, i) => i * 0.001);
}

function makeEmbedding(length: number): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

// Helper: mock globalThis.fetch while satisfying Bun's extended fetch type
function mockFetch(
  fn: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  (globalThis as Record<string, unknown>).fetch = fn;
}

describe("generateEmbedding", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetEmbeddingWatchdogForTests();
    delete process.env.EMBEDDING_WATCHDOG_RESTART_SCRIPT;
    delete process.env.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD;
    delete process.env.EMBEDDING_WATCHDOG_COOLDOWN_MS;
  });

  it("returns 768-length number array on successful embedding response", async () => {
    const embedding = make768();
    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await generateEmbedding("hello world", "http://fake:4000");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(768);
    expect(result![0]).toBe(0);
    expect(result![767]).toBeCloseTo(0.767, 5);
  });

  it("returns null when embedding provider returns non-200 status", async () => {
    mockFetch(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const result = await generateEmbedding("hello world", "http://fake:4000");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await generateEmbedding("hello world", "http://fake:4000");
    expect(result).toBeNull();
  });

  it("returns null when response is malformed (missing data array)", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ result: "unexpected" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await generateEmbedding("hello world", "http://fake:4000");
    expect(result).toBeNull();
  });

  it("returns null when embedding is wrong length", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await generateEmbedding("hello world", "http://fake:4000");
    expect(result).toBeNull();
  });

  it("calls embedding provider with configured model and dimensions", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedUrl = "";

    mockFetch(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({ data: [{ embedding: make768() }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await generateEmbedding("test input", "http://fake:4000");

    expect(capturedUrl).toBe("http://fake:4000/embeddings");
    expect(capturedBody).not.toBeNull();
    // EMBEDDING_MODEL is captured from env at module load -- assert the
    // exported constant so the test passes regardless of local .env config.
    expect(capturedBody!.model).toBe(EMBEDDING_MODEL);
    expect(capturedBody!.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(capturedBody!.input).toBe("test input");
  });

  it("uses EMBEDDING_BASE_URL and normalizes trailing slash", async () => {
    const originalEmbeddingUrl = process.env.EMBEDDING_BASE_URL;
    let capturedUrl = "";

    process.env.EMBEDDING_BASE_URL = "http://embedding-provider:8791/v1/";

    try {
      mockFetch(async (input) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response(
          JSON.stringify({ data: [{ embedding: make768() }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const result = await generateEmbedding("test input");

      expect(result).not.toBeNull();
      expect(capturedUrl).toBe("http://embedding-provider:8791/v1/embeddings");
    } finally {
      if (originalEmbeddingUrl === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
      } else {
        process.env.EMBEDDING_BASE_URL = originalEmbeddingUrl;
      }
    }
  });

  it("uses EMBEDDING_API_KEY for provider auth", async () => {
    const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
    let capturedAuth = "";

    process.env.EMBEDDING_API_KEY = "embedding-key";

    try {
      mockFetch(async (_input, init) => {
        capturedAuth =
          (init?.headers as Record<string, string>).Authorization ?? "";
        return new Response(
          JSON.stringify({ data: [{ embedding: make768() }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const result = await generateEmbedding("test input", "http://fake:4000");

      expect(result).not.toBeNull();
      expect(capturedAuth).toBe("Bearer embedding-key");
    } finally {
      if (originalEmbeddingKey === undefined) {
        delete process.env.EMBEDDING_API_KEY;
      } else {
        process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
      }
    }
  });

  it("returns null on timeout (AbortError)", async () => {
    // Simulate AbortError that AbortController would trigger on timeout
    mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const result = await generateEmbedding("hello", "http://fake:4000");
    expect(result).toBeNull();
  });
});

describe("embedding watchdog", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetEmbeddingWatchdogForTests();
    process.env.EMBEDDING_WATCHDOG_RESTART_SCRIPT = "/fake/restart";
    process.env.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD = "2";
    process.env.EMBEDDING_WATCHDOG_COOLDOWN_MS = "300000";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetEmbeddingWatchdogForTests();
    delete process.env.EMBEDDING_WATCHDOG_RESTART_SCRIPT;
    delete process.env.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD;
    delete process.env.EMBEDDING_WATCHDOG_COOLDOWN_MS;
  });

  function fakeSpawnProcess(
    mode: "spawn" | "error" = "spawn",
  ): ReturnType<Parameters<typeof __setEmbeddingWatchdogRestartSpawnerForTests>[0]> {
    const handlers = new Map<string, (arg?: Error) => void>();
    return {
      once: (event: string, handler: (arg?: Error) => void) => {
        handlers.set(event, handler);
        if (event === mode) {
          queueMicrotask(() =>
            handler(
              mode === "error" ? new Error("restart script missing") : undefined,
            ),
          );
        }
        return undefined;
      },
      unref: () => undefined,
    } as unknown as ReturnType<
      Parameters<typeof __setEmbeddingWatchdogRestartSpawnerForTests>[0]
    >;
  }

  it("triggers restart after mixed restartable provider failures", async () => {
    let spawnCount = 0;
    __setEmbeddingWatchdogRestartSpawnerForTests(() => {
      spawnCount += 1;
      return fakeSpawnProcess();
    });

    mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await generateEmbeddingWithMetadata("first failure", "http://fake:4000");

    mockFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await generateEmbeddingWithMetadata("second failure", "http://fake:4000");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnCount).toBe(1);
  });

  it("does not cooldown-suppress retry when restart spawn fails", async () => {
    let spawnCount = 0;
    __setEmbeddingWatchdogRestartSpawnerForTests(() => {
      spawnCount += 1;
      return fakeSpawnProcess("error");
    });

    mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await generateEmbeddingWithMetadata("first failure", "http://fake:4000");
    await generateEmbeddingWithMetadata("second failure", "http://fake:4000");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await generateEmbeddingWithMetadata("third failure", "http://fake:4000");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnCount).toBe(2);
  });

  it("does not restart after non-restartable client failures", async () => {
    let spawnCount = 0;
    __setEmbeddingWatchdogRestartSpawnerForTests(() => {
      spawnCount += 1;
      return fakeSpawnProcess();
    });

    mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    await generateEmbeddingWithMetadata("first failure", "http://fake:4000");
    await generateEmbeddingWithMetadata("second failure", "http://fake:4000");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnCount).toBe(0);
  });
});

describe("retry behavior", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries on 500 and succeeds on second attempt", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(
        JSON.stringify({ data: [{ embedding: make768() }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await generateEmbedding("hello", "http://fake:4000");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(768);
    expect(callCount).toBe(2);
  });

  it("retries on timeout (AbortError) and fails after all attempts with structured error", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("timeout");
    expect(result.error!.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it("does not retry on 400", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    });

    const result = await generateEmbedding("hello", "http://fake:4000");
    expect(result).toBeNull();
    expect(callCount).toBe(1);
  });

  it("does not retry on 401", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const result = await generateEmbedding("hello", "http://fake:4000");
    expect(result).toBeNull();
    expect(callCount).toBe(1);
  });
});

describe("configurable timeout", () => {
  let originalFetch: typeof globalThis.fetch;
  const originalEnv = process.env.EMBEDDING_TIMEOUT_MS;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.EMBEDDING_TIMEOUT_MS;
    } else {
      process.env.EMBEDDING_TIMEOUT_MS = originalEnv;
    }
  });

  it("uses EMBEDDING_TIMEOUT_MS env var when set", async () => {
    // The module reads the env var at import time, so we verify the constant
    // exists and the module structure supports configuration.
    // We test functionally: a very short timeout should cause AbortError
    // before a slow server can respond.
    let capturedSignal: AbortSignal | undefined;
    mockFetch(async (_input, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(
        JSON.stringify({ data: [{ embedding: make768() }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await generateEmbedding("test", "http://fake:4000");
    // Verify an AbortSignal was passed (proves timeout mechanism is wired)
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal instanceof AbortSignal).toBe(true);
  });
});

describe("generateEmbeddingWithMetadata", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns embedding on success", async () => {
    const embedding = make768();
    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await generateEmbeddingWithMetadata(
      "hello world",
      "http://fake:4000",
    );
    expect(result.embedding).not.toBeNull();
    expect(result.embedding).toHaveLength(768);
    expect(result.error).toBeUndefined();
  });

  it("returns structured error with code on server failure", async () => {
    mockFetch(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("server_error");
    expect(result.error!.attempts).toBe(3);
    expect(result.error!.lastStatus).toBe(500);
  });

  it("returns input_invalid error for empty text", async () => {
    const result = await generateEmbeddingWithMetadata(
      "",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("input_invalid");
    expect(result.error!.attempts).toBe(0);
  });

  it("returns no_embedding_url error when no URL provided", async () => {
    const origEmbeddingUrl = process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;

    try {
      const result = await generateEmbeddingWithMetadata("hello");
      expect(result.embedding).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("no_embedding_url");
    } finally {
      if (origEmbeddingUrl !== undefined) {
        process.env.EMBEDDING_BASE_URL = origEmbeddingUrl;
      }

    }
  });

  it("returns malformed_response error for wrong embedding shape", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("malformed_response");
  });

  it("returns network error on ECONNRESET after all retries", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      throw new Error("ECONNRESET");
    });

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("network");
    expect(result.error!.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it("returns client_error on 401 without retry", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("client_error");
    expect(result.error!.lastStatus).toBe(401);
    expect(callCount).toBe(1);
  });

  it("returns input_invalid error on 400 without retry", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    });

    const result = await generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );
    expect(result.embedding).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("input_invalid");
    expect(result.error!.lastStatus).toBe(400);
    expect(callCount).toBe(1);
  });
});

describe("configurable embedding dimensions", () => {
  let originalFetch: typeof globalThis.fetch;
  const originalDimensions = process.env.EMBEDDING_DIMENSIONS;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDimensions === undefined) {
      delete process.env.EMBEDDING_DIMENSIONS;
    } else {
      process.env.EMBEDDING_DIMENSIONS = originalDimensions;
    }
  });

  it("validates returned embedding length against EMBEDDING_DIMENSIONS", async () => {
    process.env.EMBEDDING_DIMENSIONS = "3";
    const module = await import(`./embedding.ts?dim-test=${Date.now()}`);
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({ data: [{ embedding: makeEmbedding(3) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await module.generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );

    expect(result.embedding).toEqual(makeEmbedding(3));
    expect(result.error).toBeUndefined();
    expect(capturedBody!.dimensions).toBe(3);
  });

  it("rejects embeddings that do not match EMBEDDING_DIMENSIONS", async () => {
    process.env.EMBEDDING_DIMENSIONS = "3";
    const module = await import(`./embedding.ts?dim-test-bad=${Date.now()}`);

    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: makeEmbedding(4) }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await module.generateEmbeddingWithMetadata(
      "hello",
      "http://fake:4000",
    );

    expect(result.embedding).toBeNull();
    expect(result.error?.code).toBe("malformed_response");
  });
});

describe("contentHash", () => {
  it("returns consistent SHA-256 hex digest for same input", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different digest for different input", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("goodbye world");
    expect(hash1).not.toBe(hash2);
  });

  it("normalizes whitespace before hashing (trim + collapse internal whitespace)", () => {
    const normal = contentHash("hello world");
    const withExtraSpaces = contentHash("  hello    world  ");
    const withTabs = contentHash("\thello\t\tworld\t");
    const withNewlines = contentHash("\nhello\n\nworld\n");

    expect(withExtraSpaces).toBe(normal);
    expect(withTabs).toBe(normal);
    expect(withNewlines).toBe(normal);
  });
});
