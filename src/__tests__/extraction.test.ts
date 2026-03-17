import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { extractMetadata, mergeTags } from "../extraction.ts";
import type { ExtractedMetadata } from "../extraction.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Restore env vars that tests may have modified
  process.env.LITELLM_URL = originalEnv.LITELLM_URL;
  process.env.LITELLM_API_KEY = originalEnv.LITELLM_API_KEY;
  process.env.EXTRACTION_MODEL = originalEnv.EXTRACTION_MODEL;
});

/** Helper: build a mock fetch that returns a successful LiteLLM chat completion */
function mockFetchOk(metadata: ExtractedMetadata): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(metadata),
          },
        },
      ],
    }),
  })) as unknown as typeof fetch;
}

describe("extractMetadata", () => {
  beforeEach(() => {
    // Clear env so tests control it explicitly
    delete process.env.LITELLM_URL;
    delete process.env.LITELLM_API_KEY;
    delete process.env.EXTRACTION_MODEL;
  });

  describe("returns null for empty/short text", () => {
    it("returns null for empty string", async () => {
      const result = await extractMetadata("");
      expect(result).toBeNull();
    });

    it("returns null for text shorter than 10 chars", async () => {
      const result = await extractMetadata("too short");
      expect(result).toBeNull();
    });

    it("returns null for undefined-ish text", async () => {
      const result = await extractMetadata(undefined as unknown as string);
      expect(result).toBeNull();
    });
  });

  describe("returns null when no LITELLM_URL is configured", () => {
    it("returns null when neither param nor env var is set", async () => {
      delete process.env.LITELLM_URL;
      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
      );
      expect(result).toBeNull();
    });
  });

  describe("returns null on HTTP error", () => {
    it("returns null when server responds with non-ok status", async () => {
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
      })) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });
  });

  describe("returns null on invalid JSON response", () => {
    it("returns null when LLM returns unparseable content", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "not valid json {{{",
              },
            },
          ],
        }),
      })) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });

    it("returns null when choices array is empty", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ choices: [] }),
      })) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });

    it("returns null when message content is missing", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: {} }],
        }),
      })) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });
  });

  describe("parses valid response correctly", () => {
    it("extracts all fields from well-formed response", async () => {
      const expected: ExtractedMetadata = {
        topics: ["TypeScript", "testing"],
        people: ["Alice", "Bob"],
        action_items: ["Write tests"],
        dates: ["2026-03-17"],
      };

      globalThis.fetch = mockFetchOk(expected);

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );

      expect(result).toEqual(expected);
    });

    it("defaults missing arrays to empty", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ topics: ["only-topics"] }),
              },
            },
          ],
        }),
      })) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );

      expect(result).toEqual({
        topics: ["only-topics"],
        people: [],
        action_items: [],
        dates: [],
      });
    });

    it("uses litellmUrl param over env var", async () => {
      process.env.LITELLM_URL = "http://env-url:4000";
      let calledUrl = "";

      globalThis.fetch = (async (url: string) => {
        calledUrl = url;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    topics: [],
                    people: [],
                    action_items: [],
                    dates: [],
                  }),
                },
              },
            ],
          }),
        };
      }) as unknown as typeof fetch;

      await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://param-url:4000",
      );

      expect(calledUrl).toBe("http://param-url:4000/chat/completions");
    });

    it("falls back to LITELLM_URL env var when param is omitted", async () => {
      process.env.LITELLM_URL = "http://env-url:4000";
      let calledUrl = "";

      globalThis.fetch = (async (url: string) => {
        calledUrl = url;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    topics: [],
                    people: [],
                    action_items: [],
                    dates: [],
                  }),
                },
              },
            ],
          }),
        };
      }) as unknown as typeof fetch;

      await extractMetadata("This is a sufficiently long text for extraction");

      expect(calledUrl).toBe("http://env-url:4000/chat/completions");
    });
  });

  describe("handles timeout gracefully", () => {
    it("returns null when fetch is aborted", async () => {
      globalThis.fetch = (async (
        _url: string,
        opts: { signal?: AbortSignal },
      ) => {
        // Simulate an abort by checking signal and throwing
        if (opts.signal) {
          // Immediately abort to simulate timeout
          opts.signal.throwIfAborted?.();
        }
        return new Promise((_resolve, reject) => {
          const abortHandler = () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          };
          if (opts.signal?.aborted) {
            abortHandler();
          } else {
            opts.signal?.addEventListener("abort", abortHandler);
          }
        });
      }) as unknown as typeof fetch;

      // Use a direct abort approach: the real code uses setTimeout with 8000ms,
      // but we can test the abort path by using a fetch that never resolves
      // and manually triggering the abort. Instead, let's just throw AbortError.
      globalThis.fetch = (async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });

    it("returns null on generic network error", async () => {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;

      const result = await extractMetadata(
        "This is a sufficiently long text for extraction",
        "http://localhost:4000",
      );
      expect(result).toBeNull();
    });
  });
});

describe("mergeTags", () => {
  describe("deduplicates case-insensitively", () => {
    it("does not add a topic that already exists in different case", () => {
      const existing = ["TypeScript"];
      const extracted: ExtractedMetadata = {
        topics: ["typescript", "TYPESCRIPT", "Testing"],
        people: [],
        action_items: [],
        dates: [],
      };

      const result = mergeTags(existing, extracted);
      expect(result).toEqual(["TypeScript", "Testing"]);
    });
  });

  describe("prefixes people with person:", () => {
    it("adds person: prefix to each person entry", () => {
      const existing: string[] = [];
      const extracted: ExtractedMetadata = {
        topics: [],
        people: ["Alice", "Bob"],
        action_items: [],
        dates: [],
      };

      const result = mergeTags(existing, extracted);
      expect(result).toEqual(["person:Alice", "person:Bob"]);
    });

    it("deduplicates people against existing person: tags", () => {
      const existing = ["person:Alice"];
      const extracted: ExtractedMetadata = {
        topics: [],
        people: ["Alice", "Charlie"],
        action_items: [],
        dates: [],
      };

      const result = mergeTags(existing, extracted);
      expect(result).toEqual(["person:Alice", "person:Charlie"]);
    });
  });

  describe("preserves existing tags", () => {
    it("returns all existing tags plus new ones", () => {
      const existing = ["existing-tag", "another-tag"];
      const extracted: ExtractedMetadata = {
        topics: ["new-topic"],
        people: ["NewPerson"],
        action_items: [],
        dates: [],
      };

      const result = mergeTags(existing, extracted);
      expect(result).toEqual([
        "existing-tag",
        "another-tag",
        "new-topic",
        "person:NewPerson",
      ]);
    });

    it("does not modify the original array", () => {
      const existing = ["original"];
      const extracted: ExtractedMetadata = {
        topics: ["added"],
        people: [],
        action_items: [],
        dates: [],
      };

      const result = mergeTags(existing, extracted);
      expect(existing).toEqual(["original"]); // unchanged
      expect(result).toEqual(["original", "added"]);
    });
  });

  describe("handles null extracted metadata", () => {
    it("returns existing tags unchanged when extracted is null", () => {
      const existing = ["keep-me", "also-keep"];
      const result = mergeTags(existing, null);
      expect(result).toEqual(["keep-me", "also-keep"]);
    });

    it("returns empty array when both existing is empty and extracted is null", () => {
      const result = mergeTags([], null);
      expect(result).toEqual([]);
    });
  });
});
