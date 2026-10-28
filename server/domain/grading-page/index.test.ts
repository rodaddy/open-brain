import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { RemCandidate } from "../../../server/maintenance/dream-rem.ts";
import { toFrozenQueueItem } from "../../../scripts/rem-frozen-queue-item.ts";
import { createGradingPageHtml, GRADING_PAGE_HTML } from "./index.ts";

type FakeElement = {
  attached: boolean;
  append: (...children: FakeElement[]) => void;
  classList: { toggle: () => void };
  close: () => void;
  closest: () => { remove: () => void };
  focus: () => void;
  querySelectorAll: () => FakeElement[];
  remove: () => void;
  style: Record<string, string>;
  textContent: string;
  [key: string]: unknown;
};

function fakeElement(onRemove: () => void): FakeElement {
  const element: FakeElement = {
    attached: false,
    append: (...children) => {
      children.forEach((child) => {
        child.attached = true;
      });
    },
    classList: { toggle: () => undefined },
    close: () => undefined,
    closest: () => ({ remove: onRemove }),
    focus: () => undefined,
    querySelectorAll: () => [],
    remove: onRemove,
    style: {},
    textContent: "",
  };
  return element;
}

const SNAPSHOT_SHA256 = "a".repeat(64);
const FROZEN_QUEUE_ITEM = toFrozenQueueItem({
  id: "candidate-1",
  namespace: "frozen-namespace",
  candidate_type: "decision",
  content: "Keep this exact frozen claim.",
  content_hash: "frozen-content-hash",
  uncertain: true,
  uncertainty_reason: "model extraction doubt",
  model: "extractor-model",
  session_count: 3,
  occurrence_count: 7,
  reinforcement_count: 2,
} satisfies Readonly<RemCandidate>);
type Keydown = (event: Record<string, unknown>) => void;

function submitWithKeyboard(keydown: Keydown): void {
  const event = {
    altKey: false,
    ctrlKey: false,
    key: "1",
    metaKey: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    target: null,
  };
  keydown(event);
  keydown({ ...event, key: "q" });
  keydown({ ...event, key: "g" });
  keydown({ ...event, key: "Enter" });
  keydown({ ...event, ctrlKey: true, key: "Enter" });
}

function observeElements(
  createdElements: FakeElement[],
  elements: Map<string, FakeElement>,
): {
  attachedIds: string[];
  attachedTexts: string[];
  hiddenIds: string[];
  notePlaceholder: string | null;
} {
  const placeholder = createdElements.find(
    (element) => element.id === "note",
  )?.placeholder;
  return {
    hiddenIds: [...elements.entries()]
      .filter(([, element]) => element.hidden === true)
      .map(([id]) => id),
    attachedIds: createdElements
      .filter((element) => element.attached && typeof element.id === "string")
      .map((element) => String(element.id)),
    attachedTexts: createdElements
      .filter((element) => element.attached && element.textContent.length > 0)
      .map((element) => element.textContent),
    notePlaceholder: typeof placeholder === "string" ? placeholder : null,
  };
}

function createFetch(
  options: { blind?: boolean; submit?: boolean },
  paths: string[],
  requestBodies: unknown[],
) {
  return vi.fn(async (path: string, request?: { body?: string }) => {
    paths.push(path);
    if (request?.body) requestBodies.push(JSON.parse(request.body));
    const body =
      path === "/api/grade-batch"
        ? options.blind
          ? { savedCount: 1, results: [{ agreed: true }] }
          : { batch_id: "batch-1", results: [{ agreed: true }] }
        : path.startsWith("/api/stats")
          ? {
              ungraded: 1,
              graded: 0,
              by_action: { promoted: 0, rejected: 0, inconclusive: 0, duplicate: 0 },
              agent_behavior: { by_value: {} },
              by_anchor_kind: {},
              machine_agreement: {
                compared: 0,
                rate: null,
                distinct_machine_grades: 0,
              },
            }
          : {
              items: options.submit
                ? [
                    options.blind
                      ? FROZEN_QUEUE_ITEM
                      : {
                          id: "candidate-1",
                          candidate_type: "fragment",
                          content: "claim",
                          model: "fixture-model",
                          machine_grade: "rejected",
                        },
                  ]
                : [],
              total: options.submit ? 1 : 0,
            };
    return { json: async () => body, ok: true, status: 200 };
  });
}

