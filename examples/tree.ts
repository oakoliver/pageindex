/**
 * Markdown -> PageIndex tree, with no LLM: node ids, heading levels, line ranges,
 * approximate token counts, a map of where each section sits in the file, and the
 * deterministic tree-merge pass (mergeTree) with the keyItems it produces.
 *
 *   bun examples/tree.ts                    # bundled invented design doc (sample-design-doc.md)
 *   bun examples/tree.ts path/to/doc.md     # opt in: your own markdown file
 *   bun examples/tree.ts --page-lines 15    # lines per virtual page for mergeTree (default 30)
 *
 * mergeTree runs on page ranges, and in the library it is part of the PDF pipeline
 * (markdown mode has line numbers, not pages). To show it on markdown, this demo runs
 * the real mergeTree on a copy of the tree whose "pages" are 30-line chunks
 * (change with --page-lines).
 */
import {
  mdToTree, extractNodesFromMarkdown, mergeTree, treeCost, countTokens, type TreeNode,
} from "../src/index.ts";
import { loadStyle } from "./style.ts";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { newStyle, roundedBorder, joinHorizontal, joinVertical, Top, Left, stringWidth, truncate, blend1D } = await loadStyle();

// ── pipeline: run mdToTree (no summaries = no LLM), then derive spans ────────
type Node = TreeNode & { level: number; bold: boolean; ownEnd: number; end: number; tokens: number; depth: number };

async function build(path: string) {
  const src = readFileSync(path, "utf8");
  // capture the pipeline's own progress lines, timing each stage
  const stages: { msg: string; at: number }[] = [];
  const log = console.log;
  const t0 = performance.now();
  console.log = (m: string) => stages.push({ msg: String(m), at: performance.now() - t0 });
  const result = await mdToTree(path, { addNodeId: true, addNodeText: true, addNodeSummary: false, addDocDescription: false });
  const total = performance.now() - t0;
  console.log = log;

  const { nodeList } = extractNodesFromMarkdown(src);
  const byLine = new Map(nodeList.map((h) => [h.lineNum, h]));
  const lines = src.split("\n");
  const lineCount = result.lineCount!;
  const flat: Node[] = [];
  const walk = (ns: TreeNode[], depth: number) => ns.forEach((n) => {
    const h = byLine.get(n.lineNum!)!;
    const x = n as Node;
    x.level = h.level; x.depth = depth;
    x.bold = !/^#{1,6}\s/.test(lines[n.lineNum! - 1].trim());
    x.tokens = countTokens(n.text || "");
    flat.push(x);
    walk(n.nodes || [], depth + 1);
  });
  walk(result.structure, 0);
  const order = [...flat].sort((a, b) => a.lineNum! - b.lineNum!);
  order.forEach((n, i) => { n.ownEnd = i + 1 < order.length ? order[i + 1].lineNum! - 1 : lineCount; });
  const setEnd = (n: Node): number => (n.end = Math.max(n.ownEnd, ...(n.nodes || []).map((c) => setEnd(c as Node))));
  result.structure.forEach((n) => setEnd(n as Node));
  return { src, result, stages, total, flat, lineCount, headings: nodeList };
}

/** Run the real mergeTree over a copy, with startIndex/endIndex = virtual pages of `perPage` lines. */
function mergeOnPages(structure: TreeNode[], perPage: number) {
  const page = (l: number) => Math.ceil(l / perPage);
  const clone = (n: Node): TreeNode => ({
    title: n.title, nodeId: n.nodeId, lineNum: n.lineNum,
    startIndex: page(n.lineNum!), endIndex: page(Math.max(n.lineNum!, n.ownEnd)),
    ...(n.nodes?.length ? { nodes: n.nodes.map((c) => clone(c as Node)) } : {}),
  });
  const tree = structure.map((n) => clone(n as Node));
  const costBefore = Math.max(...tree.map((n) => treeCost(n)));
  const countNodes = (ns: TreeNode[]): number => ns.reduce((a, n) => a + 1 + countNodes(n.nodes || []), 0);
  const before = countNodes(tree);
  const t0 = performance.now();
  mergeTree(tree);
  const ms = performance.now() - t0;
  const costAfter = Math.max(...tree.map((n) => treeCost(n)));
  return { tree, before, after: countNodes(tree), costBefore, costAfter, ms };
}

