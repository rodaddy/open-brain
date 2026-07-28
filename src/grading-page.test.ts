/**
 * Functional tests for the grading page's BEHAVIOR. Issue #394.
 *
 * WHY THIS FILE EXISTS AND WHY IT EXECUTES THE PAGE. The page shipped with only
 * string-containment assertions over its HTML (`expect(html).toContain(...)`),
 * and three real defects passed straight through them on 2026-07-28:
 *
 *  - "change this" in the history dialog ROTATED the grade
 *    (ORDER[(indexOf+1) % 4]) instead of letting the operator choose, so
 *    changing a `promoted` item silently staged `rejected`.
 *  - "edit" on a staged regrade was unreachable: it looked the candidate up in
 *    state.items, which comes from /api/queue and filters `reviewed_at IS NULL`,
 *    so an already-graded candidate was never in it and the item vanished into a
 *    queue reload.
 *  - the startup banner advertised a `u undo` key bound to nothing.
 *
 * Every one of those is invisible to a substring check and obvious the moment
 * the code runs. So these tests RUN it: the page's <script> is extracted and
 * evaluated against a DOM stub small enough to read, and the assertions are
 * about what the operator ends up with -- which grade got staged, whether the
 * item is on screen -- not about how the source is spelled.
 *
 * WHY A HAND-WRITTEN DOM STUB AND NOT jsdom/happy-dom. package.json carries 7
 * runtime dependencies and no UI framework, bundler, or test-DOM; the page is
 * deliberately one hand-written HTML string served with no build step. Pulling a
 * DOM implementation in as a devDependency to test ~40 lines of vanilla
 * createElement/append is a poor trade against the repo's "do not hand-roll
 * solved problems" rule read the other way -- the problem here is not "implement
 * the DOM", it is "call four methods". The stub below implements exactly the
 * surface the page touches and throws on anything else, so it cannot silently
 * diverge into a fake that passes tests a browser would fail.
 *
 * THE NETWORK IS THE ASSERTION. `fetch` is replaced with a recorder, which is
 * how the governing property of the rebuild -- nothing reaches the server until
 * SEND -- is stated as a fact rather than an inspection of the source.
 */

import { describe, expect, it } from "bun:test";
import { GRADING_PAGE_HTML } from "./grading-page.ts";

/** One node of the stub DOM. Only what the page actually calls. */
interface StubNode {
  /**
   * Directly-assigned text, if any.
   *
   * Undefined once children are appended, so `textContent` falls back to
   * concatenating them -- the two ways a real node reports its text.
   */
  _text: string | undefined;
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  type: string;
  name: string;
  placeholder: string;
  style: Record<string, string>;
  children: StubNode[];
  parent: StubNode | null;
  onclick: null | (() => void);
  onchange: null | (() => void);
  oninput: null | (() => void);
  onkeydown: null | ((e: unknown) => void);
  open: boolean;
  classList: {
    toggle: (c: string, on: boolean) => void;
    add: (c: string) => void;
    contains: (c: string) => boolean;
  };
  append: (...nodes: StubNode[]) => void;
  querySelector: (sel: string) => StubNode | null;
  querySelectorAll: (sel: string) => StubNode[];
  showModal: () => void;
  close: () => void;
  focus: () => void;
  blur: () => void;
  addEventListener: (type: string, fn: (e: unknown) => void) => void;
}

