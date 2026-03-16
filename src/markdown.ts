/**
 * bun-pageindex: Markdown to Tree Conversion
 * Functions for building tree structures from markdown documents
 */

import { chatGPT } from "./openai";
import type { TreeNode, MarkdownOptions, PageIndexResult } from "./types";
import {
  countTokens,
  writeNodeId,
  structureToList,
  createCleanStructureForDescription,
  formatStructure,
} from "./utils";
import * as prompts from "./prompts";
import * as path from "path";
import * as fs from "fs/promises";

interface MarkdownNode {
  title: string;
  lineNum: number;
  level?: number;
  text?: string;
  textTokenCount?: number;
}

interface MarkdownTreeNode extends TreeNode {
  lineNum?: number;
}

const DEFAULT_MARKDOWN_OPTIONS = {
  model: "gpt-4o-2024-11-20",
  tocCheckPageNum: 20,
  maxPageNumEachNode: 10,
  maxTokenNumEachNode: 20000,
  addNodeId: true,
  addNodeSummary: true,
  addDocDescription: false,
  addNodeText: false,
  thinning: false,
  thinningThreshold: 5000,
  summaryTokenThreshold: 200,
} as const;

/**
 * Extract header nodes from markdown content
 * Respects code blocks and returns both nodes and original lines
 */
