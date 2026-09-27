/**
 * bun-pageindex: Tree building and processing
 * Functions for building, processing, and managing document tree structures
 */

import { chatGPT, getErrorStatus, isUnrecoverable } from "./openai";
import type { PdfPage } from "./pdf";
import type { TreeNode, TocItem } from "./types";
import {
  countTokens,
  postProcessing,
  addPrefaceIfNeeded,
  writeNodeId,
  structureToList,
  createCleanStructureForDescription,
  formatStructure,
  normalizeTocItems,
  validateChunkPhysicalIndices,
  validatePhysicalIndices,
  extractChunkMarkerSet,
  type RawTocEntry,
} from "./utils";
import { mergeTree } from "./tree-optimize";
import * as prompts from "./prompts";
import {
  tocTransformer,
  tocIndexExtractor,
  generateTocInit,
  generateTocContinue,
  addPageNumberToToc,
  checkTitleAppearance,
  checkTitleAppearanceInStartConcurrent,
  singleTocItemIndexFixer,
  type TocOptions,
} from "./toc";

export interface TreeOptions extends TocOptions {
  /** Model for node summaries and the document description (default: model) */
  summaryModel?: string;
  maxPageNumEachNode: number;
  maxTokenNumEachNode: number;
  addNodeId: boolean;
  addNodeSummary: boolean;
  addDocDescription: boolean;
  addNodeText: boolean;
}

/**
 * Split page list into groups based on token limits
 */
export function pageListToGroupText(
  pageContents: string[],
  tokenLengths: number[],
  maxTokens: number = 20000,
  overlapPage: number = 1
): string[] {
  const numTokens = tokenLengths.reduce((a, b) => a + b, 0);

  if (numTokens <= maxTokens) {
    return [pageContents.join("")];
  }

  const subsets: string[] = [];
  let currentSubset: string[] = [];
  let currentTokenCount = 0;

  const expectedPartsNum = Math.ceil(numTokens / maxTokens);
  const averageTokensPerPart = Math.ceil(
    (numTokens / expectedPartsNum + maxTokens) / 2
  );

  for (let i = 0; i < pageContents.length; i++) {
    const pageContent = pageContents[i] || "";
    const pageTokens = tokenLengths[i] || 0;

    if (currentTokenCount + pageTokens > averageTokensPerPart) {
      subsets.push(currentSubset.join(""));
      // Start new subset from overlap
      const overlapStart = Math.max(i - overlapPage, 0);
      currentSubset = pageContents.slice(overlapStart, i);
      currentTokenCount = tokenLengths
        .slice(overlapStart, i)
        .reduce((a, b) => a + b, 0);
    }

    currentSubset.push(pageContent);
    currentTokenCount += pageTokens;
  }

  if (currentSubset.length > 0) {
    subsets.push(currentSubset.join(""));
  }

  return subsets;
}

/**
 * Extract matching page pairs from TOC
 */
function extractMatchingPagePairs(
  tocPage: TocItem[],
  tocPhysicalIndex: TocItem[],
  startPageIndex: number
): Array<{ title: string; page: number; physicalIndex: number }> {
  const pairs: Array<{ title: string; page: number; physicalIndex: number }> =
    [];

  for (const phyItem of tocPhysicalIndex) {
    for (const pageItem of tocPage) {
      if (phyItem.title === pageItem.title) {
        const physicalIndex = phyItem.physicalIndex;
        if (physicalIndex !== undefined && physicalIndex >= startPageIndex) {
          pairs.push({
            title: phyItem.title,
            page: pageItem.page || 0,
            physicalIndex,
          });
        }
      }
    }
  }

  return pairs;
}

/**
 * Calculate page offset from matching pairs
 */
function calculatePageOffset(
  pairs: Array<{ page: number; physicalIndex: number }>
): number | null {
  const differences: number[] = [];

  for (const pair of pairs) {
    const difference = pair.physicalIndex - pair.page;
    differences.push(difference);
  }

  if (differences.length === 0) return null;

  // Find most common difference
  const counts = new Map<number, number>();
  for (const diff of differences) {
    counts.set(diff, (counts.get(diff) || 0) + 1);
  }

  let maxCount = 0;
  let mostCommon = 0;
  for (const [diff, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = diff;
    }
  }

  return mostCommon;
}

/**
 * Add page offset to TOC JSON
 */
function addPageOffsetToTocJson(data: TocItem[], offset: number): TocItem[] {
  for (const item of data) {
    if (item.page !== undefined && typeof item.page === "number") {
      item.physicalIndex = item.page + offset;
      delete item.page;
    }
  }
  return data;
}

/**
 * Process document without existing TOC
 */