function makeNode(tagName: string): StubNode {
  const node: StubNode = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    // `textContent = ""` is how the page CLEARS a container before a re-render,
    // so assigning it must drop the children or every render would append.
    get textContent(): string {
      return node._text ?? node.children.map((c) => c.textContent).join("");
    },
    set textContent(v: string) {
      // A browser coerces whatever it is handed to a string, and the page does
      // assign numbers (counts). Coercing here keeps the stub honest instead of
      // letting a test see a type the real DOM would never produce.
      node._text = String(v);
      node.children = [];
    },
    value: "",
    checked: false,
    disabled: false,
    title: "",
    type: "",
    name: "",
    placeholder: "",
    style: {},
    children: [],
    parent: null,
    onclick: null,
    onchange: null,
    oninput: null,
    onkeydown: null,
    open: false,
    classList: {
      toggle: (c: string, on: boolean) => {
        const set = new Set(node.className.split(" ").filter(Boolean));
        if (on) set.add(c);
        else set.delete(c);
        node.className = [...set].join(" ");
      },
      add: (c: string) => node.classList.toggle(c, true),
      contains: (c: string) => node.className.split(" ").includes(c),
    },
    append: (...nodes: StubNode[]) => {
      node._text = undefined;
      for (const n of nodes) {
        n.parent = node;
        node.children.push(n);
      }
    },
    querySelector: (sel: string) => node.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => {
      // Supports only the selectors the page uses: bare tag names and
      // ".grades label". Anything else is a test-stub gap, not a silent [].
      // "label" (bare) was added for the agent-behavior block, whose radios the
      // page repaints the same way it repaints the grade radios.
      const out: StubNode[] = [];
      const walk = (n: StubNode, underGrades: boolean): void => {
        for (const c of n.children) {
          const inGrades = underGrades || c.classList.contains("grades");
          if (sel === "input" && c.tagName === "INPUT") out.push(c);
          else if (sel === "label" && c.tagName === "LABEL") out.push(c);
          else if (sel === ".grades label" && inGrades && c.tagName === "LABEL")
            out.push(c);
          walk(c, inGrades);
        }
      };
      if (sel !== "input" && sel !== "label" && sel !== ".grades label") {
        throw new Error("stub DOM: unsupported selector " + sel);
      }
      walk(node, node.classList.contains("grades"));
      return out;
    },
    showModal: () => {
      node.open = true;
    },
    close: () => {
      node.open = false;
    },
    focus: () => {},
    blur: () => {},
    addEventListener: () => {},
  } as unknown as StubNode;
  return node;
}

