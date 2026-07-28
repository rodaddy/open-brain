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
      // Supports only the two selectors the page uses: a bare tag name and
      // ".grades label". Anything else is a test-stub gap, not a silent [].
      const out: StubNode[] = [];
      const walk = (n: StubNode, underGrades: boolean): void => {
        for (const c of n.children) {
          const inGrades = underGrades || c.classList.contains("grades");
          if (sel === "input" && c.tagName === "INPUT") out.push(c);
          else if (sel === ".grades label" && inGrades && c.tagName === "LABEL")
            out.push(c);
          walk(c, inGrades);
        }
      };
      if (sel !== "input" && sel !== ".grades label") {
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
    getElementById: (id: string) => byId.get(id) ?? null,
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
    el: (id: string) => byId.get(id)!,
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
