/**
 * Test for bun-pageindex markdown parsing
 */

import { describe, test, expect } from "bun:test";
import {
  extractNodesFromMarkdown,
  extractNodeTextContent,
  buildTreeFromNodes,
  treeThinningForIndex,
  updateNodeListWithTextTokenCount,
} from "../src/markdown";
import { countTokens } from "../src/utils";

const sampleMarkdown = `# Document Title

This is the introduction.

## Chapter 1

This is chapter 1 content.

### Section 1.1

Section 1.1 content here.

### Section 1.2

Section 1.2 content here with more text to make it longer.

## Chapter 2

Chapter 2 content.

### Section 2.1

Some content in section 2.1.

\`\`\`javascript
// Code block should not be parsed as headers
# This is not a header
## Neither is this
\`\`\`

More content after the code block.
`;

describe("Markdown Node Extraction", () => {
  test("extracts header nodes correctly", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    
    expect(nodeList.length).toBe(6);
    expect(nodeList[0]?.nodeTitle).toBe("Document Title");
    expect(nodeList[1]?.nodeTitle).toBe("Chapter 1");
    expect(nodeList[2]?.nodeTitle).toBe("Section 1.1");
    expect(nodeList[3]?.nodeTitle).toBe("Section 1.2");
    expect(nodeList[4]?.nodeTitle).toBe("Chapter 2");
    expect(nodeList[5]?.nodeTitle).toBe("Section 2.1");
  });

  test("ignores headers inside code blocks", () => {
    const { nodeList } = extractNodesFromMarkdown(sampleMarkdown);
    
    // Should not include "# This is not a header" or "## Neither is this"
    const titles = nodeList.map(n => n.nodeTitle);
    expect(titles).not.toContain("This is not a header");
    expect(titles).not.toContain("Neither is this");
  });

  test("extracts line numbers correctly", () => {
    const { nodeList } = extractNodesFromMarkdown(sampleMarkdown);
    
    // Line 1 is "# Document Title"
    expect(nodeList[0]?.lineNum).toBe(1);
  });
});

describe("Node Text Extraction", () => {
  test("extracts text content for each node", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    const nodesWithContent = extractNodeTextContent(nodeList, lines);
    
    expect(nodesWithContent.length).toBe(6);
    expect(nodesWithContent[0]?.text).toContain("Document Title");
    expect(nodesWithContent[0]?.text).toContain("This is the introduction");
    expect(nodesWithContent[0]?.level).toBe(1);
    
    expect(nodesWithContent[1]?.level).toBe(2);
    expect(nodesWithContent[2]?.level).toBe(3);
  });
});

describe("Tree Building", () => {
  test("builds tree structure from flat nodes", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    const nodesWithContent = extractNodeTextContent(nodeList, lines);
    const tree = buildTreeFromNodes(nodesWithContent);
    
    // Should have 1 root node (Document Title)
    expect(tree.length).toBe(1);
    expect(tree[0]?.title).toBe("Document Title");
    
    // Document Title should have 2 children (Chapter 1, Chapter 2)
    expect(tree[0]?.nodes?.length).toBe(2);
    expect(tree[0]?.nodes?.[0]?.title).toBe("Chapter 1");
    expect(tree[0]?.nodes?.[1]?.title).toBe("Chapter 2");
    
    // Chapter 1 should have 2 children (Section 1.1, Section 1.2)
    expect(tree[0]?.nodes?.[0]?.nodes?.length).toBe(2);
    expect(tree[0]?.nodes?.[0]?.nodes?.[0]?.title).toBe("Section 1.1");
    expect(tree[0]?.nodes?.[0]?.nodes?.[1]?.title).toBe("Section 1.2");
  });

  test("assigns node IDs", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    const nodesWithContent = extractNodeTextContent(nodeList, lines);
    const tree = buildTreeFromNodes(nodesWithContent);
    
    expect(tree[0]?.nodeId).toBe("0001");
    expect(tree[0]?.nodes?.[0]?.nodeId).toBe("0002");
  });
});

describe("Tree Thinning", () => {
  test("updates token counts correctly", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    const nodesWithContent = extractNodeTextContent(nodeList, lines);
    const withTokenCounts = updateNodeListWithTextTokenCount(nodesWithContent);
    
    // All nodes should have textTokenCount
    for (const node of withTokenCounts) {
      expect(node.textTokenCount).toBeGreaterThan(0);
    }
  });

  test("merges small nodes with thinning", () => {
    const { nodeList, lines } = extractNodesFromMarkdown(sampleMarkdown);
    let nodesWithContent = extractNodeTextContent(nodeList, lines);
    nodesWithContent = updateNodeListWithTextTokenCount(nodesWithContent);
    
    // Apply aggressive thinning (high threshold)
    const thinned = treeThinningForIndex(nodesWithContent, 10000);
    
    // Thinned result should have fewer nodes
    expect(thinned.length).toBeLessThanOrEqual(nodesWithContent.length);
  });
});

describe("Token Counting", () => {
  test("counts tokens approximately", () => {
    const text = "Hello world this is a test.";
    const tokens = countTokens(text);
    
    // Should be approximately text.length / 4
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(text.length);
  });

  test("handles empty text", () => {
    expect(countTokens("")).toBe(0);
  });
});