/** Depth-first search for a node by id, over what the page has built. */
function findById(node: StubNode, id: string): StubNode | null {
  for (const c of node.children) {
    if (c.id === id) return c;
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

interface PageHarness {
  /** Fires a click on the first descendant button whose label matches. */
  clickButton: (root: StubNode, text: string) => void;
  /**
   * Picks a grade on the card.
   *
   * The grades are real radio inputs wrapped in styled labels, not buttons --
   * deliberately, so the selection is keyboard- and screen-reader-addressable.
   * Selecting one fires the radio's change handler, which is what a click on
   * the label does in a browser.
   */
  pickGrade: (label: string) => void;
  el: (id: string) => StubNode;
  fetches: Array<{ path: string; method: string; body: unknown }>;
  store: Map<string, string>;
  flush: () => Promise<void>;
}

/**
 * Evaluate the page's script against a stub DOM and hand back a harness.
 *
 * `queue` and `history` are the two payloads the page reads. Both default to
 * empty so a test states only what it depends on.
 */
async function loadPage(
  options: {
    queue?: unknown[];
    historyItems?: unknown[];
  } = {},
): Promise<PageHarness> {
  const script = GRADING_PAGE_HTML.slice(
    GRADING_PAGE_HTML.indexOf("<script>") + "<script>".length,
    GRADING_PAGE_HTML.lastIndexOf("</script>"),
  );

  const byId = new Map<string, StubNode>();
  // The elements the page's markup declares and its script looks up by id.
  for (const id of [
    "pos",
    "ungraded",
    "graded",
    "staged-count",
    "sent-count",
    "a-promoted",
    "a-rejected",
    "a-inconclusive",
    "a-duplicate",
    "agree",
    "b-good",
    "b-bad",
    "b-neutral",
    "mode-label",
    "stage",
    "batch-n",
    "batch-list",
    "send",
    "clear-batch",
    "undo-batch",
    "open-history",
    "last-batch",
    "msg",
    "history",
    "hist-total",
    "hist-msg",
    "hist-close",
    "hist-list",
  ]) {
    const n = makeNode(id === "history" ? "dialog" : "div");
    n.id = id;
    byId.set(id, n);
  }

  const fetches: PageHarness["fetches"] = [];
  const store = new Map<string, string>();

  // A document-wide query walks everything the page has built, which is every
  // element it registered by id. paintGrades() uses this to repaint the radio
  // selection without re-rendering the card (so typing a note is never cut off).
  const root = makeNode("body");
  root.append(...byId.values());

  const document = {
    // Looks in the declared markup first, then in what the page BUILT. The card
    // is created at render time and its inner controls (#note, #reasons,
    // #behavior) are looked up by id afterwards -- exactly as they are in a
    // browser, where the document sees an element the moment it is in the tree.
    // Without this the reason row and the behavior radios are invisible to the
    // page's own paint functions and every assertion about them would pass
    // vacuously against a card that never wired them up.
    getElementById: (id: string) => byId.get(id) ?? findById(root, id),
    createElement: (tag: string) => makeNode(tag),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    addEventListener: () => {},
  };

  const fetchStub = async (path: string, init?: RequestInit) => {
    fetches.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = path.startsWith("/api/stats")
      ? {
          ungraded: 1104,
          graded: 0,
          by_action: {
            promoted: 0,
            rejected: 0,
            inconclusive: 0,
            duplicate: 0,
          },
          machine_agreement: {
            compared: 0,
            agreed: 0,
            rate: null,
            distinct_machine_grades: 0,
          },
          by_reason_code: {},
          agent_behavior: { rated: 0, by_value: {} },
        }
      : path.startsWith("/api/history")
        ? {
            total: options.historyItems?.length ?? 0,
            items: options.historyItems ?? [],
          }
        : path.startsWith("/api/queue") || path.startsWith("/api/inconclusive")
          ? { items: options.queue ?? [], total: (options.queue ?? []).length }
          : { results: [], batch_id: null };
    return { ok: true, status: 200, json: async () => body };
  };

  const fn = new Function(
    "document",
    "localStorage",
    "fetch",
    "window",
    "confirm",
    "alert",
    script,
  );
  fn(
    document,
    {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    fetchStub,
    { addEventListener: () => {} },
    () => true,
    () => {},
  );

  const flush = async (): Promise<void> => {
    // The page's boot calls loadPage(), which awaits two fetches. Yielding a few
    // microtask turns lets those settle before a test inspects the DOM.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  await flush();

  const clickButton = (root: StubNode, text: string): void => {
    const found: StubNode[] = [];
    const walk = (n: StubNode): void => {
      for (const c of n.children) {
        if (c.tagName === "BUTTON" && c.textContent === text) found.push(c);
        walk(c);
      }
    };
    walk(root);
    if (found.length === 0) {
      throw new Error("no button labelled " + JSON.stringify(text));
    }
    found[0]!.onclick?.();
  };

  const pickGrade = (label: string): void => {
    const labels = byId
      .get("stage")!
      .querySelectorAll(".grades label")
      .filter((l) => l.textContent.startsWith(label));
    if (labels.length === 0) {
      throw new Error("no grade labelled " + JSON.stringify(label));
    }
    labels[0]!.querySelector("input")!.onchange?.();
  };

  return {
    clickButton,
    pickGrade,
    // Same fall-through as document.getElementById: declared markup first, then
    // whatever the page BUILT. The card's own controls (#note, #reasons,
    // #behavior) only exist after a render.
    el: (id: string) => {
      const found = byId.get(id) ?? findById(root, id);
      if (!found) throw new Error("no element with id " + JSON.stringify(id));
      return found;
    },
    fetches,
    store,
    flush,
  };
}

const GRADED_ITEM = {
  grade_id: "99999999-9999-4999-8999-999999999999",
  candidate_id: "11111111-1111-4111-8111-111111111111",
  action: "promoted",
  note: "first call",
  graded_by: "rico",
  batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created_at: "2026-07-28T06:00:00.000Z",
  superseded_at: null,
  candidate_type: "decision",
  content: "switched both hooks to the new host",
  uncertain: true,
  uncertainty_reason: "bare ack -- unclear whether it states anything durable",
  machine_grade: "inconclusive",
};

const QUEUE_ITEM = {
  id: "22222222-2222-4222-8222-222222222222",
  // The original per-speech-turn unit (041). A fragment has no operator head,
  // and the page must not invent one for it.
  unit_kind: "fragment",
  anchor_turn_id: null,
  operator_text: null,
  candidate_type: "decision",
  content: "the distiller runs before Light",
  uncertain: false,
  uncertainty_reason: null,
  authority_tier: null,
  model: null,
  machine_grade: null,
  source_turn_ids: ["33333333-3333-4333-8333-333333333333"],
  context: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      role: "user",
      content: "does the distiller run first?",
      session_ref: "s1",
      session_seq: 1,
      repo: "open-brain",
      occurred_at: "2026-07-28T00:00:00.000Z",
      is_human_prompt: true,
      is_source: true,
    },
  ],
  reinforcement: null,
};

/**
 * An operator-anchored EXCHANGE (migration 041), built from the real defect.
 *
 * The operator's turn is the one he actually typed; the agent sentence below is
 * the one the old distiller made him grade instead. Using the real pair is what
 * makes the ordering assertion mean something -- it is the exact screen he
 * complained about.
 */
const EXCHANGE_ITEM = {
  id: "44444444-4444-4444-8444-444444444444",
  unit_kind: "exchange",
  anchor_turn_id: "55555555-5555-4555-8555-555555555555",
  operator_text:
    "I can't decide whether the DreamEngine curation logic should move to " +
    "TypeScript now or wait until after drizzle...",
  candidate_type: "decision",
  content:
    "Drizzle isn't a dependency and there's no config -- planned, not in progress",
  uncertain: false,
  uncertainty_reason: null,
  authority_tier: null,
  model: null,
  machine_grade: null,
  source_turn_ids: ["55555555-5555-4555-8555-555555555555"],
  context: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      role: "assistant",
      content:
        "Drizzle isn't a dependency and there's no config -- planned, not in progress",
      session_ref: "s2",
      session_seq: 9,
      repo: "open-brain",
      occurred_at: "2026-07-28T01:00:00.000Z",
      is_human_prompt: false,
      is_source: false,
    },
  ],
  reinforcement: null,
};