export async function processNoToc(
  pages: PdfPage[],
  startIndex: number,
  options: TreeOptions
): Promise<TocItem[]> {
  const pageContents: string[] = [];
  const tokenLengths: number[] = [];

  for (let pageIndex = startIndex; pageIndex < startIndex + pages.length; pageIndex++) {
    const pageText = `<physical_index_${pageIndex}>\n${pages[pageIndex - startIndex]?.text || ""}\n<physical_index_${pageIndex}>\n\n`;
    pageContents.push(pageText);
    tokenLengths.push(countTokens(pageText));
  }

  const groupTexts = pageListToGroupText(pageContents, tokenLengths);

  // Only keep physical indices whose markers are in the chunk the model saw
  // and that fall inside the document's page range
  const firstGroup = groupTexts[0] || "";
  let tocWithPageNumber = await generateTocInit(firstGroup, options);
  tocWithPageNumber = validateChunkPhysicalIndices(tocWithPageNumber, firstGroup);
  tocWithPageNumber = validatePhysicalIndices(tocWithPageNumber, pages.length, startIndex);

  for (let i = 1; i < groupTexts.length; i++) {
    const groupText = groupTexts[i] || "";
    let additional = await generateTocContinue(tocWithPageNumber, groupText, options);
    additional = validateChunkPhysicalIndices(additional, groupText);
    additional = validatePhysicalIndices(additional, pages.length, startIndex);
    tocWithPageNumber.push(...additional);
  }

  return normalizeTocItems(tocWithPageNumber);
}

/**
 * Process TOC without page numbers
 */
export async function processTocNoPageNumbers(
  tocContent: string,
  pages: PdfPage[],
  startIndex: number,
  options: TreeOptions
): Promise<TocItem[]> {
  const pageContents: string[] = [];
  const tokenLengths: number[] = [];

  const tocItems = await tocTransformer(tocContent, options);

  for (let pageIndex = startIndex; pageIndex < startIndex + pages.length; pageIndex++) {
    const pageText = `<physical_index_${pageIndex}>\n${pages[pageIndex - startIndex]?.text || ""}\n<physical_index_${pageIndex}>\n\n`;
    pageContents.push(pageText);
    tokenLengths.push(countTokens(pageText));
  }

  const groupTexts = pageListToGroupText(pageContents, tokenLengths);

  // Working copy in the LLM's own (snake_case) shape
  const tocWithPageNumber: RawTocEntry[] = tocItems.map((item) => {
    const entry: RawTocEntry = { structure: item.structure ?? null, title: item.title };
    if (item.page !== undefined) entry.page = item.page;
    return entry;
  });

  const sameEntry = (a: RawTocEntry | undefined, b: RawTocEntry): boolean =>
    String(a?.structure ?? "") === String(b.structure ?? "") &&
    String(a?.title ?? "") === String(b.title ?? "");

  for (const groupText of groupTexts) {
    const llmResult = await addPageNumberToToc(groupText, tocWithPageNumber, options);
    if (llmResult.length !== tocWithPageNumber.length) {
      throw new Error("LLM returned a different number of TOC entries than expected.");
    }
    if (tocWithPageNumber.some((current, idx) => !sameEntry(llmResult[idx], current))) {
      throw new Error("LLM returned reordered or modified TOC entries.");
    }

    // Only fill entries that are still unplaced, and only with markers from this chunk
    const validIndices = extractChunkMarkerSet(groupText);
    tocWithPageNumber.forEach((current, idx) => {
      if (current.physical_index !== null && current.physical_index !== undefined) return;
      const raw = llmResult[idx]?.physical_index;
      if (raw === null || raw === undefined) return;
      const match = String(raw).trim().match(/^<physical_index_(\d+)>$/);
      if (!match || !validIndices.has(parseInt(match[1]!, 10))) return;
      current.physical_index = raw;
    });
  }

  return normalizeTocItems(tocWithPageNumber);
}

/**
 * Process TOC with page numbers
 */
export async function processTocWithPageNumbers(
  tocContent: string,
  tocPageList: number[],
  pages: PdfPage[],
  options: TreeOptions
): Promise<TocItem[]> {
  const tocWithPageNumber = await tocTransformer(tocContent, options);

  // Remove page numbers for physical index extraction
  const tocNoPageNumber = tocWithPageNumber.map((item) => {
    const newItem = { ...item };
    delete newItem.page;
    return newItem;
  });

  const startPageIndex = (tocPageList[tocPageList.length - 1] || 0) + 1;
  let mainContent = "";

  for (
    let pageIndex = startPageIndex;
    pageIndex < Math.min(startPageIndex + options.tocCheckPageNum, pages.length);
    pageIndex++
  ) {
    mainContent += `<physical_index_${pageIndex + 1}>\n${pages[pageIndex]?.text || ""}\n<physical_index_${pageIndex + 1}>\n\n`;
  }

  const tocWithPhysicalIndex = await tocIndexExtractor(tocNoPageNumber, mainContent, options);

  const matchingPairs = extractMatchingPagePairs(
    tocWithPageNumber,
    tocWithPhysicalIndex,
    startPageIndex
  );

  const offset = calculatePageOffset(matchingPairs);

  if (offset !== null) {
    addPageOffsetToTocJson(tocWithPageNumber, offset);
  }

  return tocWithPageNumber;
}

