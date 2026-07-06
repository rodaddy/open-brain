import { describe, expect, it } from "bun:test";
import {
  appendSourceScopeParam,
  filterSourceRefsForScope,
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
      path: "matters/acme/strategy.pdf",
      dms_id: "imanage-1",
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
    expect(predicate).toContain(
      "source_ref.ref->>'path' = $2::jsonb->>'path'",
    );
    expect(predicate).toContain(
      "source_ref.ref->>'dms_id' = $2::jsonb->>'dms_id'",
    );
    expect(predicate).toContain("source_ref.ref ? 'document_id'");
    expect(predicate).toContain("source_ref.ref ? 'path'");
    expect(predicate).toContain("source_ref.ref ? 'dms_id'");
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
        path: "matters/acme/strategy.pdf",
        dms_id: "imanage-1",
      }),
    ]);
  });

  it("filters returned refs to the same matching source-scope object", () => {
    const refs = [
      {
        document_id: "doc-1",
        client_id: "acme",
        matter_id: "lit-1",
        path: "matters/acme/strategy.pdf",
      },
      {
        document_id: "doc-2",
        client_id: "acme",
        matter_id: "lit-2",
        path: "matters/acme/other.pdf",
      },
    ];

    expect(
      filterSourceRefsForScope(refs, {
        client_id: "acme",
        matter_id: "lit-1",
      }),
    ).toEqual([{ ...refs[0]!, source_type: "file" }]);
    expect(
      filterSourceRefsForScope(refs, {
        path: "matters/acme/other.pdf",
      }),
    ).toEqual([{ ...refs[1]!, source_type: "file" }]);
  });

  it("keeps valid matching refs when sibling refs are invalid", () => {
    const refs = [
      {
        document_id: "doc-1",
        client_id: "acme",
        matter_id: "lit-1",
      },
      {
        source_type: "legacy-unknown",
        document_id: "doc-2",
        client_id: "acme",
        matter_id: "lit-1",
      },
      {
        client_id: "acme",
        matter_id: "lit-1",
      },
    ];

    expect(
      filterSourceRefsForScope(refs, {
        client_id: "acme",
        matter_id: "lit-1",
      }),
    ).toEqual([{ ...refs[0]!, source_type: "file" }]);
  });
});