/**
 * Pick an agent-behavior rating by its visible label.
 *
 * Its own helper rather than a parameter on pickGrade, because the two are
 * deliberately different controls in different radio groups -- a shared helper
 * would be the test agreeing with a merge the design refuses.
 */
function pickBehavior(page: PageHarness, label: string): void {
  const box = page.el("behavior");
  const found = box
    .querySelectorAll("label")
    .filter((l) => l.textContent.includes(label));
  if (found.length === 0) {
    throw new Error("no behavior labelled " + JSON.stringify(label));
  }
  found[0]!.querySelector("input")!.onchange?.();
}

/** Collect every button label under a node, in document order. */
function buttonLabels(node: StubNode): string[] {
  const out: string[] = [];
  const walk = (n: StubNode): void => {
    for (const c of n.children) {
      if (c.tagName === "BUTTON") out.push(c.textContent);
      walk(c);
    }
  };
  walk(node);
  return out;
}

describe("nothing reaches the server until SEND", () => {
  it("stages a grade with no network write at all", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    const before = page.fetches.filter((f) => f.method === "POST").length;
    expect(before).toBe(0);

    // Select a grade, then stage it. Both are the operator's real gestures.
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "Add to batch");

    // The judgement exists locally...
    expect(page.el("batch-n").textContent).toBe("1");
    expect(page.store.get("ob.grading.batch.v1")).toContain(QUEUE_ITEM.id);
    // ...and NOTHING was posted. This is the property the whole rebuild is for.
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);
  });

  it("sends the staged batch as one POST when SEND is pressed", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("fail");
    page.clickButton(page.el("stage"), "Add to batch");
    page.el("send").onclick?.();
    await page.flush();

    const posts = page.fetches.filter((f) => f.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/grade-batch");
    const body = posts[0]!.body as { grades: Array<Record<string, unknown>> };
    expect(body.grades).toHaveLength(1);
    expect(body.grades[0]).toMatchObject({
      candidateId: QUEUE_ITEM.id,
      action: "rejected",
    });
  });
});

describe("the pending batch is visible and editable", () => {
  it("shows what is staged and can remove one without sending", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("inconclusive");
    page.clickButton(page.el("stage"), "Add to batch");
    // The claim itself is on screen, not just a uuid.
    expect(page.el("batch-list").textContent).toContain(
      "the distiller runs before Light",
    );

    page.clickButton(page.el("batch-list"), "remove");
    expect(page.el("batch-n").textContent).toBe("0");
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);
  });
});

