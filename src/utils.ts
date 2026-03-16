/**
 * bun-pageindex: Utility functions
 * Token counting, JSON extraction, tree manipulation
 */

import type { TreeNode, TocItem } from "./types";

/**
 * Approximate token count using character-based estimation
 * More accurate than words/4, accounts for code and punctuation
 * For production, consider using tiktoken-like library
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  // GPT tokenization approximation:
  // - Average ~4 chars per token for English
  // - Code/punctuation tends to have more tokens per char
  // This is a reasonable approximation without tiktoken
  return Math.ceil(text.length / 4);
}

/**
 * Extract JSON content from LLM response
 * Handles ```json code blocks, ``` blocks, <think> tags, and raw JSON
 */
export function getJsonContent(response: string): string {
  let content = response;

  // Remove <think>...</think> blocks (common with Qwen and other reasoning models)
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  
  // Remove any other XML-like tags that might wrap the response
  content = content.replace(/<\/?output>/gi, "").trim();

  // Try to extract from ```json blocks first
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    return jsonBlockMatch[1].trim();
  }

  // Try to extract from ``` blocks (without json specifier)
  const codeBlockMatch = content.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object or array directly
  const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].trim();
  }

  return content.trim();
}

/**
 * Clean JSON string for parsing
 */
function cleanJsonString(jsonContent: string): string {
  return jsonContent
    .replace(/None/g, "null") // Python None -> JSON null
    .replace(/True/g, "true") // Python True -> JSON true
    .replace(/False/g, "false") // Python False -> JSON false
    .replace(/,\s*]/g, "]") // Trailing commas in arrays
    .replace(/,\s*}/g, "}") // Trailing commas in objects
    .replace(/'/g, '"'); // Single quotes to double quotes
}

/**
 * Try to extract specific fields from malformed JSON using regex
 * Useful when the "thinking" field has unescaped characters
 */