/**
 * Add text content to tree nodes
 */
export function addNodeText(
  node: TreeNode | TreeNode[],
  pages: PdfPage[]
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      addNodeText(item, pages);
    }
    return;
  }

  const startPage = node.startIndex;
  const endPage = node.endIndex;

  if (startPage !== undefined && endPage !== undefined) {
    let text = "";
    for (let i = startPage - 1; i < endPage && i < pages.length; i++) {
      text += pages[i]?.text || "";
    }
    node.text = text;
  }

  if (node.nodes) {
    addNodeText(node.nodes, pages);
  }
}

/**
 * Add text content to tree nodes with page labels
 */
export function addNodeTextWithLabels(
  node: TreeNode | TreeNode[],
  pages: PdfPage[]
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      addNodeTextWithLabels(item, pages);
    }
    return;
  }

  const startPage = node.startIndex;
  const endPage = node.endIndex;

  if (startPage !== undefined && endPage !== undefined) {
    let text = "";
    for (let i = startPage - 1; i < endPage && i < pages.length; i++) {
      text += `<physical_index_${i + 1}>\n${pages[i]?.text || ""}\n<physical_index_${i + 1}>\n`;
    }
    node.text = text;
  }

  if (node.nodes) {
    addNodeTextWithLabels(node.nodes, pages);
  }
}

/**
 * Generate summary for a single node
 */