describe("changing a grade from the history dialog", () => {
  it("stages the grade the operator PICKED, not the next one in a rotation", async () => {
    // THE DEFECT. This used to be ORDER[(indexOf(action)+1) % 4]: "change this"
    // on a `promoted` item staged `rejected` without asking. The operator's
    // requirement was "a way to reset, undo, change i needed" -- a rotation is
    // not a change.
    const page = await loadPage({ historyItems: [GRADED_ITEM] });
    page.el("open-history").onclick?.();
    await page.flush();

    // Every grade except the current one is offered by name.
    const labels: string[] = [];
    const walk = (n: StubNode): void => {
      for (const c of n.children) {
        if (c.tagName === "BUTTON") labels.push(c.textContent);
        walk(c);
      }
    };
    walk(page.el("hist-list") as unknown as StubNode);
    expect(labels).toContain("fail");
    expect(labels).toContain("inconclusive");
    expect(labels).toContain("duplicate");
    // Not the grade it already has -- re-staging an identical value would
    // supersede a row with a copy of itself.
    expect(labels).not.toContain("pass");

    // Pick "duplicate" explicitly. A rotation from `promoted` would give
    // `rejected`, so this assertion fails on the old code.
    page.clickButton(page.el("hist-list"), "duplicate");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      candidateId: string;
      action: string;
    }>;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.action).toBe("duplicate");
    expect(staged[0]!.candidateId).toBe(GRADED_ITEM.candidate_id);
    // Still nothing sent: a regrade goes through the same staged batch.
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);
  });

  it("keeps a staged regrade editable instead of dropping it into a queue reload", async () => {
    // THE SECOND DEFECT. `edit` looked the candidate up in state.items, which
    // comes from /api/queue and filters `reviewed_at IS NULL`. An already-graded
    // candidate is by definition absent from it, so the lookup always missed and
    // the item disappeared into a loadPage() reload -- leaving `remove` as the
    // only working control on a regrade whose grade was wrong.
    const page = await loadPage({
      queue: [QUEUE_ITEM],
      historyItems: [GRADED_ITEM],
    });
    page.el("open-history").onclick?.();
    await page.flush();
    page.clickButton(page.el("hist-list"), "fail");
    expect(page.el("batch-n").textContent).toBe("1");

    const fetchesBefore = page.fetches.length;
    page.clickButton(page.el("batch-list"), "edit");

    // It came OUT of the batch and ONTO the card, with its own content -- not a
    // reload, and not a vanished item.
    expect(page.el("batch-n").textContent).toBe("0");
    expect(page.el("stage").textContent).toContain(
      "switched both hooks to the new host",
    );
    // The card says it is a regrade and what the previous answer was.
    expect(page.el("stage").textContent).toContain("regrade");
    // No queue reload was triggered to find it.
    expect(page.fetches).toHaveLength(fetchesBefore);

    // And it can be re-staged with a different grade, which is the whole point.
    page.pickGrade("inconclusive");
    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      action: string;
    }>;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.action).toBe("inconclusive");
  });

  it("carries the distiller's reason onto the regrade card without overwriting it", async () => {
    // The note and the distiller's reason are two authors' words (040). A
    // regrade must show the machine's doubt, and the operator's own note stays
    // separate.
    const page = await loadPage({ historyItems: [GRADED_ITEM] });
    page.el("open-history").onclick?.();
    await page.flush();
    page.clickButton(page.el("hist-list"), "fail");
    page.clickButton(page.el("batch-list"), "edit");
    expect(page.el("stage").textContent).toContain("distiller doubted this");
    expect(page.el("stage").textContent).toContain(
      "bare ack -- unclear whether it states anything durable",
    );
  });
});

describe("reset", () => {
  it("clears the picked grade without staging or sending anything", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "Reset form");

    // The item is still on the card and nothing was sent...
    expect(page.el("batch-n").textContent).toBe("0");
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);
    expect(page.el("stage").textContent).toContain(
      "the distiller runs before Light",
    );
    // ...and the SELECTION is genuinely gone, which is the thing reset is for.
    // Proven by consequence rather than by reading a CSS class: staging now has
    // no grade to stage, so it is refused.
    page.clickButton(page.el("stage"), "Add to batch");
    expect(page.el("batch-n").textContent).toBe("0");
    expect(page.el("msg").textContent).toContain("pick a grade first");
  });

  it("refuses to stage with no grade picked, rather than guessing one", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.clickButton(page.el("stage"), "Add to batch");
    expect(page.el("batch-n").textContent).toBe("0");
    expect(page.el("msg").textContent).toContain("pick a grade first");
  });
});

