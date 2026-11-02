/**
 * bun-pageindex: Tree optimization (deterministic merge)
 *
 * Port of upstream PageIndex `tree_optimize.merge_tree`, which the standard
 * PDF pipeline runs on every tree before node IDs are assigned.
 *
 * Search cost is measured in pages, with a routing cost R(v) = 1 page:
 *
 *   S(v)          pages to scan linearly if v is collapsed = the whole subtree span
 *   S_residual(v) pages of v covered by no child
 *   tree_cost(v)  = S(v)                                           if v is a frontier (leaf) node
 *                 = R(v) + max(S_residual(v), max_c tree_cost(c))  otherwise
 *
 * A subtree is merged into its parent when its structure does not beat a
 * linear scan: merge iff S(v) <= tree_cost(v) (ties merge). Decisions are made
 * bottom-up, so one pass reaches the fixpoint.
 *
 * When a subtree is merged away, the removed titles are kept on the parent as
 * `keyItems`: the pages stay reachable by scanning the parent, and the titles
 * remain available as routing information. An intro node's title is its
 * parent's heading again, so it is not listed.
 *
 * Also here, as upstream: `addIntroNodes`, which gives every parent whose first
 * child starts on a later page an "<title> (intro)" child for those pages.
 */

import type { TreeNode } from "./types.js";
import { introTitle, isIntro } from "./utils.js";

/** R(v): cost of visiting a node for routing, in pages */
export const ROUTING_COST = 1;

/** Depth-first (document order) walk over every node below `nodes` */
function flatten(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.nodes) {
      result.push(...flatten(node.nodes));
    }
  }
  return result;
}

/** Like flatten, with each node's parent inside the walk (undefined at the top) */
function flattenWithParent(
  nodes: TreeNode[],
  parent?: TreeNode
): Array<[TreeNode, TreeNode | undefined]> {
  const result: Array<[TreeNode, TreeNode | undefined]> = [];
  for (const node of nodes) {
    result.push([node, parent]);
    if (node.nodes) {
      result.push(...flattenWithParent(node.nodes, node));
    }
  }
  return result;
}

function isFrontier(node: TreeNode): boolean {
  return !node.nodes || node.nodes.length === 0;
}

function hasPageRange(node: TreeNode): boolean {
  return Number.isInteger(node.startIndex) && Number.isInteger(node.endIndex);
}

/**
 * Whether every node in the subtree has integer start/end indices.
 * Nodes without a page range cannot be costed and are never merged.
 */
function isMeasurable(node: TreeNode): boolean {
  return hasPageRange(node) && flatten(node.nodes || []).every(hasPageRange);
}

/**
 * Last page covered by this node or any descendant.
 * Walks the subtree so legacy trees, where a parent's endIndex stops at its
 * first child, are handled too.
 */
export function subtreeEnd(node: TreeNode): number {
  let end = node.endIndex as number;
  for (const child of flatten(node.nodes || [])) {
    end = Math.max(end, child.endIndex as number);
  }
  return end;
}

function pagesOf(node: TreeNode): Set<number> {
  const pages = new Set<number>();
  for (let page = node.startIndex as number; page <= subtreeEnd(node); page++) {
    pages.add(page);
  }
  return pages;
}

/** S(v): pages to scan linearly if this node were collapsed */
export function searchSpan(node: TreeNode): number {
  return subtreeEnd(node) - (node.startIndex as number) + 1;
}

/** S_residual(v): pages of the node covered by no child */
export function residualSpan(node: TreeNode): number {
  if (isFrontier(node)) {
    return searchSpan(node);
  }
  const covered = new Set<number>();
  for (const child of node.nodes!) {
    for (const page of pagesOf(child)) {
      covered.add(page);
    }
  }
  let residual = 0;
  for (const page of pagesOf(node)) {
    if (!covered.has(page)) residual++;
  }
  return residual;
}

/** Worst-case search cost of the subtree as it currently stands */
export function treeCost(node: TreeNode, routing: number = ROUTING_COST): number {
  if (isFrontier(node)) {
    return searchSpan(node);
  }
  const branches = node.nodes!.map((child) => treeCost(child, routing));
  const residual = residualSpan(node);
  if (residual) {
    branches.push(residual);
  }
  return routing + Math.max(...branches);
}