type RunPageOptions = {
  blind: boolean;
  snapshotSha256?: string;
  storage?: Record<string, string>;
  submit?: boolean;
};

async function runPage(options: RunPageOptions): Promise<{
  paths: string[];
  requestBodies: unknown[];
  agreementRemoved: boolean;
  attachedIds: string[];
  attachedTexts: string[];
  hiddenIds: string[];
  notePlaceholder: string | null;
  removedIds: string[];
  storage: Record<string, string>;
}> {
  const html = createGradingPageHtml({
    blind: options.blind,
    ...(options.blind
      ? { snapshotSha256: options.snapshotSha256 ?? SNAPSHOT_SHA256 }
      : {}),
  });
  const script = html.match(/<script>\n([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("grading page did not contain its browser script");

  let agreementRemoved = false;
  const removedIds = new Set<string>();
  const elements = new Map<string, FakeElement>();
  const getElement = (id: string): FakeElement => {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = fakeElement(() => {
      if (id === "agree") agreementRemoved = true;
      removedIds.add(id);
    });
    elements.set(id, created);
    return created;
  };
  const paths: string[] = [];
  const requestBodies: unknown[] = [];
  const createdElements: FakeElement[] = [];
  const fetch = createFetch(options, paths, requestBodies);
  let keydown: Keydown | undefined;
  const document = {
    addEventListener: (
      type: string,
      handler: (event: Record<string, unknown>) => void,
    ) => {
      if (type === "keydown") keydown = handler;
    },
    createElement: () => {
      const element = fakeElement(() => undefined);
      createdElements.push(element);
      return element;
    },
    getElementById: getElement,
    querySelectorAll: () => [],
  };
  const stored = new Map(Object.entries(options.storage ?? {}));
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  };
  const window = { addEventListener: () => undefined };

  runInNewContext(script, {
    confirm: () => true,
    console,
    document,
    fetch,
    localStorage,
    window,
  });

  await vi.waitFor(() => expect(paths).toContain("/api/queue?limit=50"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (options.submit && keydown) {
    submitWithKeyboard(keydown);
    await vi.waitFor(() => expect(paths).toContain("/api/grade-batch"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    paths,
    requestBodies,
    agreementRemoved,
    removedIds: [...removedIds],
    storage: Object.fromEntries(stored),
    ...observeElements(createdElements, elements),
  };
}

async function expectStorageIsolation(): Promise<void> {
  const normalDraft = JSON.stringify([
    { candidateId: "candidate-1", action: "rejected", reasonCode: "stale" },
  ]);
  const lastBatch = JSON.stringify({ batch_id: "normal-batch", size: 2 });
  const normalKeys = {
    "ob.grading.batch.v1": normalDraft,
    "ob.grading.lastBatch.v1": lastBatch,
  };
  const normal = await runPage({ blind: false, storage: normalKeys, submit: true });
  expect(normal.requestBodies[0]).toMatchObject({
    grades: [{ candidateId: "candidate-1", action: "rejected", reasonCode: "stale" }],
  });
  expect(normal.storage["ob.grading.lastBatch.v1"]).toContain("batch-1");
  const isolated = await runPage({ blind: true, storage: normalKeys, submit: true });
  expect(isolated.requestBodies).toEqual([
    {
      grades: [{ candidateId: "candidate-1", action: "promoted" }],
      snapshotSha256: SNAPSHOT_SHA256,
    },
  ]);
  expect(isolated.storage["ob.grading.lastBatch.v1"]).toBe(lastBatch);

  const otherHash = "b".repeat(64);
  const blindKey = `ob.grading.batch.blind.${SNAPSHOT_SHA256}.v1`;
  const blindDraft = JSON.stringify([
    { candidateId: "candidate-1", action: "duplicate" },
  ]);
  const resumed = await runPage({
    blind: true,
    storage: { [blindKey]: blindDraft },
    submit: true,
  });
  expect(resumed.requestBodies[0]).toMatchObject({
    grades: [{ candidateId: "candidate-1", action: "duplicate" }],
  });
  const different = await runPage({
    blind: true,
    snapshotSha256: otherHash,
    storage: { [blindKey]: blindDraft },
    submit: true,
  });
  expect(different.requestBodies[0]).toMatchObject({
    grades: [{ candidateId: "candidate-1", action: "promoted" }],
  });
}

describe("grading page rendering mode", () => {
  it("keeps the exported default in normal mode", async () => {
    expect(GRADING_PAGE_HTML).toBe(createGradingPageHtml());
    const result = await runPage({ blind: false });
    expect(result.paths).toEqual(["/api/queue?limit=50", "/api/stats"]);
    expect(result.agreementRemoved).toBe(false);
  });

  it("blinds machine output without removing the four human actions", async () => {
    const html = createGradingPageHtml({
      blind: true,
      snapshotSha256: SNAPSHOT_SHA256,
    });
    const result = await runPage({ blind: true });
    expect(result.paths).toEqual(["/api/queue?limit=50"]);
    expect(result.agreementRemoved).toBe(true);
    expect(result.removedIds).toEqual(
      expect.arrayContaining(["reason-keys", "behavior-keys"]),
    );
    expect(html).toContain(
      'const ORDER = ["promoted", "rejected", "inconclusive", "duplicate"]',
    );
    expect(html).toContain("if (!BLIND_MODE && it.machine_grade)");
  });

  it("requires the snapshot hash and adds it only to blind grade envelopes", async () => {
    expect(() => createGradingPageHtml({ blind: true })).toThrow(/64-character hex/);
    expect(() =>
      createGradingPageHtml({ blind: true, snapshotSha256: "not-a-sha" }),
    ).toThrow(/64-character hex/);

    const normal = await runPage({ blind: false, submit: true });
    const blind = await runPage({ blind: true, submit: true });
    expect(normal.requestBodies).toEqual([
      {
        grades: [
          expect.objectContaining({
            candidateId: "candidate-1",
            action: "promoted",
            reasonCode: expect.any(String),
            agentBehavior: "good",
          }),
        ],
      },
    ]);
    expect(normal.attachedIds).toEqual(
      expect.arrayContaining(["reasons", "behavior", "note"]),
    );
    expect(normal.attachedTexts).toContain("fixture-model");
    // The REM grade is a prediction nothing acts on
    // (docs/decisions/let-everything-pass-grading.md); the page says so.
    expect(normal.attachedTexts).toContain("machine prediction: rejected");
    expect(normal.hiddenIds).not.toEqual(
      expect.arrayContaining(["agent-behavior-stats", "post-send-tools"]),
    );
    expect(normal.notePlaceholder).toContain("candidate_grade.note");
    expect(blind.requestBodies).toEqual([
      {
        grades: [{ candidateId: "candidate-1", action: "promoted" }],
        snapshotSha256: SNAPSHOT_SHA256,
      },
    ]);
    expect(blind.attachedIds).toContain("note");
    expect(blind.attachedIds).not.toContain("reasons");
    expect(blind.attachedIds).not.toContain("behavior");
    expect(blind.attachedTexts).not.toContain("fixture-model");
    expect(blind.hiddenIds).toEqual(
      expect.arrayContaining([
        "agent-behavior-stats",
        "head-kind-stats",
        "post-send-tools",
      ]),
    );
    expect(blind.attachedTexts).toEqual(
      expect.arrayContaining([
        "Keep this exact frozen claim.",
        "seen 7x across 3 sessions",
        "Frozen candidate input",
      ]),
    );
    expect(blind.attachedTexts.join(" ")).not.toContain("No operator turn heads");
    expect(blind.attachedTexts.join(" ")).not.toContain("No source turns found");
    expect(blind.attachedTexts.join(" ")).not.toContain("? to ?");
    expect(blind.notePlaceholder).toBe("Optional note");
    await expectStorageIsolation();
  });
});
