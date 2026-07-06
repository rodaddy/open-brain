import { describe, expect, it } from "bun:test";
import {
  appendSourceScopeParam,
  sourceRefSchema,
  sourceRefsSchema,
  sourceScopeFilterSql,
} from "./source-refs.ts";

describe("source refs", () => {
  it("accepts refs identified by document_id, path, or dms_id", () => {
    expect(sourceRefSchema.parse({ document_id: "doc-1" }).document_id).toBe(
      "doc-1",
    );
    expect(sourceRefSchema.parse({ path: "matters/acme/file.pdf" }).path).toBe(
      "matters/acme/file.pdf",
    );
    expect(sourceRefSchema.parse({ dms_id: "imanage-123" }).dms_id).toBe(
      "imanage-123",
    );
  });

  it("rejects refs without a document identifier", () => {
    expect(() =>
      sourceRefSchema.parse({ client_id: "acme", matter_id: "lit-1" }),
    ).toThrow();
  });

  it("rejects inverted text and excerpt bounds", () => {
    expect(() =>
      sourceRefSchema.parse({
        document_id: "doc-1",
        text_span: { start: 12, end: 3 },
      }),
    ).toThrow();
    expect(() =>
      sourceRefSchema.parse({
        document_id: "doc-1",
        excerpt_bounds: { start: 12, end: 3 },
      }),
    ).toThrow();
  });

  it("bounds the number of refs accepted per row", () => {
    const refs = Array.from({ length: 26 }, (_, index) => ({
      document_id: `doc-${index}`,
    }));

    expect(() => sourceRefsSchema.parse(refs)).toThrow();
  });

  it("accepts bounded privilege and locator metadata", () => {
    const parsed = sourceRefSchema.parse({
      document_id: "doc-1",
      client_id: "acme",
      matter_id: "lit-1",
      tenant_id: "tenant-a",
      access_group: "trial-team",
      role_policy: "attorney-only",
      ethical_wall: true,
      legal_hold: true,
      page: 3,
      paragraph: "12",
      section: "Argument",
      source_hash: "sha256:abc123",
      ingested_at: "2026-07-06T12:00:00.000Z",
    });

    expect(parsed.client_id).toBe("acme");
    expect(parsed.matter_id).toBe("lit-1");
    expect(parsed.ethical_wall).toBe(true);
    expect(parsed.page).toBe(3);
  });

  it("builds parameterized source-scope predicates", () => {
    const params: unknown[] = ["query"];
    const index = appendSourceScopeParam(params, {
      client_id: "acme",
      matter_id: "lit-1",
      document_id: "doc-1",
    });
    const predicate = sourceScopeFilterSql("t", index);

    expect(predicate).toContain("COALESCE(t.source_refs, '[]'::jsonb)");
    expect(predicate).toContain("jsonb_array_elements");
    expect(predicate).toContain(
      "source_ref.ref->>'client_id' = $2::jsonb->>'client_id'",
    );
    expect(predicate).toContain(
      "source_ref.ref->>'matter_id' = $2::jsonb->>'matter_id'",
    );
    expect(predicate).toContain(
      "source_ref.ref->>'document_id' = $2::jsonb->>'document_id'",
    );
    expect(predicate).toContain("$2::jsonb");
    expect(predicate).not.toContain("@> jsonb_build_array");
    expect(predicate).not.toContain("acme");
    expect(predicate).not.toContain("lit-1");
    expect(predicate).not.toContain("doc-1");
    expect(params).toEqual([
      "query",
      JSON.stringify({
        client_id: "acme",
        matter_id: "lit-1",
        document_id: "doc-1",
      }),
    ]);
  });
});