/**
 * Collapse any subtree whose structure does not beat a linear scan.
 * Bottom-up: merging a deep subtree changes its ancestors' tree cost, so the
 * deepest decisions are made first. Returns whether anything changed.
 */
export function merge(structure: TreeNode[], routing: number = ROUTING_COST): boolean {
  let changed = false;

  const visit = (node: TreeNode): void => {
    if (isFrontier(node)) return;
    for (const child of [...node.nodes!]) {
      visit(child);
    }
    if (isFrontier(node) || !isMeasurable(node)) return;

    const cost = treeCost(node, routing);
    const span = searchSpan(node);
    if (span <= cost) {
      // Titles are routing information: keep them on the parent, in document
      // order, carrying forward anything an earlier merge already folded in
      const titles: string[] = [];
      for (const [child, parent] of flattenWithParent(node.nodes!)) {
        if (!isIntro(parent ?? node, child)) {
          // an intro's title is its parent's heading again
          titles.push(child.title);
        }
        titles.push(...(child.keyItems || []));
      }
      node.endIndex = subtreeEnd(node);
      delete node.nodes;
      if (titles.length > 0) {
        node.keyItems = titles;
      }
      changed = true;
    }
  };

  for (const root of [...structure]) {
    visit(root);
  }
  return changed;
}

/**
 * Deterministic merge over a structure list (no LLM calls). Mutates and
 * returns the structure.
 */
export function mergeTree(structure: TreeNode[]): TreeNode[] {
  merge(structure, ROUTING_COST);
  return structure;
}

// ===================== Intro nodes (upstream v0.2.21) =====================

const HAN_KANA = "\u3005-\u3007\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff";
const HAN_GAP = new RegExp(`(?<=[${HAN_KANA}]) (?=[${HAN_KANA}])`, "gu");

/**
 * Letters, digits and marks of any script, case-folded; other runs become one
 * space, and none stays between two Han or kana characters (those scripts put
 * no space between words, so one there is layout). JavaScript has no Unicode
 * case folding; lower-casing plus ß -> ss covers the cases that matter here.
 */
export function normalize(text: string | undefined | null): string {
  const folded = (text ?? "").normalize("NFKC").toLowerCase().replace(/ß/g, "ss");
  const kept = folded.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean).join(" ");
  return kept.replace(HAN_GAP, "");
}

/**
 * Is the heading the first line on its page? No when that cannot be told (a
 * heading with no Latin letter to match, or a first line that a later line
 * repeats, as a running header does), so the page is shared.
 */
export function headingAtPageStart(lines: string[][], pageNo: number, heading: string): boolean {
  const page = lines[pageNo - 1];
  const key = normalize(heading);
  if (!page || page.length === 0 || !/[a-z]/.test(key)) {
    return false;
  }
  const starts = page.map((line) => (normalize(line) + " ").startsWith(key + " "));
  return starts[0]! && !starts.slice(1).some(Boolean);
}

/**
 * Give every parent whose first child starts on a later page an intro child
 * for the pages before it, titled "<parent title> (intro)". It ends where the
 * parent's own pages do, and no later than the first child's page: the page
 * before it when that child's heading opens its page (known only from
 * per-page `lines`; the standard pipeline has none, so the page is shared).
 * Mutates and returns the structure.
 */
export function addIntroNodes(structure: TreeNode[], lines?: string[][]): TreeNode[] {
  for (const node of flatten(structure)) {
    const children = node.nodes || [];
    const first = children.length > 0 ? children[0]!.startIndex : undefined;
    const start = node.startIndex;
    if (first === undefined || start === undefined || first <= start) {
      continue;
    }
    const opens =
      !!lines && lines.length > 0 && first <= lines.length &&
      headingAtPageStart(lines, first, children[0]!.title);
    const ownEnd = node.endIndex ?? first;
    const end = Math.max(start, Math.min(ownEnd, opens ? first - 1 : first));
    node.nodes = [{ title: introTitle(node.title), startIndex: start, endIndex: end }, ...children];
  }
  return structure;
}