function extractFieldsFromMalformedJson(content: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  
  // Common fields we need to extract - both snake_case and camelCase variants
  const stringFields = [
    "toc_detected", "tocDetected",
    "answer", 
    "start_begin", "startBegin",
    "completed", 
    "page_index_given", "pageIndexGiven",
    "page_index_given_in_toc", "pageIndexGivenInToc",
    "reasoning", "thinking",
    "structure",
    "appear_start", "appearStart"
  ];
  const numberFields = ["confidence", "page", "physical_index", "physicalIndex"];
  
  for (const field of stringFields) {
    // Match "field": "value" or "field": 'value' - handle multi-word values
    const match = content.match(new RegExp(`["']${field}["']\\s*:\\s*["']([^"']*?)["']`, 'i'));
    if (match && match[1]) {
      // Normalize the field name to snake_case for consistency
      const normalizedField = field.replace(/([A-Z])/g, '_$1').toLowerCase();
      result[normalizedField] = match[1].trim().toLowerCase();
      result[field] = match[1].trim().toLowerCase(); // Also keep original
    }
  }
  
  for (const field of numberFields) {
    const match = content.match(new RegExp(`["']${field}["']\\s*:\\s*([\\d.]+)`, 'i'));
    if (match && match[1]) {
      const normalizedField = field.replace(/([A-Z])/g, '_$1').toLowerCase();
      result[normalizedField] = parseFloat(match[1]);
      result[field] = parseFloat(match[1]);
    }
  }
  
  // Also try to extract title field
  const titleMatch = content.match(/["']title["']\s*:\s*["']([^"']+)["']/i);
  if (titleMatch && titleMatch[1]) {
    result.title = titleMatch[1];
  }
  
  // Extract table_of_contents array if present (even if malformed)
  const tocMatch = content.match(/["']table_of_contents["']\s*:\s*\[/i);
  if (tocMatch) {
    // Try to extract array items
    const arrayContent = content.slice(content.indexOf('['));
    try {
      // Find balanced brackets
      let depth = 0;
      let endIndex = 0;
      for (let i = 0; i < arrayContent.length; i++) {
        if (arrayContent[i] === '[') depth++;
        else if (arrayContent[i] === ']') {
          depth--;
          if (depth === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
      if (endIndex > 0) {
        const arrayStr = cleanJsonString(arrayContent.slice(0, endIndex));
        result.table_of_contents = JSON.parse(arrayStr);
      }
    } catch {
      // Array parsing failed, skip
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse JSON from LLM response with error handling
 * Cleans up common issues like Python None, trailing commas
 * Falls back to regex extraction for malformed JSON from local models
 */
export function extractJson<T = unknown>(content: string): T | null {
  try {
    let jsonContent = getJsonContent(content);
    jsonContent = cleanJsonString(jsonContent);
    return JSON.parse(jsonContent) as T;
  } catch (error) {
    // Try a more aggressive extraction - find first { or [ and match to last } or ]
    try {
      // First strip think tags from the original content
      let cleanContent = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      
      const startBrace = cleanContent.indexOf("{");
      const startBracket = cleanContent.indexOf("[");
      
      let start = -1;
      let end = -1;
      
      if (startBrace !== -1 && (startBracket === -1 || startBrace < startBracket)) {
        start = startBrace;
        end = cleanContent.lastIndexOf("}");
      } else if (startBracket !== -1) {
        start = startBracket;
        end = cleanContent.lastIndexOf("]");
      }
      
      if (start !== -1 && end !== -1 && end > start) {
        let jsonContent = cleanContent.slice(start, end + 1);
        jsonContent = cleanJsonString(jsonContent);
        return JSON.parse(jsonContent) as T;
      }
    } catch {
      // Try regex-based field extraction as last resort
      const extracted = extractFieldsFromMalformedJson(content);
      if (extracted) {
        return extracted as T;
      }
    }
    
    console.error("Failed to extract JSON:", error);
    return null;
  }
}

/**
 * Write node IDs to tree structure (mutates in place)
 * Returns the next available node ID
 */
export function writeNodeId(
  data: TreeNode | TreeNode[],
  nodeId: number = 0
): number {
  if (Array.isArray(data)) {
    for (const item of data) {
      nodeId = writeNodeId(item, nodeId);
    }
  } else if (data && typeof data === "object") {
    data.nodeId = String(nodeId).padStart(4, "0");
    nodeId += 1;
    if (data.nodes) {
      nodeId = writeNodeId(data.nodes, nodeId);
    }
  }
  return nodeId;
}

/**
 * Get all nodes from tree structure (flattened)
 */
export function getNodes(structure: TreeNode | TreeNode[]): TreeNode[] {
  if (Array.isArray(structure)) {
    const nodes: TreeNode[] = [];
    for (const item of structure) {
      nodes.push(...getNodes(item));
    }
    return nodes;
  }

  const node = { ...structure };
  delete node.nodes;
  const nodes = [node];

  if (structure.nodes) {
    nodes.push(...getNodes(structure.nodes));
  }

  return nodes;
}

/**
 * Convert structure to flat list (keeps parent references)
 */
export function structureToList(
  structure: TreeNode | TreeNode[]
): TreeNode[] {
  if (Array.isArray(structure)) {
    const nodes: TreeNode[] = [];
    for (const item of structure) {
      nodes.push(...structureToList(item));
    }
    return nodes;
  }

  const nodes: TreeNode[] = [structure];
  if (structure.nodes) {
    nodes.push(...structureToList(structure.nodes));
  }
  return nodes;
}

/**
 * Get leaf nodes (nodes without children)
 */
export function getLeafNodes(structure: TreeNode | TreeNode[]): TreeNode[] {
  if (Array.isArray(structure)) {
    const leafNodes: TreeNode[] = [];
    for (const item of structure) {
      leafNodes.push(...getLeafNodes(item));
    }
    return leafNodes;
  }

  if (!structure.nodes || structure.nodes.length === 0) {
    const node = { ...structure };
    delete node.nodes;
    return [node];
  }

  return getLeafNodes(structure.nodes);
}

/**
 * Check if a node is a leaf node by ID
 */
export function isLeafNode(
  data: TreeNode | TreeNode[],
  nodeId: string
): boolean {
  const findNode = (
    data: TreeNode | TreeNode[],
    id: string
  ): TreeNode | null => {
    if (Array.isArray(data)) {
      for (const item of data) {
        const result = findNode(item, id);
        if (result) return result;
      }
      return null;
    }

    if (data.nodeId === id) return data;
    if (data.nodes) return findNode(data.nodes, id);
    return null;
  };

  const node = findNode(data, nodeId);
  return node ? !node.nodes || node.nodes.length === 0 : false;
}

/**
 * Convert flat TOC list to tree structure
 */
export function listToTree(data: TocItem[]): TreeNode[] {
  const getParentStructure = (structure: string | undefined): string | null => {
    if (!structure) return null;
    const parts = structure.split(".");
    return parts.length > 1 ? parts.slice(0, -1).join(".") : null;
  };

  const nodes: Map<string, TreeNode> = new Map();
  const rootNodes: TreeNode[] = [];

  for (const item of data) {
    const structure = item.structure;
    const node: TreeNode = {
      title: item.title,
      startIndex: item.physicalIndex,
      endIndex: undefined,
      nodes: [],
    };

    if (structure) {
      nodes.set(structure, node);
    }

    const parentStructure = getParentStructure(structure);

    if (parentStructure && nodes.has(parentStructure)) {
      nodes.get(parentStructure)!.nodes!.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // Clean empty nodes arrays
  const cleanNode = (node: TreeNode): TreeNode => {
    if (!node.nodes || node.nodes.length === 0) {
      delete node.nodes;
    } else {
      node.nodes.forEach(cleanNode);
    }
    return node;
  };

  return rootNodes.map(cleanNode);
}

/**
 * Add preface node if document starts after page 1
 */
export function addPrefaceIfNeeded(data: TocItem[]): TocItem[] {
  if (!Array.isArray(data) || data.length === 0) return data;

  const firstItem = data[0];
  if (firstItem && firstItem.physicalIndex && firstItem.physicalIndex > 1) {
    data.unshift({
      structure: "0",
      title: "Preface",
      physicalIndex: 1,
    });
  }
  return data;
}

/**
 * Post-process TOC structure: add start/end indices and convert to tree
 */
export function postProcessing(
  structure: TocItem[],
  endPhysicalIndex: number
): TreeNode[] {
  // Convert physical_index to start_index and calculate end_index
  for (let i = 0; i < structure.length; i++) {
    const item = structure[i] as TocItem & {
      startIndex?: number;
      endIndex?: number;
      appearStart?: string;
    };
    item.startIndex = item.physicalIndex;

    if (i < structure.length - 1) {
      const nextItem = structure[i + 1] as TocItem & { appearStart?: string };
      if (nextItem.appearStart === "yes") {
        item.endIndex = (nextItem.physicalIndex || 0) - 1;
      } else {
        item.endIndex = nextItem.physicalIndex;
      }
    } else {
      item.endIndex = endPhysicalIndex;
    }
  }

  const tree = listToTree(structure);
  return tree.length > 0 ? tree : (structure as unknown as TreeNode[]);
}

/**
 * Remove specified fields from structure recursively
 */
export function removeFields(
  data: unknown,
  fields: string[] = ["text"]
): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => removeFields(item, fields));
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!fields.includes(key)) {
        result[key] = removeFields(value, fields);
      }
    }
    return result;
  }

  return data;
}

/**
 * Clean structure for output (remove internal fields)
 */
export function cleanStructurePost(data: TreeNode | TreeNode[]): void {
  if (Array.isArray(data)) {
    data.forEach(cleanStructurePost);
    return;
  }

  if (data && typeof data === "object") {
    delete (data as unknown as Record<string, unknown>).pageNumber;
    if (data.nodes) {
      cleanStructurePost(data.nodes);
    }
  }
}

/**
 * Print tree structure as TOC
 */
export function printToc(tree: TreeNode[], indent: number = 0): void {
  for (const node of tree) {
    console.log("  ".repeat(indent) + node.title);
    if (node.nodes) {
      printToc(node.nodes, indent + 1);
    }
  }
}

/**
 * Convert physical_index string to integer
 */
export function convertPhysicalIndexToInt(
  data: TocItem[] | string
): TocItem[] | number | null {
  if (typeof data === "string") {
    if (data.startsWith("<physical_index_")) {
      return parseInt(data.split("_").pop()!.replace(">", "").trim(), 10);
    }
    if (data.startsWith("physical_index_")) {
      return parseInt(data.split("_").pop()!.trim(), 10);
    }
    const num = parseInt(data, 10);
    return isNaN(num) ? null : num;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item.physicalIndex === "string") {
        const parsed = convertPhysicalIndexToInt(item.physicalIndex);
        if (typeof parsed === "number") {
          item.physicalIndex = parsed;
        }
      }
    }
  }

  return data as TocItem[];
}

/**
 * Convert page field to integer
 */
export function convertPageToInt(data: TocItem[]): TocItem[] {
  for (const item of data) {
    if (typeof item.page === "string") {
      const parsed = parseInt(item.page, 10);
      if (!isNaN(parsed)) {
        item.page = parsed;
      }
    }
  }
  return data;
}

/**
 * Reorder object keys
 */
export function reorderDict<T extends Record<string, unknown>>(
  data: T,
  keyOrder: string[]
): T {
  if (!keyOrder.length) return data;
  const result: Record<string, unknown> = {};
  for (const key of keyOrder) {
    if (key in data) {
      result[key] = data[key];
    }
  }
  return result as T;
}

/**
 * Format structure with specified key order
 */
export function formatStructure(
  structure: TreeNode | TreeNode[],
  order?: string[]
): TreeNode | TreeNode[] {
  if (!order) return structure;

  if (Array.isArray(structure)) {
    return structure.map((item) => formatStructure(item, order) as TreeNode);
  }

  if (structure.nodes) {
    structure.nodes = formatStructure(structure.nodes, order) as TreeNode[];
  }

  if (!structure.nodes || structure.nodes.length === 0) {
    delete structure.nodes;
  }

  return reorderDict(structure as unknown as Record<string, unknown>, order) as unknown as TreeNode;
}

/**
 * Create clean structure for document description (exclude text)
 */
export function createCleanStructureForDescription(
  structure: TreeNode | TreeNode[]
): TreeNode | TreeNode[] {
  if (Array.isArray(structure)) {
    return structure.map(
      (item) => createCleanStructureForDescription(item) as TreeNode
    );
  }

  const cleanNode: Partial<TreeNode> = {};

  // Only include essential fields
  const essentialFields: (keyof TreeNode)[] = [
    "title",
    "nodeId",
    "summary",
    "prefixSummary",
  ];
  for (const key of essentialFields) {
    if (key in structure) {
      (cleanNode as Record<string, unknown>)[key] = structure[key];
    }
  }

  if (structure.nodes && structure.nodes.length > 0) {
    cleanNode.nodes = createCleanStructureForDescription(
      structure.nodes
    ) as TreeNode[];
  }

  return cleanNode as TreeNode;
}

/**
 * Sanitize filename for file system
 */
export function sanitizeFilename(
  filename: string,
  replacement: string = "-"
): string {
  // Replace invalid characters
  return filename
    .replace(/[/\\:*?"<>|]/g, replacement)
    .replace(/\s+/g, replacement)
    .trim();
}

/**
 * Get first start page from text with page markers
 */
export function getFirstStartPageFromText(text: string): number {
  const match = text.match(/<start_index_(\d+)>/);
  return match && match[1] ? parseInt(match[1], 10) : -1;
}

/**
 * Get last start page from text with page markers
 */
export function getLastStartPageFromText(text: string): number {
  const matches = [...text.matchAll(/<start_index_(\d+)>/g)];
  if (matches.length === 0) return -1;
  const lastMatch = matches[matches.length - 1];
  return lastMatch && lastMatch[1] ? parseInt(lastMatch[1], 10) : -1;
}
