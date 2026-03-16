/**
 * Test for bun-pageindex utility functions
 */

import { describe, test, expect } from "bun:test";
import {
  countTokens,
  extractJson,
  getJsonContent,
  writeNodeId,
  getNodes,
  structureToList,
  getLeafNodes,
  isLeafNode,
  listToTree,
  postProcessing,
  reorderDict,
  formatStructure,
  addPrefaceIfNeeded,
  convertPhysicalIndexToInt,
  convertPageToInt,
} from "../src/utils";
import type { TreeNode, TocItem } from "../src/types";

describe("Token Counting", () => {
  test("counts tokens for basic text", () => {
    const text = "Hello world";
    const tokens = countTokens(text);
    expect(tokens).toBeGreaterThan(0);
    // Approximately text.length / 4
    expect(tokens).toBeLessThanOrEqual(text.length);
  });

  test("handles empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  test("handles long text", () => {
    const longText = "a".repeat(1000);
    const tokens = countTokens(longText);
    expect(tokens).toBe(250); // 1000 / 4
  });
});

describe("JSON Extraction", () => {
  test("extracts JSON from code blocks", () => {
    const content = '```json\n{"key": "value"}\n```';
    const json = getJsonContent(content);
    expect(json).toBe('{"key": "value"}');
  });

  test("handles raw JSON", () => {
    const content = '{"key": "value"}';
    const json = getJsonContent(content);
    expect(json).toBe('{"key": "value"}');
  });

  test("parses JSON with extractJson", () => {
    const content = '```json\n{"key": "value"}\n```';
    const parsed = extractJson<{ key: string }>(content);
    expect(parsed).toEqual({ key: "value" });
  });

  test("converts Python None to null", () => {
    const content = '{"key": None}';
    const parsed = extractJson<{ key: null }>(content);
    expect(parsed).toEqual({ key: null });
  });

  test("converts Python True/False to true/false", () => {
    const content = '{"a": True, "b": False}';
    const parsed = extractJson<{ a: boolean; b: boolean }>(content);
    expect(parsed).toEqual({ a: true, b: false });
  });

  test("handles trailing commas", () => {
    const content = '{"key": "value",}';
    const parsed = extractJson<{ key: string }>(content);
    expect(parsed).toEqual({ key: "value" });
  });

  test("returns null for invalid JSON", () => {
    const content = "not valid json";
    const parsed = extractJson(content);
    expect(parsed).toBeNull();
  });
});

describe("Node ID Writing", () => {
  test("writes node IDs to tree", () => {
    const tree: TreeNode[] = [
      { title: "Root", nodes: [{ title: "Child 1" }, { title: "Child 2" }] },
    ];
    writeNodeId(tree);
    
    expect(tree[0]?.nodeId).toBe("0000");
    expect(tree[0]?.nodes?.[0]?.nodeId).toBe("0001");
    expect(tree[0]?.nodes?.[1]?.nodeId).toBe("0002");
  });

  test("continues numbering from specified start", () => {
    const tree: TreeNode[] = [{ title: "Node" }];
    writeNodeId(tree, 10);
    expect(tree[0]?.nodeId).toBe("0010");
  });
});

describe("Node Extraction", () => {
  const sampleTree: TreeNode[] = [
    {
      title: "Root",
      nodeId: "0000",
      nodes: [
        { title: "Child 1", nodeId: "0001" },
        {
          title: "Child 2",
          nodeId: "0002",
          nodes: [{ title: "Grandchild", nodeId: "0003" }],
        },
      ],
    },
  ];

  test("getNodes returns all nodes flattened", () => {
    const nodes = getNodes(sampleTree);
    expect(nodes.length).toBe(4);
  });

  test("structureToList returns all nodes", () => {
    const nodes = structureToList(sampleTree);
    expect(nodes.length).toBe(4);
  });

  test("getLeafNodes returns only leaf nodes", () => {
    const leaves = getLeafNodes(sampleTree);
    expect(leaves.length).toBe(2);
    expect(leaves[0]?.title).toBe("Child 1");
    expect(leaves[1]?.title).toBe("Grandchild");
  });

  test("isLeafNode correctly identifies leaf nodes", () => {
    expect(isLeafNode(sampleTree, "0001")).toBe(true);
    expect(isLeafNode(sampleTree, "0003")).toBe(true);
    expect(isLeafNode(sampleTree, "0000")).toBe(false);
    expect(isLeafNode(sampleTree, "0002")).toBe(false);
  });
});

describe("TOC Processing", () => {
  test("listToTree converts flat list to tree", () => {
    const items: TocItem[] = [
      { structure: "1", title: "Chapter 1", physicalIndex: 1 },
      { structure: "1.1", title: "Section 1.1", physicalIndex: 5 },
      { structure: "1.2", title: "Section 1.2", physicalIndex: 10 },
      { structure: "2", title: "Chapter 2", physicalIndex: 15 },
    ];

    const tree = listToTree(items);
    expect(tree.length).toBe(2);
    expect(tree[0]?.title).toBe("Chapter 1");
    expect(tree[0]?.nodes?.length).toBe(2);
    expect(tree[1]?.title).toBe("Chapter 2");
  });

  test("addPrefaceIfNeeded adds preface when document starts after page 1", () => {
    const items: TocItem[] = [
      { structure: "1", title: "Chapter 1", physicalIndex: 5 },
    ];

    const result = addPrefaceIfNeeded(items);
    expect(result.length).toBe(2);
    expect(result[0]?.title).toBe("Preface");
    expect(result[0]?.physicalIndex).toBe(1);
  });

  test("addPrefaceIfNeeded does not add preface when document starts at page 1", () => {
    const items: TocItem[] = [
      { structure: "1", title: "Chapter 1", physicalIndex: 1 },
    ];

    const result = addPrefaceIfNeeded(items);
    expect(result.length).toBe(1);
  });

  test("convertPhysicalIndexToInt converts string indices", () => {
    const items: TocItem[] = [
      { title: "Test", physicalIndex: "<physical_index_5>" as unknown as number },
    ];
    
    const result = convertPhysicalIndexToInt(items) as TocItem[];
    expect(result[0]?.physicalIndex).toBe(5);
  });

  test("convertPageToInt converts string pages", () => {
    const items: TocItem[] = [
      { title: "Test", page: "10" as unknown as number },
    ];
    
    const result = convertPageToInt(items);
    expect(result[0]?.page).toBe(10);
  });
});

describe("Structure Formatting", () => {
  test("reorderDict reorders keys", () => {
    const obj = { c: 3, a: 1, b: 2 };
    const result = reorderDict(obj, ["a", "b", "c"]);
    const keys = Object.keys(result);
    expect(keys).toEqual(["a", "b", "c"]);
  });

  test("formatStructure applies key order recursively", () => {
    const tree: TreeNode[] = [
      {
        title: "Root",
        nodeId: "0001",
        startIndex: 1,
        nodes: [{ title: "Child", nodeId: "0002", startIndex: 2 }],
      },
    ];

    const result = formatStructure(tree, ["nodeId", "title", "startIndex", "nodes"]) as TreeNode[];
    const rootKeys = Object.keys(result[0] as object);
    expect(rootKeys[0]).toBe("nodeId");
    expect(rootKeys[1]).toBe("title");
  });
});