// ── render ──────────────────────────────────────────────────────────────────
const W = 120;
const argv = process.argv.slice(2);
const pi = argv.indexOf("--page-lines");
const PER_PAGE = pi >= 0 ? Math.max(1, Number(argv.splice(pi, 2)[1])) : 30;
const FILE = resolve(argv[0] ?? join(dirname(fileURLToPath(import.meta.url)), "sample-design-doc.md"));
const C = {
  fg: "#c0caf5", dim: "#565f89", mute: "#737aa2", violet: "#bb9af7", blue: "#7aa2f7", cyan: "#7dcfff",
  green: "#9ece6a", amber: "#e0af68", pink: "#f7768e", orange: "#ff9e64", teal: "#73daca", track: "#292e42",
};
const s = (fg: string) => newStyle().foreground(fg);
const b = (fg: string) => newStyle().foreground(fg).bold(true);

const r = await build(FILE);
const m = mergeOnPages(r.result.structure, PER_PAGE);

// which original nodes did the merge fold away, and into whom?
const folded = new Map<string, string>(); // nodeId -> parent nodeId
const merged = new Map<string, string[]>(); // parent nodeId -> keyItems
const scan = (ns: any[]) => ns.forEach((n) => { if (n.keyItems) merged.set(n.nodeId, n.keyItems); scan(n.nodes || []); });
scan(m.tree);
const markFolded = (n: Node, into: string) => (n.nodes || []).forEach((c) => { folded.set((c as Node).nodeId!, into); markFolded(c as Node, into); });
for (const n of r.flat) if (merged.has(n.nodeId!)) markFolded(n, n.nodeId!);

// ── header ────────────────────────────────────────────────────────────────
const name = FILE.split("/").pop()!;
const title = b(C.violet).render("pageindex") + s(C.dim).render(" · ") + s(C.fg).render("markdown → hierarchical tree index") + s(C.dim).render(" · ") + b(C.green).render("0 LLM calls");
const meta = s(C.mute).render("TS port of VectifyAI PageIndex v0.2.19");
const header = title + " ".repeat(Math.max(1, W - stringWidth(title) - stringWidth(meta))) + meta;
const file = s(C.mute).render("mdToTree(") + s(C.green).render(`"${name}"`) + s(C.mute).render(", { addNodeSummary: ") + s(C.orange).render("false") + s(C.mute).render(" })");

// pipeline stages captured from the library's own progress output
let prev = 0;
const stages = r.stages.map((st, i) => {
  const next = i + 1 < r.stages.length ? r.stages[i + 1].at : r.total;
  const label = st.msg.replace(/\.\.\.$/, "").replace(" from markdown", "").replace(" from nodes", "").replace("Extracting ", "extract ").replace("Building ", "build ").replace("Formatting ", "format ").replace(" structure", "").replace(" content", "");
  const out = s(C.green).render("✓ ") + s(C.fg).render(label) + " " + s(C.cyan).render(`${(next - st.at).toFixed(2)}ms`);
  prev = next;
  return out;
}).join(s(C.dim).render("  →  "));
const pipeline = stages + s(C.dim).render("   =  ") + b(C.green).render(`${r.total.toFixed(2)} ms`);

const stat = (label: string, value: string, color = C.fg) =>
  newStyle().border(roundedBorder()).borderForeground(C.dim).padding(0, 1).render(joinVertical(Left, s(C.mute).render(label), b(color).render(value)));
const maxDepth = Math.max(...r.flat.map((n) => n.depth)) + 1;
const totalTok = r.flat.reduce((a, n) => a + n.tokens, 0);
const stats = joinHorizontal(Top,
  stat("lines", String(r.lineCount)), " ",
  stat("headings", String(r.headings.length)), " ",
  stat("tree nodes", String(r.flat.length)), " ",
  stat("roots", String(r.result.structure.length)), " ",
  stat("depth", String(maxDepth)), " ",
  stat("~tokens", totalTok.toLocaleString("en-US")), " ",
  stat(`mergeTree · ${PER_PAGE}-line pages`, `${m.before} → ${m.after} nodes`, C.amber), " ",
  stat("worst-case cost", `${m.costBefore} → ${m.costAfter} pages`, C.amber),
);

