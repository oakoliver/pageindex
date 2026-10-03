/**
 * Reasoning-based retrieval over a pageindex tree: show an LLM the outline
 * (titles, node IDs, summaries; no body text), let it pick the nodes likely
 * to answer a question, then read only those nodes' text.
 *
 * pageindex builds the tree; this search step is yours to implement. This is
 * one minimal way to do it.
 *
 * Run: OPENAI_API_KEY=... bun examples/tree-search.ts "When should the rain gauge be re-levelled?"
 *      (any OpenAI-compatible server works via OPENAI_BASE_URL)
 */

import OpenAI from "openai";
import { mdToTree, type TreeNode } from "../src";

const question = process.argv[2] ?? "When should the rain gauge be re-levelled?";
const model = process.env.MODEL ?? "gpt-4o-2024-11-20";

// 1. Index the document (node summaries need the same LLM endpoint).
const { structure } = await mdToTree("examples/weather-station.md", {
  model,
  baseUrl: process.env.OPENAI_BASE_URL,
  addNodeSummary: true,
  addNodeText: true,
});

// 2. Ask the model which nodes to read, from the outline alone.
const outline = JSON.stringify(structure, (key, value) => (key === "text" ? undefined : value));
const client = new OpenAI();
const response = await client.chat.completions.create({
  model,
  response_format: { type: "json_object" },
  messages: [
    {
      role: "user",
      content:
        `Question: ${question}\n\nDocument tree:\n${outline}\n\n` +
        'Reply with JSON {"node_ids": [...]} listing the nodes most likely to contain the answer.',
    },
  ],
});
const { node_ids = [] } = JSON.parse(response.choices[0]?.message.content ?? "{}") as { node_ids?: string[] };

// 3. Read only the chosen sections.
const byId = new Map<string, TreeNode>();
const walk = (nodes: TreeNode[]) => {
  for (const node of nodes) {
    if (node.nodeId) byId.set(node.nodeId, node);
    walk(node.nodes ?? []);
  }
};
walk(structure);

for (const id of node_ids) {
  const node = byId.get(id);
  if (node) console.log(`[${id}] ${node.title}\n${node.text ?? ""}`);
}