export function extractNodesFromMarkdown(
  markdownContent: string
): { nodeList: Array<{ nodeTitle: string; lineNum: number }>; lines: string[] } {
  const headerPattern = /^(#{1,6})\s+(.+)$/;
  const codeBlockPattern = /^```/;
  const nodeList: Array<{ nodeTitle: string; lineNum: number }> = [];

  const lines = markdownContent.split("\n");
  let inCodeBlock = false;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]!;
    const strippedLine = line.trim();

    // Check for code block delimiters (triple backticks)
    if (codeBlockPattern.test(strippedLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Skip empty lines
    if (!strippedLine) {
      continue;
    }

    // Only look for headers when not inside a code block
    if (!inCodeBlock) {
      const match = strippedLine.match(headerPattern);
      if (match) {
        const title = match[2]!.trim();
        nodeList.push({ nodeTitle: title, lineNum: lineNum + 1 }); // 1-indexed
      }
    }
  }

  return { nodeList, lines };
}

/**
 * Extract text content for each node based on line ranges
 */
export function extractNodeTextContent(
  nodeList: Array<{ nodeTitle: string; lineNum: number }>,
  markdownLines: string[]
): MarkdownNode[] {
  const allNodes: MarkdownNode[] = [];

  for (const node of nodeList) {
    const lineContent = markdownLines[node.lineNum - 1];
    if (!lineContent) continue;

    const headerMatch = lineContent.match(/^(#{1,6})/);

    if (!headerMatch) {
      console.warn(
        `Warning: Line ${node.lineNum} does not contain a valid header: '${lineContent}'`
      );
      continue;
    }

    const processedNode: MarkdownNode = {
      title: node.nodeTitle,
      lineNum: node.lineNum,
      level: headerMatch[1]!.length,
    };
    allNodes.push(processedNode);
  }

  // Extract text content for each node
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i]!;
    const startLine = node.lineNum - 1; // 0-indexed

    let endLine: number;
    if (i + 1 < allNodes.length) {
      endLine = allNodes[i + 1]!.lineNum - 1;
    } else {
      endLine = markdownLines.length;
    }

    node.text = markdownLines.slice(startLine, endLine).join("\n").trim();
  }

  return allNodes;
}

/**
 * Find all children of a parent node
 */
function findAllChildren(
  parentIndex: number,
  parentLevel: number,
  nodeList: MarkdownNode[]
): number[] {
  const childrenIndices: number[] = [];

  // Look for children after the parent
  for (let i = parentIndex + 1; i < nodeList.length; i++) {
    const currentLevel = nodeList[i]!.level || 0;

    // If we hit a node at same or higher level than parent, stop
    if (currentLevel <= parentLevel) {
      break;
    }

    // This is a descendant
    childrenIndices.push(i);
  }

  return childrenIndices;
}

/**
 * Update node list with text token counts
 * Calculates cumulative token count including all descendants
 */
export function updateNodeListWithTextTokenCount(
  nodeList: MarkdownNode[]
): MarkdownNode[] {
  // Make a copy to avoid modifying the original
  const resultList = nodeList.map((n) => ({ ...n }));

  // Process nodes from end to beginning to ensure children are processed before parents
  for (let i = resultList.length - 1; i >= 0; i--) {
    const currentNode = resultList[i]!;
    const currentLevel = currentNode.level || 0;

    // Get all children of this node
    const childrenIndices = findAllChildren(i, currentLevel, resultList);

    // Start with the node's own text
    const nodeText = currentNode.text || "";
    let totalText = nodeText;

    // Add all children's text
    for (const childIndex of childrenIndices) {
      const childText = resultList[childIndex]?.text || "";
      if (childText) {
        totalText += "\n" + childText;
      }
    }

    // Calculate token count for combined text
    resultList[i]!.textTokenCount = countTokens(totalText);
  }

  return resultList;
}

/**
 * Apply tree thinning to merge small nodes with their parents
 * Nodes below the token threshold are merged with their parents
 */
export function treeThinningForIndex(
  nodeList: MarkdownNode[],
  minNodeToken: number
): MarkdownNode[] {
  // Make a copy
  const resultList = nodeList.map((n) => ({ ...n }));
  const nodesToRemove = new Set<number>();

  for (let i = resultList.length - 1; i >= 0; i--) {
    if (nodesToRemove.has(i)) {
      continue;
    }

    const currentNode = resultList[i]!;
    const currentLevel = currentNode.level || 0;
    const totalTokens = currentNode.textTokenCount || 0;

    if (totalTokens < minNodeToken) {
      const childrenIndices = findAllChildren(i, currentLevel, resultList);

      const childrenTexts: string[] = [];
      for (const childIndex of childrenIndices.sort((a, b) => a - b)) {
        if (!nodesToRemove.has(childIndex)) {
          const childText = resultList[childIndex]?.text || "";
          if (childText.trim()) {
            childrenTexts.push(childText);
          }
          nodesToRemove.add(childIndex);
        }
      }

      if (childrenTexts.length > 0) {
        let parentText = currentNode.text || "";
        let mergedText = parentText;

        for (const childText of childrenTexts) {
          if (mergedText && !mergedText.endsWith("\n")) {
            mergedText += "\n\n";
          }
          mergedText += childText;
        }

        resultList[i]!.text = mergedText;
        resultList[i]!.textTokenCount = countTokens(mergedText);
      }
    }
  }

  // Remove marked nodes in reverse order to preserve indices
  const indicesToRemove = Array.from(nodesToRemove).sort((a, b) => b - a);
  for (const index of indicesToRemove) {
    resultList.splice(index, 1);
  }

  return resultList;
}

/**
 * Build tree structure from flat node list
 */
export function buildTreeFromNodes(nodeList: MarkdownNode[]): MarkdownTreeNode[] {
  if (nodeList.length === 0) {
    return [];
  }

  const stack: Array<[MarkdownTreeNode, number]> = [];
  const rootNodes: MarkdownTreeNode[] = [];
  let nodeCounter = 1;

  for (const node of nodeList) {
    const currentLevel = node.level || 1;

    const treeNode: MarkdownTreeNode = {
      title: node.title,
      nodeId: String(nodeCounter).padStart(4, "0"),
      text: node.text,
      lineNum: node.lineNum,
      nodes: [],
    };
    nodeCounter++;

    // Pop nodes from stack that are at same or deeper level
    while (stack.length > 0 && stack[stack.length - 1]![1] >= currentLevel) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootNodes.push(treeNode);
    } else {
      const [parentNode] = stack[stack.length - 1]!;
      parentNode.nodes!.push(treeNode);
    }

    stack.push([treeNode, currentLevel]);
  }

  return rootNodes;
}

/**
 * Clean tree for output - remove empty nodes arrays
 */
export function cleanTreeForOutput(treeNodes: MarkdownTreeNode[]): MarkdownTreeNode[] {
  const cleanedNodes: MarkdownTreeNode[] = [];

  for (const node of treeNodes) {
    const cleanedNode: MarkdownTreeNode = {
      title: node.title,
      nodeId: node.nodeId,
      text: node.text,
      lineNum: node.lineNum,
    };

    if (node.nodes && node.nodes.length > 0) {
      cleanedNode.nodes = cleanTreeForOutput(node.nodes as MarkdownTreeNode[]);
    }

    cleanedNodes.push(cleanedNode);
  }

  return cleanedNodes;
}

/**
 * Get summary for a node (use text if short, otherwise generate)
 */
async function getNodeSummary(
  node: TreeNode,
  summaryTokenThreshold: number,
  options: { model: string; apiKey?: string; baseUrl?: string }
): Promise<string> {
  const nodeText = node.text || "";
  const numTokens = countTokens(nodeText);

  if (numTokens < summaryTokenThreshold) {
    return nodeText;
  }

  // Generate summary using LLM
  const prompt = prompts.generateNodeSummaryPrompt(nodeText);
  return chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
}

/**
 * Generate summaries for markdown structure
 */
export async function generateSummariesForStructureMd(
  structure: TreeNode[],
  summaryTokenThreshold: number,
  options: { model: string; apiKey?: string; baseUrl?: string }
): Promise<void> {
  const nodes = structureToList(structure);

  // Process in batches
  const batchSize = 5;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const summaries = await Promise.all(
      batch.map((node) =>
        getNodeSummary(node as TreeNode, summaryTokenThreshold, options)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const node = batch[j] as TreeNode;
      if (!node.nodes || node.nodes.length === 0) {
        node.summary = summaries[j];
      } else {
        node.prefixSummary = summaries[j];
      }
    }
  }
}

/**
 * Generate document description from structure
 */
async function generateDocDescriptionMd(
  structure: TreeNode[],
  options: { model: string; apiKey?: string; baseUrl?: string }
): Promise<string> {
  const cleanStructure = createCleanStructureForDescription(structure);
  const prompt = prompts.generateDocDescriptionPrompt(
    JSON.stringify(cleanStructure)
  );

  return chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
}

/**
 * Main function to convert markdown to tree structure
 */
export async function mdToTree(
  mdPath: string,
  options: MarkdownOptions = {}
): Promise<PageIndexResult> {
  const opts = {
    ...DEFAULT_MARKDOWN_OPTIONS,
    ...options,
  };

  // Read markdown file
  const markdownContent = await fs.readFile(mdPath, 'utf-8');

  console.log("Extracting nodes from markdown...");
  const { nodeList, lines: markdownLines } = extractNodesFromMarkdown(markdownContent);

  console.log("Extracting text content from nodes...");
  let nodesWithContent = extractNodeTextContent(nodeList, markdownLines);

  // Apply thinning if requested
  if (opts.thinning) {
    nodesWithContent = updateNodeListWithTextTokenCount(nodesWithContent);
    console.log("Thinning nodes...");
    nodesWithContent = treeThinningForIndex(nodesWithContent, opts.thinningThreshold);
  }

  console.log("Building tree from nodes...");
  let treeStructure = buildTreeFromNodes(nodesWithContent);

  // Add node IDs if requested
  if (opts.addNodeId) {
    writeNodeId(treeStructure);
  }

  console.log("Formatting tree structure...");

  // Format structure with preferred key order
  const keyOrder = [
    "title",
    "nodeId",
    "summary",
    "prefixSummary",
    "text",
    "lineNum",
    "nodes",
  ];

  if (opts.addNodeSummary) {
    // Always format first
    treeStructure = formatStructure(treeStructure, keyOrder) as MarkdownTreeNode[];

    console.log("Generating summaries for each node...");
    await generateSummariesForStructureMd(
      treeStructure,
      opts.summaryTokenThreshold,
      {
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: undefined,
      }
    );

    // Remove text if not requested
    if (!opts.addNodeText) {
      const orderWithoutText = keyOrder.filter((k) => k !== "text");
      treeStructure = formatStructure(treeStructure, orderWithoutText) as MarkdownTreeNode[];
    }

    if (opts.addDocDescription) {
      console.log("Generating document description...");
      const docDescription = await generateDocDescriptionMd(treeStructure, {
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: undefined,
      });

      return {
        docName: path.basename(mdPath, path.extname(mdPath)),
        docDescription,
        structure: treeStructure,
      };
    }
  } else {
    // No summaries needed
    const orderToUse = opts.addNodeText
      ? keyOrder
      : keyOrder.filter((k) => k !== "text");
    treeStructure = formatStructure(treeStructure, orderToUse) as MarkdownTreeNode[];
  }

  return {
    docName: path.basename(mdPath, path.extname(mdPath)),
    structure: treeStructure,
  };
}

/**
 * Convert markdown string to tree (alternative to file-based approach)
 */
export async function markdownToTree(
  content: string,
  docName: string = "document",
  options: MarkdownOptions = {}
): Promise<PageIndexResult> {
  const opts = {
    ...DEFAULT_MARKDOWN_OPTIONS,
    ...options,
  };

  console.log("Extracting nodes from markdown...");
  const { nodeList, lines: markdownLines } = extractNodesFromMarkdown(content);

  console.log("Extracting text content from nodes...");
  let nodesWithContent = extractNodeTextContent(nodeList, markdownLines);

  // Apply thinning if requested
  if (opts.thinning) {
    nodesWithContent = updateNodeListWithTextTokenCount(nodesWithContent);
    console.log("Thinning nodes...");
    nodesWithContent = treeThinningForIndex(nodesWithContent, opts.thinningThreshold);
  }

  console.log("Building tree from nodes...");
  let treeStructure = buildTreeFromNodes(nodesWithContent);

  // Add node IDs if requested
  if (opts.addNodeId) {
    writeNodeId(treeStructure);
  }

  // Format structure
  const keyOrder = [
    "title",
    "nodeId",
    "summary",
    "prefixSummary",
    "text",
    "lineNum",
    "nodes",
  ];

  if (opts.addNodeSummary) {
    treeStructure = formatStructure(treeStructure, keyOrder) as MarkdownTreeNode[];

    console.log("Generating summaries for each node...");
    await generateSummariesForStructureMd(
      treeStructure,
      opts.summaryTokenThreshold,
      {
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: undefined,
      }
    );

    if (!opts.addNodeText) {
      const orderWithoutText = keyOrder.filter((k) => k !== "text");
      treeStructure = formatStructure(treeStructure, orderWithoutText) as MarkdownTreeNode[];
    }

    if (opts.addDocDescription) {
      console.log("Generating document description...");
      const docDescription = await generateDocDescriptionMd(treeStructure, {
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: undefined,
      });

      return {
        docName,
        docDescription,
        structure: treeStructure,
      };
    }
  } else {
    const orderToUse = opts.addNodeText
      ? keyOrder
      : keyOrder.filter((k) => k !== "text");
    treeStructure = formatStructure(treeStructure, orderToUse) as MarkdownTreeNode[];
  }

  return {
    docName,
    structure: treeStructure,
  };
}

/**
 * Print tree structure as table of contents
 */
export function printTocMd(tree: TreeNode[], indent: number = 0): void {
  for (const node of tree) {
    console.log("  ".repeat(indent) + node.title);
    if (node.nodes) {
      printTocMd(node.nodes, indent + 1);
    }
  }
}
