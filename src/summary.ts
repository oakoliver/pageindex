/**
 * pageindex: Bottom-up node summaries
 *
 * Port of upstream PageIndex `utils.summarize_tree` (v0.5.0), which the
 * standard PDF pipeline uses since upstream v0.2.21 ("standard mode
 * summarizes like Flash"):
 *
 * - a leaf is summarized from its own pages; a leaf shorter than the summary
 *   itself (`maxWords` in tokens, 200 by default) keeps its text instead of a
 *   model call;
 * - a parent is summarized from the pages that open it (before its first
 *   child, at most three) plus its children's titles and summaries, once
 *   every child is done, so its summary describes the whole section;
 * - a node the model leaves without a summary falls back to its children's
 *   titles (parent) or its own text (leaf);
 * - calls wait at one gate, deepest node first;
 * - dead credentials or a missing model fail the run, and so does a run in
 *   which every model call failed or came back empty.
 *
 * Upstream's Flash-only parts are not ported: summaries that start while the
 * LLM expand pass is still running (mark_final), the same-page retitling,
 * splitting a shared page between two leaves, and `reasoning_effort`.
 */

import { chatGPT, isUnrecoverable } from "./openai.js";
import * as prompts from "./prompts.js";
import type { TreeNode } from "./types.js";
import { countTokens, getTextOfPdfPages } from "./utils.js";

/** Default cap on simultaneous summary calls (upstream's Flash default) */
export const SUMMARY_CONCURRENCY = 128;

/** Simultaneous summary calls in the standard PDF pipeline (upstream page_index_main) */
export const STANDARD_SUMMARY_CONCURRENCY = 64;

/** Cap on leading pages fed into a parent's summary */
export const SUMMARY_INTRO_MAX_PAGES = 3;

/** Word cap the summary prompts ask for */
export const SUMMARY_MAX_WORDS = 150;

/** Tokens per word, to price a summary of `maxWords` words */
export const TOKENS_PER_WORD = 4 / 3;

/** Longest fallback summary, in characters */
export const FALLBACK_SUMMARY_CHARS = 600;

export interface SummarizeTreeOptions {
  /** Model for the summaries */
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Leaves under this many tokens keep their own text (default: maxWords in tokens) */
  smallNodeTokens?: number;
  /** Cap on the opening pages a parent's summary reads (default: 3) */
  maxIntroPages?: number;
  /** Simultaneous summary calls (default: 128; the PDF pipeline uses 64) */
  concurrency?: number;
  /** Word cap the prompts ask for (default: 150) */
  maxWords?: number;
}

type Page = { text: string };

/**
 * The summary of a node the model left unsummarized, so no node goes without
 * one: a parent's subsection titles, a leaf's own text.
 */
export function fallbackSummary(node: TreeNode, text: string = ""): string {
  const children = node.nodes || [];
  const summary =
    children.length > 0
      ? children.map((child) => child.title).filter(Boolean).join("; ")
      : text.split(/\s+/).filter(Boolean).join(" ");
  return Array.from(summary).slice(0, FALLBACK_SUMMARY_CHARS).join("") || node.title || "";
}

/**
 * Pages of the node covered by no child: from its start to just before the
 * first child starts. Empty when the first child opens on the node's own page.
 */
export function getIntroText(
  node: TreeNode,
  pages: Page[],
  maxPages: number = SUMMARY_INTRO_MAX_PAGES
): string {
  const children = node.nodes || [];
  const first = children.length > 0 ? children[0]!.startIndex : undefined;
  const start = node.startIndex;
  if (!Number.isInteger(first) || start === undefined || first! <= start) {
    return "";
  }
  const end = Math.min(first! - 1, start + maxPages - 1);
  return getTextOfPdfPages(pages, start, end);
}

/**
 * The JSON object in a model reply, or null when none of it parses. Repairs
 * (collapsed whitespace, trailing commas) are tried only once the reply fails
 * to parse as written.
 */
function replyJson(reply: unknown): unknown {
  if (typeof reply !== "string" || !reply.trim()) return null;
  let text = reply.trim();
  if (text.includes("```")) {
    text = text.replace(/^[\s\S]*?```(?:json)?\s*/, "").split("```")[0]!;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const obj = text.slice(start, end + 1);
  const collapsed = obj.split(/\s+/).filter(Boolean).join(" ");
  for (const candidate of [obj, collapsed, collapsed.replace(/,]/g, "]").replace(/,}/g, "}")]) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** The `summary` field of a model reply, or the reply itself when there is no such field */
export function parseSummary(reply: unknown): string {
  if (typeof reply !== "string" || !reply.trim()) return "";
  const parsed = replyJson(reply);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "summary" in parsed) {
    let summary = (parsed as { summary: unknown }).summary;
    if (Array.isArray(summary)) {
      summary = summary
        .map((item) => String(item).trim())
        .filter(Boolean)
        .join(" ");
    }
    return summary ? String(summary).trim() : "";
  }
  return reply.trim();
}

