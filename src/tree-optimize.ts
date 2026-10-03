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
 * remain available as routing information.
 */

import type { TreeNode } from "./types.js";

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
      for (const child of flatten(node.nodes!)) {
        titles.push(child.title);
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
