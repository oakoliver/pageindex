/**
 * Tests for behavior ported from upstream PageIndex v0.2.19 -> v0.5.0.
 * Most are ports of upstream's own tests (tests/test_tree_format.py,
 * tests/test_client.py, tests/test_package_surface.py); the LLM is a scripted
 * fake client, so no API key or network is needed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { APIConnectionError } from "openai";
import {
  chatGPTWithFinishReason,
  LLMRetriesExhausted,
  INDEX_MAX_DELAY,
  INDEX_RETRIES,
  retryAfter,
  retryDelay,
  setRetrySleep,
  shouldRetry,
} from "../src/openai";
import {
  coverSubtreeRanges,
  createNodeMapping,
  getNode,
  getNodeMap,
  getNodeParent,
  getNodePath,
  introTitle,
  ownPages,
  postProcessing,
} from "../src/utils";
import { addIntroNodes, headingAtPageStart, mergeTree } from "../src/tree-optimize";
import {
  addNodeText,
  fixIncorrectToc,
  generateDocDescription,
  processLargeNodeRecursively,
  verifyToc,
  type TreeOptions,
} from "../src/tree";
import { checkTitleAppearanceInStartConcurrent } from "../src/toc";
import { summarizeTree, fallbackSummary } from "../src/summary";
import { leafSummaryPrompt, parentSummaryPrompt, pyJsonList } from "../src/prompts";
import { PageIndex } from "../src/pageindex";
import { DEFAULT_INDEX_MODEL, type TocItem, type TreeNode } from "../src/types";
import type { PdfPage } from "../src/pdf";
import { calls, httpError, pagesOf, resetFakeLLM, useFakeLLM } from "./helpers/fake-llm";
import upstreamPrompts from "./fixtures/upstream-summary-prompts.json";

const options: TreeOptions = {
  model: "m",
  tocCheckPageNum: 20,
  maxPageNumEachNode: 10,
  maxTokenNumEachNode: 20000,
  addNodeId: true,
  addNodeSummary: false,
  addDocDescription: false,
  addNodeText: false,
  logger: () => {},
};

/** [title, start, end] for every node, in document order */
function shape(nodes: TreeNode[]): Array<[string, number | undefined, number | undefined]> {
  const out: Array<[string, number | undefined, number | undefined]> = [];
  const walk = (list: TreeNode[]) =>
    list.forEach((n) => {
      out.push([n.title, n.startIndex, n.endIndex]);
      walk(n.nodes ?? []);
    });
  walk(nodes);
  return out;
}

const all = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((n) => [n, ...all(n.nodes ?? [])]);

let slept: number[] = [];
const quietError = console.error;

beforeEach(() => {
  slept = [];
  setRetrySleep(async (ms) => {
    slept.push(ms);
  });
  console.error = () => {};
});

afterEach(() => {
  resetFakeLLM();
  setRetrySleep(null);
  console.error = quietError;
});

// ---------------------------------------------------------------------------
// Retries follow the official SDK rule (upstream retry.py, v0.5.0)
// ---------------------------------------------------------------------------