// ── tree ──────────────────────────────────────────────────────────────────
const MAP = 36;
const grad = blend1D(MAP, "#7aa2f7", "#bb9af7", "#f7768e") as any[];
function spanMap(n: Node): string {
  const a = Math.floor(((n.lineNum! - 1) / r.lineCount) * MAP);
  const own = Math.max(a, Math.ceil((Math.max(n.lineNum!, n.ownEnd) / r.lineCount) * MAP) - 1);
  const e = Math.max(a, Math.ceil((n.end / r.lineCount) * MAP) - 1);
  let out = "";
  for (let i = 0; i < MAP; i++) {
    if (i >= a && i <= own) out += newStyle().foreground(folded.has(n.nodeId!) ? C.dim : grad[i]).render("█");
    else if (i > own && i <= e) out += newStyle().foreground(grad[i]).render("▒");
    else out += s(C.track).render("─");
  }
  return out;
}

const TITLE_W = 50;
const rows: string[] = [];
const colHead =
  s(C.dim).render("id    ") + s(C.dim).render("section".padEnd(TITLE_W + 2)) + s(C.dim).render("lvl  ") +
  s(C.dim).render("lines".padEnd(10)) + s(C.dim).render("~tok  ") + s(C.dim).render(`where in the ${r.lineCount} lines`);
rows.push(colHead);
const walk = (ns: Node[], prefix: string) => ns.forEach((n, i) => {
  const last = i === ns.length - 1;
  const conn = n.depth === 0 ? "" : prefix + (last ? "└─ " : "├─ ");
  const isFold = folded.has(n.nodeId!);
  const kids = (n.nodes || []) as Node[];
  const titleColor = isFold ? C.dim : n.depth === 0 ? C.fg : C.blue;
  let t = conn + n.title;
  const tag = merged.has(n.nodeId!) ? `  ◆ merged ${merged.get(n.nodeId!)!.length}` : isFold ? "  keyItem" : "";
  { const lim = TITLE_W - stringWidth(tag); if (stringWidth(t) > lim) t = truncate(t, lim - 1) + "…"; }
  const painted = s("#6b739c").render(conn) + (isFold ? newStyle().foreground(C.dim).italic(true) : b(titleColor)).render(t.slice(conn.length));
  const tagP = merged.has(n.nodeId!) ? b(C.amber).render(tag) : s(C.dim).render(tag);
  const pad = " ".repeat(Math.max(0, TITLE_W + 2 - stringWidth(t) - stringWidth(tag)));
  const lvl = n.bold ? s(C.pink).render("**".padEnd(5)) : s(C.teal).render(("h" + n.level).padEnd(5));
  const lines = s(C.mute).render(`${n.lineNum}–${n.end}`.padEnd(10));
  const tok = s(C.mute).render(String(n.tokens).padStart(4) + "  ");
  const id = newStyle().foreground(isFold ? C.dim : C.violet).render(n.nodeId!) + "  ";
  rows.push(id + painted + tagP + pad + lvl + lines + tok + spanMap(n));
  walk(kids, n.depth === 0 ? "" : prefix + (last ? "   " : "│  "));
});
walk(r.result.structure as Node[], "");

const panel = newStyle().border(roundedBorder()).borderForeground(C.violet).padding(0, 1).width(W).render(rows.join("\n"));
const legend =
  " " + s(C.teal).render("h2") + s(C.dim).render(" heading   ") +
  s(C.pink).render("**") + s(C.dim).render(" bold-only line = level 1 (upstream rule)   ") +
  s(C.fg).render("█") + s(C.dim).render(" own text   ") + s(C.fg).render("▒") + s(C.dim).render(" subtree   ") +
  b(C.amber).render("◆") + s(C.dim).render(" folded into keyItems by mergeTree");

console.log(joinVertical(Left, header, "", file, pipeline, "", stats, panel, legend));
