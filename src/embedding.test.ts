import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateEmbedding, contentHash } from "./embedding.ts";

// Helper: create a mock 768-length embedding array
function make768(): number[] {
  return Array.from({ length: 768 }, (_, i) => i * 0.001);
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
  });

  it("returns 768-length number array on successful LiteLLM response", async () => {
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

  it("returns null when LiteLLM returns non-200 status", async () => {
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

  it("calls LiteLLM with model 'embeddings' and dimensions 768", async () => {
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
    expect(capturedBody!.model).toBe("embeddings");
    expect(capturedBody!.dimensions).toBe(768);
    expect(capturedBody!.input).toBe("test input");
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