describe("the operator's words lead an exchange", () => {
  it("puts operator_text ABOVE the distilled claim and the agent turns", async () => {
    // THE DEFECT 041 EXISTS FOR, stated as an ordering fact. The operator hit
    // this live: he was asked to grade the AGENT's "Drizzle isn't a
    // dependency..." while his own turn sat in the context panel below. His
    // instruction was verbatim -- "my part of the conversation should be the
    // first thing, anything below that can be agent response and maybe tool
    // calls to get there" -- so position, not mere presence, is the assertion.
    const page = await loadPage({ queue: [EXCHANGE_ITEM] });
    const rendered = page.el("stage").textContent;

    const opAt = rendered.indexOf("I can't decide whether the DreamEngine");
    const claimAt = rendered.indexOf("Drizzle isn't a dependency");
    expect(opAt).toBeGreaterThanOrEqual(0);
    expect(claimAt).toBeGreaterThanOrEqual(0);
    // Strictly above. Reversing the two blocks in render() fails here.
    expect(opAt).toBeLessThan(claimAt);
    // And it is labelled as his, not presented as one more quoted turn.
    expect(rendered).toContain("you asked");
    // The agent activity is named as the body of the exchange.
    expect(rendered).toContain("what the agent did about it");
  });

  it("does NOT fabricate an operator head for a fragment", async () => {
    // Putting agent text in the lead position is precisely the defect. A
    // fragment has no operator turn, so the lead block must be absent rather
    // than filled with whatever text is nearest.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    const rendered = page.el("stage").textContent;
    expect(rendered).toContain("the distiller runs before Light");
    expect(rendered).not.toContain("you asked");
    expect(rendered).toContain("source turns and surrounding conversation");
  });

  it("says so when an exchange has no operator turn at its head", async () => {
    // Orphan exchanges (17 of 289, measured 2026-07-28) are captured, not
    // dropped. Rendering one exactly like an anchored exchange would hide that
    // the head -- the reason it ranks lower -- is missing.
    const orphan = {
      ...EXCHANGE_ITEM,
      anchor_turn_id: null,
      operator_text: null,
    };
    const page = await loadPage({ queue: [orphan] });
    expect(page.el("stage").textContent).toContain(
      "No operator turn heads this exchange",
    );
  });
});

describe("canned reasons fill the note without replacing it", () => {
  it("shows no reasons until a grade is picked, then only that grade's", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    expect(page.el("stage").textContent).toContain(
      "pick a grade to see quick reasons",
    );

    page.pickGrade("fail");
    const onReject = buttonLabels(page.el("stage"));
    // 'progress narration' applies to rejected...
    expect(onReject).toContain("progress narration");
    // ...and 'fixes an issue' does not: it is a promote reason. Offering all
    // twelve on every card is the version that gets ignored.
    expect(onReject).not.toContain("fixes an issue");

    page.pickGrade("pass");
    const onPromote = buttonLabels(page.el("stage"));
    expect(onPromote).toContain("fixes an issue");
    expect(onPromote).not.toContain("progress narration");
  });

  it("INSERTS the reason text into the note, editable, and records the code", async () => {
    // The operator's requirement, verbatim: "so the can'd response if i click
    // one, should allow me to put it into the notes for adjustment and/or the
    // note section stays to allow me to add a little color".
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "states a fact");

    const note = page.el("note");
    // The text is IN the textarea, which still exists and is still editable.
    expect(note.tagName).toBe("TEXTAREA");
    expect(note.value).toContain("States a durable fact worth remembering.");

    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      note: string;
      reasonCode: string;
    }>;
    expect(staged[0]!.reasonCode).toBe("states-fact");
    expect(staged[0]!.note).toContain("States a durable fact");
  });

  it("EDITING THE NOTE DOES NOT CLEAR THE CODE", async () => {
    // The requirement the whole two-column design turns on. The operator clicks
    // a reason to get a starting sentence, then rewrites it -- and the code must
    // survive, because after the edit it is the only thing that still says why.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "states a fact");

    const note = page.el("note");
    note.value = "actually it's the deploy host that matters here";
    note.oninput?.();

    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      note: string;
      reasonCode: string;
    }>;
    // The text is entirely the operator's...
    expect(staged[0]!.note).toBe(
      "actually it's the deploy host that matters here",
    );
    expect(staged[0]!.note).not.toContain("durable fact");
    // ...and the code is still there.
    expect(staged[0]!.reasonCode).toBe("states-fact");
  });

  it("APPENDS a second reason rather than replacing the first", async () => {
    // Replacing would destroy both the first sentence and whatever colour the
    // operator had already typed after it.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "states a fact");
    page.clickButton(page.el("stage"), "shows reasoning");

    const note = page.el("note");
    expect(note.value).toContain("States a durable fact");
    expect(note.value).toContain("Shows the logic behind the decision");
  });

  it("keeps the operator's own typing when a reason is added after it", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    const note = page.el("note");
    note.value = "my own words first.";
    note.oninput?.();
    page.clickButton(page.el("stage"), "states a fact");
    expect(page.el("note").value).toContain("my own words first.");
    expect(page.el("note").value).toContain("States a durable fact");
  });

  it("sends the reason code to the server on the batch POST", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("fail");
    page.clickButton(page.el("stage"), "progress narration");
    page.clickButton(page.el("stage"), "Add to batch");
    page.el("send").onclick?.();
    await page.flush();

    const post = page.fetches.find((f) => f.path === "/api/grade-batch")!;
    const body = post.body as { grades: Array<Record<string, unknown>> };
    expect(body.grades[0]!.reasonCode).toBe("progress-narration");
  });

  it("does not post anything when a reason is clicked", async () => {
    // A reason is an accelerator, not a submitter -- the same rule the grade
    // keys follow. Nothing reaches the server until SEND.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "states a fact");
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);
  });
});