async function generateNodeSummary(
  node: TreeNode,
  options: TreeOptions
): Promise<string> {
  if (!node.text) return "";

  const prompt = prompts.generateNodeSummaryPrompt(node.text);
  return chatGPT({
    model: options.summaryModel || options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
}

/**
 * Generate summaries for all nodes in structure
 */
export async function generateSummariesForStructure(
  structure: TreeNode[],
  options: TreeOptions
): Promise<void> {
  const nodes = structureToList(structure);

  // Process in batches for better performance
  const batchSize = 5;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const summaries = await Promise.allSettled(
      batch.map((node) => generateNodeSummary(node as TreeNode, options))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = summaries[j]!;
      if (result.status === "rejected") {
        // Dead credentials or a missing model fail the run; per-prompt
        // failures (e.g. context overflow) leave an empty summary
        if (isUnrecoverable(result.reason)) {
          throw result.reason;
        }
        (batch[j] as TreeNode).summary = "";
      } else {
        (batch[j] as TreeNode).summary = result.value;
      }
    }
  }

  if (nodes.length > 0 && !nodes.some((node) => node.summary)) {
    throw new Error(
      "Summary generation failed for all nodes " +
        "(every summary call failed or returned empty; " +
        "check the model and its context limits)"
    );
  }
}

/**
 * Generate document description from structure
 */
export async function generateDocDescription(
  structure: TreeNode[],
  options: TreeOptions
): Promise<string> {
  const cleanStructure = createCleanStructureForDescription(structure);
  const prompt = prompts.generateDocDescriptionPrompt(JSON.stringify(cleanStructure));

  try {
    return await chatGPT({
      model: options.summaryModel || options.model,
      prompt,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
  } catch (error) {
    // Per-prompt 400: the whole-tree prompt overran the context; the indexed
    // document survives without a description
    if (getErrorStatus(error) === 400) {
      return "";
    }
    throw error;
  }
}

/**
 * Verify TOC by checking title appearances
 */
export async function verifyToc(
  pages: PdfPage[],
  listResult: TocItem[],
  startIndex: number,
  options: TreeOptions
): Promise<{
  correct: TocItem[];
  incorrect: Array<{ listIndex: number; title: string; physicalIndex?: number }>;
}> {
  const correct: TocItem[] = [];
  const incorrect: Array<{ listIndex: number; title: string; physicalIndex?: number }> = [];

  for (let i = 0; i < listResult.length; i++) {
    const item = listResult[i];
    if (!item) continue;
    
    const itemWithIndex = { ...item, listIndex: i };
    let result: Awaited<ReturnType<typeof checkTitleAppearance>>;
    try {
      result = await checkTitleAppearance(itemWithIndex, pages, startIndex, options);
    } catch (error) {
      // Skip items whose check failed (LLM error); they count neither way
      console.error(`Error verifying TOC item "${item.title}":`, error);
      continue;
    }

    if (result.answer === "yes") {
      correct.push(item);
    } else {
      incorrect.push({
        listIndex: i,
        title: item.title,
        physicalIndex: item.physicalIndex,
      });
    }
  }

  return { correct, incorrect };
}

/**
 * Fix incorrect TOC items
 */
export async function fixIncorrectToc(
  tocWithPageNumber: TocItem[],
  pages: PdfPage[],
  incorrectResults: Array<{ listIndex: number; title: string; physicalIndex?: number }>,
  startIndex: number,
  options: TreeOptions
): Promise<{
  fixed: TocItem[];
  stillIncorrect: Array<{ listIndex: number; title: string; physicalIndex?: number }>;
}> {
  const fixed = [...tocWithPageNumber];
  const stillIncorrect: Array<{ listIndex: number; title: string; physicalIndex?: number }> = [];
  const incorrectIndices = new Set(incorrectResults.map((r) => r.listIndex));
  const endIndex = pages.length + startIndex - 1;

  for (const incorrectItem of incorrectResults) {
    const { listIndex } = incorrectItem;

    // Find previous correct physical index
    let prevCorrect = startIndex - 1;
    for (let i = listIndex - 1; i >= 0; i--) {
      if (!incorrectIndices.has(i)) {
        const item = tocWithPageNumber[i];
        if (item?.physicalIndex !== undefined) {
          prevCorrect = item.physicalIndex;
          break;
        }
      }
    }

    // Find next correct physical index
    let nextCorrect = endIndex;
    for (let i = listIndex + 1; i < tocWithPageNumber.length; i++) {
      if (!incorrectIndices.has(i)) {
        const item = tocWithPageNumber[i];
        if (item?.physicalIndex !== undefined) {
          nextCorrect = item.physicalIndex;
          break;
        }
      }
    }

    // Build content for the range
    const pageContents: string[] = [];
    for (let pageIndex = prevCorrect; pageIndex <= nextCorrect; pageIndex++) {
      const idx = pageIndex - startIndex;
      if (idx >= 0 && idx < pages.length) {
        pageContents.push(
          `<physical_index_${pageIndex}>\n${pages[idx]?.text || ""}\n<physical_index_${pageIndex}>\n\n`
        );
      }
    }

    const contentRange = pageContents.join("");
    let physicalIndexInt: number | null;
    try {
      physicalIndexInt = await singleTocItemIndexFixer(
        incorrectItem.title,
        contentRange,
        options
      );
    } catch (error) {
      // An LLM failure drops this item from the results (it is neither fixed nor re-queued)
      console.error(`Error fixing TOC item "${incorrectItem.title}":`, error);
      continue;
    }

    if (physicalIndexInt !== null && fixed[listIndex]) {
      fixed[listIndex].physicalIndex = physicalIndexInt;

      // Verify the fix
      const checkItem = { ...fixed[listIndex]!, listIndex };
      let checkResult: Awaited<ReturnType<typeof checkTitleAppearance>>;
      try {
        checkResult = await checkTitleAppearance(checkItem, pages, startIndex, options);
      } catch (error) {
        console.error(`Error checking fixed TOC item "${incorrectItem.title}":`, error);
        continue;
      }

      if (checkResult.answer !== "yes") {
        stillIncorrect.push({
          listIndex,
          title: incorrectItem.title,
          physicalIndex: physicalIndexInt,
        });
      }
    } else {
      stillIncorrect.push(incorrectItem);
    }
  }

  return { fixed, stillIncorrect };
}

/**
 * Build final tree structure from TOC items
 */
export function buildTree(
  tocItems: TocItem[],
  endPhysicalIndex: number,
  options: TreeOptions
): TreeNode[] {
  // Add preface if needed
  const withPreface = addPrefaceIfNeeded(tocItems);

  // Post-process: add start/end indices and convert to tree
  const tree = postProcessing(withPreface, endPhysicalIndex);

  // Collapse subtrees that do not beat a linear scan (deterministic, no LLM)
  mergeTree(tree);

  // Add node IDs if requested
  if (options.addNodeId) {
    writeNodeId(tree);
  }

  // Format structure with preferred key order
  return formatStructure(tree, PDF_KEY_ORDER) as TreeNode[];
}

/** Output key order for PDF trees */
export const PDF_KEY_ORDER = [
  "title",
  "nodeId",
  "startIndex",
  "endIndex",
  "keyItems",
  "summary",
  "text",
  "nodes",
];