describe("retry rule", () => {
  test.each([408, 409, 429, 500, 503, 529])("HTTP %d is retried", (status) => {
    expect(shouldRetry(httpError(status))).toBe(true);
  });

  test.each([402, 413, 422])("HTTP %d is not retried", (status) => {
    expect(shouldRetry(httpError(status))).toBe(false);
  });

  test("x-should-retry overrides the status", () => {
    expect(shouldRetry(httpError(503, { "x-should-retry": "false" }))).toBe(false);
    expect(shouldRetry(httpError(422, { "x-should-retry": "true" }))).toBe(true);
  });

  test("a transport failure is retried; an error raised before sending is not", () => {
    expect(shouldRetry(new APIConnectionError({ message: "refused" }))).toBe(true);
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(shouldRetry(new Error("wrapped", { cause: reset }))).toBe(true);
    expect(shouldRetry(new TypeError("fetch failed"))).toBe(true);
    expect(shouldRetry(new Error("Missing credentials"))).toBe(false);
  });

  test.each([
    [{ "retry-after": "7" }, 7],
    [{ "retry-after-ms": "1500", "retry-after": "7" }, 1.5],
    [{ "retry-after": "120" }, null],
    [{ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, null],
    [{}, null],
  ] as Array<[Record<string, string>, number | null]>)("Retry-After %j waits %p", (headers, wait) => {
    const h = new Headers(headers);
    expect(retryAfter(h)).toBe(wait);
    if (wait !== null) {
      expect(retryDelay(3, h, INDEX_MAX_DELAY)).toBe(wait);
    }
  });

  test("backoff doubles up to the cap, jittered down to half", () => {
    const caps = Array.from({ length: INDEX_RETRIES }, (_, i) => Math.min(INDEX_MAX_DELAY, 2 ** i));
    const waits = caps.map((_, i) => retryDelay(i, undefined, INDEX_MAX_DELAY));
    waits.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(caps[i]! / 2);
      expect(w).toBeLessThanOrEqual(caps[i]!);
    });
    expect(INDEX_RETRIES).toBe(9);
    expect(INDEX_MAX_DELAY).toBe(30);
  });

  test("a rate limit is tried 10 times, waiting as the server asks", async () => {
    useFakeLLM(() => {
      throw httpError(429, { "retry-after": "7" });
    });
    const error = await chatGPTWithFinishReason({ model: "m", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(LLMRetriesExhausted);
    expect(error.statusCode).toBe(429);
    expect(error.message).toStartWith("LLM completion failed after 10 attempts:");
    expect(calls.length).toBe(10);
    expect(slept).toEqual(Array(9).fill(7000));
  });

  test("a status no retry can fix fails at once", async () => {
    useFakeLLM(() => {
      throw httpError(422);
    });
    const error = await chatGPTWithFinishReason({ model: "m", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(LLMRetriesExhausted);
    expect(error.statusCode).toBe(422);
    expect(error.message).toStartWith("LLM completion failed: ");
    expect(calls.length).toBe(1);
    expect(slept).toEqual([]);
  });

  test("a reply without choices is tried again", async () => {
    let n = 0;
    useFakeLLM(() => (n++ === 0 ? { choices: [] } : "ok"));
    const result = await chatGPTWithFinishReason({ model: "m", prompt: "p" });
    expect(result.content).toBe("ok");
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Standard-mode checks stop on a call out of retries (upstream v0.5.0)
// ---------------------------------------------------------------------------

describe("standard checks and fatal errors", () => {
  const pages = pagesOf(["Alpha starts here", "Beta starts here"]);
  const toc = (): TocItem[] => [
    { title: "Alpha", physicalIndex: 1 },
    { title: "Beta", physicalIndex: 2 },
  ];
  const runs: Record<string, () => Promise<unknown>> = {
    start: () => checkTitleAppearanceInStartConcurrent(toc(), pages, options),
    verify: () => verifyToc(pages, toc(), 1, options),
    fix: () =>
      fixIncorrectToc(toc(), pages, [{ listIndex: 1, title: "Beta", physicalIndex: 1 }], 1, options),
  };

  for (const check of Object.keys(runs)) {
    test(`${check}: a call out of retries stops the run; a 400 stays the item's own miss`, async () => {
      useFakeLLM(() => {
        throw httpError(429);
      });
      await expect(runs[check]!()).rejects.toBeInstanceOf(LLMRetriesExhausted);

      useFakeLLM(() => {
        throw httpError(400);
      });
      await runs[check]!();
    });
  }

  test("a fix replaces the page only once its check confirms it", async () => {
    useFakeLLM((prompt) =>
      prompt.includes("find the physical index of the start page")
        ? '{"physical_index": "<physical_index_2>"}'
        : '{"answer": "no"}'
    );
    const items = toc();
    items[1]!.physicalIndex = 1;
    const { fixed, stillIncorrect } = await fixIncorrectToc(
      items,
      pages,
      [{ listIndex: 1, title: "Beta", physicalIndex: 1 }],
      1,
      options
    );
    expect(fixed[1]!.physicalIndex).toBe(1);
    expect(stillIncorrect).toEqual([{ listIndex: 1, title: "Beta", physicalIndex: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// One tree shape: intro nodes, covering ranges (upstream v0.2.21 / v0.2.22)
// ---------------------------------------------------------------------------

describe("intro nodes and ranges", () => {
  test("an intro node holds the pages a parent opens with", () => {
    const lines: string[][] = Array.from({ length: 40 }, () => ["body"]);
    lines[11] = ["3.1 Scope", "body"]; // 3.1 opens its page, 4.1 starts mid-page
    const tree: TreeNode[] = [
      {
        title: "Ch 3",
        startIndex: 10,
        endIndex: 30,
        nodes: [
          { title: "3.1 Scope", startIndex: 12, endIndex: 20 },
          { title: "3.2", startIndex: 21, endIndex: 30, nodes: [{ title: "3.2.1", startIndex: 21, endIndex: 30 }] },
        ],
      },
      { title: "", startIndex: 31, endIndex: 40, nodes: [{ title: "4.1", startIndex: 33, endIndex: 40 }] },
    ];

    addIntroNodes(tree, lines);

    expect(shape(tree)).toEqual([
      ["Ch 3", 10, 30],
      ["Ch 3 (intro)", 10, 11],
      ["3.1 Scope", 12, 20],
      ["3.2", 21, 30],
      ["3.2.1", 21, 30], // a first child on its parent's page: no intro
      ["", 31, 40],
      ["Intro", 31, 33],
      ["4.1", 33, 40],
    ]);
    expect(shape(addIntroNodes(structuredClone(tree), lines))).toEqual(shape(tree));
    // without page lines (the standard pipeline) a parent's intro ends on its first child's page
    const split: TreeNode[] = [
      { title: "Ch 3 (intro)", startIndex: 10, endIndex: 11, nodes: [{ title: "Background", startIndex: 12, endIndex: 14 }] },
    ];
    expect(shape(addIntroNodes(split))[1]).toEqual(["Ch 3 (intro)", 10, 11]);
    // a heading with nothing to match cannot be placed on its page, so the page is shared
    expect(headingAtPageStart([["第一章 总则"]], 1, "第一章 总则")).toBe(false);
    // nor can digits alone, which may be a page number
    expect(headingAtPageStart([["2", "Body text"]], 1, "2")).toBe(false);
    // a running header repeated further down does not open the page
    expect(headingAtPageStart([["Annual Report", "x", "Annual Report"]], 1, "Annual Report")).toBe(false);
    expect(introTitle("  ")).toBe("Intro");
  });

  test("merge folds an intro without listing its title", () => {
    const tree: TreeNode[] = [
      {
        title: "P",
        startIndex: 1,
        endIndex: 4,
        nodes: [
          { title: "P (intro)", startIndex: 1, endIndex: 1 },
          { title: "C", startIndex: 2, endIndex: 4 },
        ],
      },
    ];
    mergeTree(tree);
    expect(tree[0]!.nodes).toBeUndefined();
    expect(tree[0]!.keyItems).toEqual(["C"]);
  });

  test("a TOC item whose page the next opens still ends on its own page", () => {
    const items = [
      { structure: "1", title: "Overview", physicalIndex: 5 },
      { structure: "2", title: "Scope", physicalIndex: 5, appearStart: "yes" },
      { structure: "3", title: "Terms", physicalIndex: 9 },
      { structure: "4", title: "Annex", physicalIndex: 8 }, // listed out of order
    ];
    expect(shape(postProcessing(items, 12))).toEqual([
      ["Overview", 5, 5],
      ["Scope", 5, 9],
      ["Terms", 9, 9],
      ["Annex", 8, 12],
    ]);
  });

  test("a parent's own text stops at its first child, and is empty under an intro", () => {
    const pages = pagesOf(["Opening words", "Alpha body", "Beta body"]);
    const tree: TreeNode[] = [
      {
        title: "Report",
        startIndex: 1,
        endIndex: 1,
        nodes: [
          { title: "Report (intro)", startIndex: 1, endIndex: 1 },
          {
            title: "Alpha",
            startIndex: 2,
            endIndex: 2,
            nodes: [
              { title: "Alpha one", startIndex: 2, endIndex: 2 },
              { title: "Alpha two", startIndex: 3, endIndex: 3 },
            ],
          },
        ],
      },
    ];
    expect(ownPages(tree[0]!)).toEqual([1, undefined]);
    addNodeText(tree, pages);
    expect(all(tree).map((n) => n.text)).toEqual(["", "Opening words", "Alpha body", "Alpha body", "Beta body"]);
    coverSubtreeRanges(tree);
    expect(shape(tree)).toEqual([
      ["Report", 1, 3],
      ["Report (intro)", 1, 1],
      ["Alpha", 2, 3],
      ["Alpha one", 2, 2],
      ["Alpha two", 3, 3],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Large-node split (upstream process_large_node_recursively, v0.2.22)
// ---------------------------------------------------------------------------

describe("large-node split", () => {
  const heavy = (n: number) => pagesOf(Array.from({ length: n }, (_, i) => `page ${i + 1}`), 5000);
  const keep = async (items: TocItem[]) => items;

  test("a node that already has children is not split", async () => {
    const node: TreeNode = {
      title: "Ch",
      startIndex: 1,
      endIndex: 20,
      nodes: [{ title: "S", startIndex: 20, endIndex: 25 }],
    };
    await processLargeNodeRecursively(node, heavy(25), options, undefined, {
      metaProcessor: async () => {
        throw new Error("a parent's subsections must not be replaced");
      },
    });
    expect(node.nodes!.map((c) => c.title)).toEqual(["S"]);
  });

  test("a split intro skips its parent's heading", async () => {
    const intro: TreeNode = { title: "Ch (intro)", startIndex: 1, endIndex: 14 };
    await processLargeNodeRecursively(intro, heavy(14), options, undefined, {
      metaProcessor: async () => [
        { title: "Ch", physicalIndex: 1 },
        { title: "Background", physicalIndex: 5 },
        { title: "Scope", physicalIndex: 9 },
      ],
      checkTitleAppearanceInStart: async (items) => items.map((i) => ({ ...i, appearStart: "yes" })),
    });
    expect(intro.nodes!.map((c) => c.title)).toEqual(["Background", "Scope"]);
  });

  test("pages a split rebuilt unchanged are not split again", async () => {
    let n = 0;
    const node: TreeNode = { title: "Ch 3", startIndex: 1, endIndex: 40 };
    await processLargeNodeRecursively(node, heavy(40), options, undefined, {
      metaProcessor: async () => {
        n++;
        expect(n).toBeLessThan(5);
        // page 1 holds "Part II" right above the section's own heading
        return [
          { structure: "1", title: "Part II", physicalIndex: 1 },
          { structure: "1.1", title: "Ch 3", physicalIndex: 1 },
        ];
      },
      checkTitleAppearanceInStart: keep,
    });
    expect(n).toBe(1);
  });

  test("a small node is left alone and the LLM is not called", async () => {
    useFakeLLM(() => {
      throw new Error("no call expected");
    });
    const node: TreeNode = { title: "Short", startIndex: 1, endIndex: 11 };
    await processLargeNodeRecursively(node, pagesOf(Array(11).fill("x"), 1000), options);
    expect(node.nodes).toBeUndefined();
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bottom-up summaries (upstream summarize_tree, v0.5.0)
// ---------------------------------------------------------------------------

describe("summarizeTree", () => {
  const sum = { model: "m" };

  test("prompts are byte-identical to upstream's", () => {
    const listing = pyJsonList([{ title: 'C "q"', summary: "é\nx" }]);
    expect(listing).toBe(upstreamPrompts.listing);
    expect(leafSummaryPrompt("TEXT", 150)).toBe(upstreamPrompts.leaf);
    expect(parentSummaryPrompt("T", "INTRO", listing, 150)).toBe(upstreamPrompts.parent);
  });

  test("prompts cap words and omit points", async () => {
    useFakeLLM(() => '{"summary": "ok"}');
    const pages = pagesOf(["alpha ".repeat(5), "beta ".repeat(5)]);
    const tree = (): TreeNode[] => [
      {
        title: "R",
        startIndex: 1,
        endIndex: 2,
        nodes: [
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "B", startIndex: 2, endIndex: 2 },
        ],
      },
    ];
    await summarizeTree(tree(), pages, { ...sum, smallNodeTokens: 0 });
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.prompt.includes("within 150 words") && !c.prompt.includes('"points"'))).toBe(true);
    calls.length = 0;
    await summarizeTree(tree(), pages, { ...sum, smallNodeTokens: 0, maxWords: 80 });
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.prompt.includes("within 80 words"))).toBe(true);
  });

  test("a parent falls back to its subsection titles", async () => {
    useFakeLLM((prompt) => (prompt.includes("Section Title") ? "" : '{"summary": "ok"}'));
    const tree: TreeNode[] = [
      {
        title: "R",
        startIndex: 1,
        endIndex: 2,
        nodes: [
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "B", startIndex: 2, endIndex: 2 },
        ],
      },
    ];
    await summarizeTree(tree, pagesOf(["alpha ".repeat(300), "beta ".repeat(300)]), sum);
    expect(all(tree).map((n) => n.summary)).toEqual(["A; B", "ok", "ok"]);
  });

  test("a leaf keeps its raw text while shorter than its summary", async () => {
    useFakeLLM(() => '{"summary": "short"}');
    const text = "word ".repeat(150); // ~188 tokens: under 150 words (200), over 80 (107)
    const leaf = (): TreeNode[] => [{ title: "A", startIndex: 1, endIndex: 1 }];
    let out = await summarizeTree(leaf(), pagesOf([text]), sum);
    expect(calls.length).toBe(0);
    expect(out[0]!.summary).toBe(text.trim());
    out = await summarizeTree(leaf(), pagesOf([text]), { ...sum, maxWords: 80 });
    expect(calls.length).toBe(1);
    expect(out[0]!.summary).toBe("short");
  });

  test("the deepest leaf starts first", async () => {
    const started: string[] = [];
    useFakeLLM(async (prompt) => {
      started.push(["alpha", "gamma", "delta", "Section Title"].find((w) => prompt.includes(w))!);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      return '{"summary": "ok"}';
    });
    const tree: TreeNode[] = [
      {
        title: "R",
        startIndex: 1,
        endIndex: 3,
        nodes: [
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "B", startIndex: 2, endIndex: 2, nodes: [{ title: "C", startIndex: 2, endIndex: 2 }] },
          { title: "D", startIndex: 3, endIndex: 3 },
        ],
      },
    ];
    await summarizeTree(tree, pagesOf(["alpha ".repeat(5), "gamma ".repeat(5), "delta ".repeat(5)]), {
      ...sum,
      smallNodeTokens: 0,
      concurrency: 2,
    });
    expect(started.indexOf("gamma")).toBeLessThan(started.indexOf("alpha"));
    expect(started.indexOf("gamma")).toBeLessThan(started.indexOf("delta"));
    expect(started.filter((s) => s === "Section Title").length).toBe(2);
  });

  test("a ready parent goes before a queued shallow leaf", async () => {
    const started: string[] = [];
    useFakeLLM(async (prompt) => {
      started.push(
        ["Section Title: C", "Section Title", "alpha", "epsilon", "delta"].find((w) => prompt.includes(w))!
      );
      for (let i = 0; i < 8; i++) await Promise.resolve();
      return '{"summary": "ok"}';
    });
    const tree: TreeNode[] = [
      {
        title: "R",
        startIndex: 1,
        endIndex: 3,
        nodes: [
          {
            title: "B",
            startIndex: 2,
            endIndex: 2,
            nodes: [{ title: "C", startIndex: 2, endIndex: 2, nodes: [{ title: "E", startIndex: 2, endIndex: 2 }] }],
          },
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "D", startIndex: 3, endIndex: 3 },
        ],
      },
    ];
    await summarizeTree(tree, pagesOf(["alpha ".repeat(5), "epsilon ".repeat(5), "delta ".repeat(5)]), {
      ...sum,
      smallNodeTokens: 0,
      concurrency: 1,
    });
    expect(started.indexOf("Section Title: C")).toBeLessThan(started.indexOf("delta"));
  });

  test("an unrecoverable error on a leaf aborts the run", async () => {
    useFakeLLM((prompt) => {
      if (prompt.includes("alpha")) throw httpError(401);
      return '{"summary": "ok"}';
    });
    const tree: TreeNode[] = [
      {
        title: "R",
        startIndex: 1,
        endIndex: 2,
        nodes: [
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "B", startIndex: 2, endIndex: 2 },
        ],
      },
    ];
    await expect(
      summarizeTree(tree, pagesOf(["alpha ".repeat(5), "beta ".repeat(5)]), { ...sum, smallNodeTokens: 0 })
    ).rejects.toMatchObject({ status: 401 });
  });

  test.each(["", '{"summary": ""}'])("all-empty replies (%p) fail loud", async (reply) => {
    useFakeLLM(() => reply);
    const tree: TreeNode[] = [
      {
        title: "R",
        startIndex: 1,
        endIndex: 2,
        nodes: [
          { title: "A", startIndex: 1, endIndex: 1 },
          { title: "B", startIndex: 2, endIndex: 2 },
        ],
      },
    ];
    await expect(summarizeTree(tree, pagesOf(["tiny", "beta ".repeat(300)]), sum)).rejects.toThrow(
      "returned empty"
    );
  });

  test("every call failing fails loud and names the first failure", async () => {
    useFakeLLM(() => {
      throw httpError(400);
    });
    const tree: TreeNode[] = [{ title: "B", startIndex: 1, endIndex: 1 }];
    await expect(summarizeTree(tree, pagesOf(["beta ".repeat(300)]), sum)).rejects.toThrow(
      "first failure: HTTP 400"
    );
  });

  test("one blank reply among good ones falls back to the node's own text", async () => {
    useFakeLLM((prompt) => (prompt.includes("alpha") ? "" : '{"points": [], "summary": "ok"}'));
    const tree: TreeNode[] = [
      { title: "A", startIndex: 1, endIndex: 1 },
      { title: "B", startIndex: 2, endIndex: 2 },
    ];
    await summarizeTree(tree, pagesOf(["alpha ".repeat(300), "beta ".repeat(300)]), sum);
    expect(tree.map((n) => n.summary)).toEqual([Array(300).fill("alpha").join(" ").slice(0, 600), "ok"]);
  });

  test("a tree of short leaves needs no model", async () => {
    useFakeLLM(() => {
      throw new Error("no model call expected");
    });
    const out = await summarizeTree([{ title: "A", startIndex: 1, endIndex: 1 }], pagesOf(["tiny"]), sum);
    expect(out[0]!.summary).toBe("tiny");
    expect(fallbackSummary({ title: "Empty" }, "")).toBe("Empty");
  });
});

// ---------------------------------------------------------------------------
// The standard PDF pipeline end to end (upstream test_tree_format.py)
// ---------------------------------------------------------------------------

/** Scripted replies for the structure prompts; `entries` returns no-TOC entries per prompt */
function structureLLM(
  entries: (prompt: string) => object[],
  extra: (prompt: string) => string | undefined = () => undefined
) {
  useFakeLLM((prompt) => {
    const custom = extra(prompt);
    if (custom !== undefined) return custom;
    if (prompt.includes("toc_detected")) return '{"toc_detected": "no"}';
    if (prompt.includes("extracting hierarchical tree structure")) return JSON.stringify(entries(prompt));
    if (prompt.includes("start_begin")) return '{"start_begin": "no"}';
    if (prompt.includes('"answer"')) return '{"answer": "yes"}';
    return "{}";
  });
}

const entry = (structure: string, title: string, page: number) => ({
  structure,
  title,
  physical_index: `<physical_index_${page}>`,
});

describe("standard index", () => {
  test("stores intros, covering ranges and section summaries", async () => {
    const pages = pagesOf(["Opening words", ...Array.from({ length: 39 }, (_, i) => `page ${i + 2}`)]);
    structureLLM(
      () => [
        entry("1", "P", 1),
        entry("1.1", "C1", 3),
        entry("1.2", "C2", 21),
        entry("1.2.1", "C2.1", 21),
        entry("1.2.2", "C2.2", 31),
      ],
      (prompt) => {
        if (prompt.includes("start_begin")) return '{"start_begin": "yes"}';
        if (prompt.includes("Section Title: ")) {
          return '{"summary": "whole ' + prompt.split("Section Title: ")[1]!.split("\n")[0] + '"}';
        }
        if (prompt.includes("one-sentence description")) return "d";
        return undefined;
      }
    );

    const result = await new PageIndex({
      model: "m",
      addNodeSummary: true,
      addNodeText: true,
      addDocDescription: true,
      logger: () => {},
    }).processPdfPages(pages, "doc");

    const p = result.structure[0]!;
    const c2 = p.nodes![2]!;
    expect(shape([p])).toEqual([
      ["P", 1, 40],
      ["P (intro)", 1, 2],
      ["C1", 3, 20],
      ["C2", 21, 40],
      ["C2.1", 21, 30],
      ["C2.2", 31, 40],
    ]);
    expect([p.text, p.summary]).toEqual(["", "whole P"]); // its intro holds pages 1-2
    expect(p.nodes![0]!.text).toContain("Opening words");
    // C2's first child starts on C2's page; C2 keeps that page as its opening
    expect([c2.text, c2.summary]).toEqual(["page 21", "whole C2"]);
    // short leaves keep their own text; only the parents are asked, deepest first
    expect(p.nodes!.slice(0, 2).map((n) => n.summary)).toEqual([
      "Opening wordspage 2",
      Array.from({ length: 18 }, (_, i) => `page ${i + 3}`).join(""),
    ]);
    const parentPrompts = calls.map((c) => c.prompt).filter((q) => q.includes("Section Title: "));
    expect(parentPrompts.map((q) => q.split("Section Title: ")[1]!.split("\n")[0])).toEqual(["C2", "P"]);
    expect(parentPrompts[1]).toContain('"summary": "whole C2"');
    // the description reads the top level alone
    const description = calls.map((c) => c.prompt).find((q) => q.includes("one-sentence description"))!;
    expect(description).toContain("whole P");
    expect(description).not.toContain("whole C2");
    expect(result.docDescription).toBe("d");
    expect(all(result.structure).map((n) => n.nodeId)).toEqual(["0000", "0001", "0002", "0003", "0004", "0005"]);
  });

  test("gives TOC and split parents intros", async () => {
    const pages = pagesOf(Array.from({ length: 40 }, (_, i) => `page ${i + 1}`), 3000);
    const has = (prompt: string, page: number) => prompt.includes(`<physical_index_${page}>`);
    structureLLM((prompt) => {
      if (has(prompt, 1) && has(prompt, 40)) {
        return [entry("1", "P", 1), entry("1.1", "C1", 15), entry("1.2", "C2", 20)];
      }
      if (has(prompt, 1)) return [entry("1", "P", 1), entry("2", "Background", 8)]; // P's long opening
      return [entry("1", "C2", 20), entry("2", "C2.a", 25), entry("3", "C2.b", 32)]; // the large leaf C2
    });

    const result = await new PageIndex({ model: "m", addNodeSummary: false, logger: () => {} }).processPdfPages(
      pages,
      "doc"
    );

    expect(shape(result.structure)).toEqual([
      ["P", 1, 40],
      ["P (intro)", 1, 15],
      ["P (intro)", 1, 8],
      ["Background", 8, 15],
      ["C1", 15, 20],
      ["C2", 20, 40],
      ["C2 (intro)", 20, 25],
      ["C2.a", 25, 32],
      ["C2.b", 32, 40],
    ]);
  });

  test("uses gpt-6-luna by default", () => {
    expect(DEFAULT_INDEX_MODEL).toBe("gpt-6-luna");
  });
});

describe("document description", () => {
  test("with topLevelOnly, the prompt carries the top level alone", async () => {
    useFakeLLM(() => "d");
    const tree: TreeNode[] = [
      {
        title: "Report",
        summary: "report summary",
        nodes: [{ title: "Alpha", summary: "alpha summary" }],
      },
    ];
    await generateDocDescription(tree, options, { topLevelOnly: true });
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("report summary");
    expect(calls[0]!.prompt).not.toContain("alpha summary");
    await generateDocDescription(tree, options);
    expect(calls[1]!.prompt).toContain("alpha summary");
  });
});

// ---------------------------------------------------------------------------
// Node navigation (upstream utils, v0.2.21)
// ---------------------------------------------------------------------------

describe("node navigation", () => {
  const TREE: TreeNode[] = [
    {
      title: "Root",
      nodeId: "0000",
      startIndex: 1,
      nodes: [{ title: "Child", nodeId: "0001", startIndex: 3 }],
    },
    { title: "Tail", nodeId: "0002", startIndex: 5 },
  ];

  test("getNode, getNodeParent, getNodePath, getNodeMap", () => {
    const [root, tail] = TREE as [TreeNode, TreeNode];
    const child = root.nodes![0]!;
    expect(getNode(TREE, "0001")).toBe(child);
    expect(getNode(TREE, "9999")).toBeUndefined();
    expect(getNodeParent(TREE, "0001")).toBe(root);
    expect(getNodeParent(TREE, "0002")).toBeUndefined();
    expect(getNodePath(TREE, "0001")).toEqual([root, child]);
    expect(getNodePath(TREE, "0002")).toEqual([tail]);
    expect(getNodePath(TREE, "9999")).toEqual([]);
    expect(getNode(root, "0001")).toBe(child);
    expect(getNodeMap(TREE)).toEqual({ "0000": root, "0001": child, "0002": tail });
  });

  test("wrong input is refused, not read as not found", () => {
    const envelope = { docName: "d", structure: TREE } as unknown as TreeNode;
    expect(() => getNode(envelope, "0001")).toThrow(TypeError);
    expect(() => getNodeMap(envelope)).toThrow(/got object/);
    expect(() => getNodeMap(null as unknown as TreeNode[])).toThrow(/got null/);
    expect(() => getNode(TREE, 1 as unknown as string)).toThrow(/nodeId/);
  });

  test("createNodeMapping reads each node's own range, or the next node's start", () => {
    const tree: TreeNode[] = [
      { title: "A", nodeId: "0000", startIndex: 1, endIndex: 9, nodes: [{ title: "B", nodeId: "0001", startIndex: 4, endIndex: 9 }] },
    ];
    const ranges = (m: object) =>
      Object.values(m).map((v: { startIndex?: number; endIndex?: number }) => [v.startIndex, v.endIndex]);
    expect(ranges(createNodeMapping(tree, true, 12))).toEqual([
      [1, 9],
      [4, 9],
    ]);
    expect(ranges(createNodeMapping(TREE, true, 9))).toEqual([
      [1, 3],
      [3, 5],
      [5, 9],
    ]);
    expect(Object.keys(createNodeMapping(TREE))).toEqual(["0000", "0001", "0002"]);
  });
});