describe("the agent-behavior axis is separate and optional", () => {
  it("is present, labelled as a different question, and not part of the grade", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    const rendered = page.el("stage").textContent;
    expect(rendered).toContain("separate question -- agent behavior");
    expect(rendered).toContain("agent did well");
    expect(rendered).toContain("agent did wrong");
    expect(rendered).toContain("unremarkable");
  });

  it("stages WITHOUT a behavior rating -- it is optional", async () => {
    // Grading the memory is the job; rating the agent is colour. A form that
    // refused to stage without it would make the second axis a tax on the first.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      agentBehavior: string | null;
    }>;
    expect(staged).toHaveLength(1);
    // Null, NOT "neutral". Unrated and rated-unremarkable are different facts.
    expect(staged[0]!.agentBehavior).toBeNull();
  });

  it("records a rating when one is given, alongside an unrelated grade", async () => {
    // THE COMBINATION ONE COLUMN COULD NOT EXPRESS: the memory is worth keeping
    // AND the agent got it wrong. That pairing is why 042 split the axes.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    pickBehavior(page, "agent did wrong");
    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      action: string;
      agentBehavior: string;
    }>;
    expect(staged[0]!.action).toBe("promoted");
    expect(staged[0]!.agentBehavior).toBe("bad");
  });

  it("can be un-rated again, because an accidental click must be undoable", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("pass");
    pickBehavior(page, "agent did well");
    page.clickButton(page.el("stage"), "not rated");
    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      agentBehavior: string | null;
    }>;
    expect(staged[0]!.agentBehavior).toBeNull();
  });

  it("does not disturb the memory grade", async () => {
    // Separate radio groups. Sharing the group name would let picking a
    // behavior deselect the grade -- one control wearing two labels, which is
    // exactly the merge 042 exists to prevent.
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("inconclusive");
    pickBehavior(page, "agent did well");
    page.clickButton(page.el("stage"), "Add to batch");
    const staged = JSON.parse(page.store.get("ob.grading.batch.v1")!) as Array<{
      action: string;
      agentBehavior: string;
    }>;
    expect(staged[0]!.action).toBe("inconclusive");
    expect(staged[0]!.agentBehavior).toBe("good");
  });

  it("sends the rating on the batch POST and posts nothing before SEND", async () => {
    const page = await loadPage({ queue: [QUEUE_ITEM] });
    page.pickGrade("fail");
    pickBehavior(page, "agent did wrong");
    expect(page.fetches.filter((f) => f.method === "POST")).toHaveLength(0);

    page.clickButton(page.el("stage"), "Add to batch");
    page.el("send").onclick?.();
    await page.flush();
    const post = page.fetches.find((f) => f.path === "/api/grade-batch")!;
    const body = post.body as { grades: Array<Record<string, unknown>> };
    expect(body.grades[0]!.agentBehavior).toBe("bad");
  });
});