/** Semaphore that admits the highest-priority waiter first, FIFO within a priority */
class PriorityGate {
  private free: number;
  private waiters: Array<{ prio: number; seq: number; grant: () => void }> = [];
  private seq = 0;

  constructor(permits: number) {
    if (permits < 1) throw new RangeError("permits must be >= 1");
    this.free = permits;
  }

  async acquire(prio: number): Promise<void> {
    if (this.free > 0 && this.waiters.length === 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((grant) => {
      this.waiters.push({ prio, seq: this.seq++, grant });
      this.waiters.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.grant(); // the permit moves straight to this waiter
    } else {
      this.free += 1;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bottom-up summaries over a PDF tree (mutates and returns it). Leaves are
 * summarized from their own pages, parents from their opening pages plus
 * their children's summaries; nodes that already carry a summary are left
 * untouched. Model calls start deepest node first and leave the queue deepest
 * first: priority is a node's depth, the calls left on its path to the root.
 */
export async function summarizeTree(
  structure: TreeNode[],
  pages: Page[],
  options: SummarizeTreeOptions
): Promise<TreeNode[]> {
  const maxWords = options.maxWords || SUMMARY_MAX_WORDS;
  const maxIntroPages = options.maxIntroPages ?? SUMMARY_INTRO_MAX_PAGES;
  const smallNodeTokens = options.smallNodeTokens ?? TOKENS_PER_WORD * maxWords;
  const gate = new PriorityGate(options.concurrency || SUMMARY_CONCURRENCY);
  let asked = false;
  let answered = false;
  let failure: unknown;
  const tasks = new Map<TreeNode, Promise<void>>();

  const ask = async (prompt: string, prio: number): Promise<string> => {
    asked = true;
    await gate.acquire(prio);
    let reply: string;
    try {
      reply = await chatGPT({
        model: options.model,
        prompt,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      });
    } finally {
      gate.release();
    }
    if (parseSummary(reply)) answered = true;
    return reply;
  };

  const leafText = (node: TreeNode): string =>
    getTextOfPdfPages(pages, node.startIndex, node.endIndex);

  const leafSummary = async (node: TreeNode, prio: number): Promise<string> => {
    const text = leafText(node);
    if (countTokens(text) < smallNodeTokens) {
      return text.trim();
    }
    return parseSummary(await ask(prompts.leafSummaryPrompt(text, maxWords), prio));
  };

  const parentSummary = async (node: TreeNode, prio: number): Promise<string> => {
    const children = node.nodes!;
    const intro = getIntroText(node, pages, maxIntroPages);
    const listing = prompts.pyJsonList(
      children.map((child) => ({ title: child.title ?? "", summary: child.summary ?? "" }))
    );
    const prompt = prompts.parentSummaryPrompt(node.title ?? "", intro, listing, maxWords);
    return parseSummary(await ask(prompt, prio));
  };

  const task = (node: TreeNode, depth: number): Promise<void> => {
    let existing = tasks.get(node);
    if (!existing) {
      existing = visit(node, depth);
      tasks.set(node, existing);
    }
    return existing;
  };

  const visit = async (node: TreeNode, depth: number): Promise<void> => {
    const children = node.nodes || [];
    if (children.length > 0) {
      const done = await Promise.allSettled(children.map((child) => task(child, depth + 1)));
      for (const result of done) {
        if (result.status === "rejected" && isUnrecoverable(result.reason)) {
          throw result.reason;
        }
      }
    }
    if (node.summary) return;
    try {
      node.summary = await (children.length > 0
        ? parentSummary(node, depth)
        : leafSummary(node, depth));
    } catch (error) {
      node.summary = "";
      failure ??= error;
      if (isUnrecoverable(error)) throw error;
    }
    if (!node.summary) {
      node.summary = fallbackSummary(node, children.length > 0 ? "" : leafText(node));
    }
  };

  // Every node is final from the start (no expand pass runs alongside), so
  // tasks start deepest node first, as upstream's mark_final orders them.
  const order: Array<[number, TreeNode]> = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      order.push([depth, node]);
      walk(node.nodes || [], depth + 1);
    }
  };
  walk(structure, 1);
  order.sort((a, b) => b[0] - a[0]);
  for (const [depth, node] of order) {
    void task(node, depth).catch(() => {}); // awaited through the roots below
  }

  const results = await Promise.allSettled(structure.map((root) => task(root, 1)));
  for (const result of results) {
    if (result.status === "rejected" && isUnrecoverable(result.reason)) {
      throw result.reason;
    }
  }

  // Raw-text leaves summarize without the model, so they cannot vouch for it:
  // a run whose every model call failed still fails loud.
  const anySummary = (nodes: TreeNode[]): boolean =>
    nodes.some((node) => !!node.summary || anySummary(node.nodes || []));
  if ((asked && !answered) || !anySummary(structure)) {
    throw new Error(
      "Summary generation failed for all nodes " +
        "(every summary call failed or returned empty; " +
        (failure !== undefined
          ? `first failure: ${errorText(failure)}`
          : "check the model and its context limits") +
        ")",
      failure !== undefined ? { cause: failure } : undefined
    );
  }
  return structure;
}
