/**
 * bun-pageindex: Tree building and processing
 * Functions for building, processing, and managing document tree structures
 */

import { chatGPT, getErrorStatus, isUnrecoverable } from "./openai.js";
import type { PdfPage } from "./pdf.js";
import type { TreeNode, TocItem } from "./types.js";
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
  ownPages,
  getTextOfPdfPages,
  getTextOfPdfPagesWithLabels,
  INTRO_SUFFIX,
  type RawTocEntry,
} from "./utils.js";
import { addIntroNodes, mergeTree } from "./tree-optimize.js";
import * as prompts from "./prompts.js";
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
} from "./toc.js";

export interface TreeOptions extends TocOptions {
  /** Model for node summaries and the document description (default: model) */
  summaryModel?: string;
  /** Receives progress messages (default: console.log) */
  logger?: (message: string) => void;
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
 * Add text content to tree nodes: each node's own pages. A parent's text runs
 * onto the page its first child starts on (that child's heading may sit
 * mid-page), and is empty when an intro node holds its opening pages
 * (upstream v0.2.21).
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

  const [startPage, endPage] = ownPages(node);
  node.text = getTextOfPdfPages(pages, startPage, endPage);

  if (node.nodes) {
    addNodeText(node.nodes, pages);
  }
}

/**
 * Add text content to tree nodes with page labels (own pages, as addNodeText)
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

  const [startPage, endPage] = ownPages(node);
  node.text = getTextOfPdfPagesWithLabels(pages, startPage, endPage);

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
 * Generate a summary for every node from its `text` (upstream's
 * `generate_summaries_for_structure`). The PDF pipeline no longer uses it:
 * since upstream v0.2.21 it summarizes bottom-up with `summarizeTree`.
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
  options: TreeOptions,
  { topLevelOnly = false }: { topLevelOnly?: boolean } = {}
): Promise<string> {
  // topLevelOnly: parent summaries already cover their subtrees, so the
  // description reads the top level alone (upstream v0.4.0)
  const cleanStructure = createCleanStructureForDescription(structure, topLevelOnly);
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
  /** Share of the checked items confirmed (items whose check failed are not counted) */
  accuracy: number;
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
      // A call out of retries, bad credentials or a missing model stop the
      // run (upstream v0.5.0); other failures (a per-prompt 400) skip the
      // item, which then counts neither way
      if (isUnrecoverable(error)) throw error;
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

  const checked = correct.length + incorrect.length;
  return { correct, incorrect, accuracy: checked > 0 ? correct.length / checked : 0 };
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
    let checkResult: Awaited<ReturnType<typeof checkTitleAppearance>>;
    try {
      physicalIndexInt = await singleTocItemIndexFixer(
        incorrectItem.title,
        contentRange,
        options
      );
      // Check the proposed page before it replaces the old one
      const checkItem: TocItem = {
        ...(fixed[listIndex] ?? { title: incorrectItem.title }),
        physicalIndex: physicalIndexInt ?? undefined,
        listIndex,
      };
      checkResult = await checkTitleAppearance(checkItem, pages, startIndex, options);
    } catch (error) {
      // Out of retries, bad credentials or a missing model stop the run
      // (upstream v0.5.0); any other failure drops this item from the results
      // (it is neither fixed nor re-queued)
      if (isUnrecoverable(error)) throw error;
      console.error(`Error fixing TOC item "${incorrectItem.title}":`, error);
      continue;
    }

    if (checkResult.answer === "yes" && physicalIndexInt !== null && fixed[listIndex]) {
      fixed[listIndex].physicalIndex = physicalIndexInt;
    } else {
      stillIncorrect.push({
        listIndex,
        title: incorrectItem.title,
        physicalIndex: physicalIndexInt ?? undefined,
      });
    }
  }

  return { fixed, stillIncorrect };
}

/**
 * Build a tree from placed TOC items without any LLM call: preface, page
 * ranges, intro nodes, the deterministic merge and node IDs. The PDF pipeline
 * also splits large nodes with the LLM in between (processLargeNodeRecursively).
 */
export function buildTree(
  tocItems: TocItem[],
  endPhysicalIndex: number,
  options: TreeOptions
): TreeNode[] {
  // Add preface if needed
  const withPreface = addPrefaceIfNeeded(tocItems);

  // Post-process: add start/end indices and convert to tree; give every
  // parent that opens before its first child an intro node
  const tree = addIntroNodes(postProcessing(withPreface, endPhysicalIndex));

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

// ===================== Large nodes (upstream process_large_node_recursively) =====================

type PlacedTocItem = TocItem & { startIndex?: number; endIndex?: number };

/**
 * Upstream's `meta_processor` in its `process_no_toc` mode, as large-node
 * splitting runs it over a node's pages: build entries from the content,
 * verify them, fix them (up to three rounds) when more than 60% check out, and
 * fail when fewer do. `pages` is the node's slice; `startIndex` its first page.
 */
export async function metaProcessorNoToc(
  pages: PdfPage[],
  startIndex: number,
  options: TreeOptions
): Promise<TocItem[]> {
  let items = await processNoToc(pages, startIndex, options);
  items = items.filter((item) => item.physicalIndex !== undefined && item.physicalIndex !== null);

  // As upstream verify_toc: nothing placed, or nothing past the first half
  // of the pages, scores 0 without a check
  const last = [...items].reverse().find((item) => item.physicalIndex != null)?.physicalIndex;
  let accuracy = 0;
  let incorrect: Array<{ listIndex: number; title: string; physicalIndex?: number }> = [];
  if (last !== undefined && last >= pages.length / 2) {
    ({ accuracy, incorrect } = await verifyToc(pages, items, startIndex, options));
  }
  options.logger?.(`process_no_toc accuracy: ${(accuracy * 100).toFixed(2)}%`);

  if (accuracy === 1 && incorrect.length === 0) {
    return items;
  }
  if (accuracy > 0.6 && incorrect.length > 0) {
    let current = items;
    for (let attempt = 0; attempt < 3 && incorrect.length > 0; attempt++) {
      const { fixed, stillIncorrect } = await fixIncorrectToc(current, pages, incorrect, startIndex, options);
      current = fixed;
      incorrect = stillIncorrect;
    }
    return current;
  }
  throw new Error("Processing failed");
}

/**
 * Split a leaf that is both longer than `maxPageNumEachNode` pages and at
 * least `maxTokenNumEachNode` tokens: its pages are indexed as a document of
 * their own and the entries become its children (the node keeps the pages
 * before the first one). Recurses into children. As upstream v0.2.22, a node
 * that already has children is never split, nor are pages a split above just
 * rebuilt unchanged (a "PART II" heading above "Chapter 3" no longer loops),
 * and an intro node skips its parent's heading. Mutates and returns the node.
 */
/** Steps of the large-node split, replaceable for tests or custom pipelines */
export interface LargeNodeSteps {
  /** Index a node's pages as a document of their own (default: metaProcessorNoToc) */
  metaProcessor?: (pages: PdfPage[], startIndex: number, options: TreeOptions) => Promise<TocItem[]>;
  /** Mark where each entry opens its page (default: checkTitleAppearanceInStartConcurrent) */
  checkTitleAppearanceInStart?: (items: TocItem[], pages: PdfPage[], options: TreeOptions) => Promise<TocItem[]>;
}

export async function processLargeNodeRecursively(
  node: TreeNode,
  pages: PdfPage[],
  options: TreeOptions,
  split?: [number, number],
  steps: LargeNodeSteps = {}
): Promise<TreeNode> {
  const metaProcessor = steps.metaProcessor ?? metaProcessorNoToc;
  const checkStart = steps.checkTitleAppearanceInStart ?? checkTitleAppearanceInStartConcurrent;
  const start = node.startIndex;
  const end = node.endIndex;
  if (start !== undefined && end !== undefined) {
    const nodePages = pages.slice(start - 1, end);
    const tokenNum = nodePages.reduce((sum, page) => sum + (page.tokenCount || 0), 0);

    if (
      !(node.nodes && node.nodes.length > 0) &&
      end - start > options.maxPageNumEachNode &&
      tokenNum >= options.maxTokenNumEachNode &&
      !(split && split[0] === start && split[1] === end)
    ) {
      (options.logger ?? console.log)(
        `large node: ${node.title} start_index: ${start} end_index: ${end} token_num: ${tokenNum}`
      );
      split = [start, end];

      let nodeToc = await metaProcessor(nodePages, start, options);
      nodeToc = await checkStart(nodeToc, pages, options);
      const valid = nodeToc.filter(
        (item) => item.physicalIndex !== undefined && item.physicalIndex !== null
      ) as PlacedTocItem[];

      // an intro node's pages open with its parent's heading
      const title = node.title.trim();
      const parentTitle = title.endsWith(INTRO_SUFFIX) ? title.slice(0, -INTRO_SUFFIX.length) : title;
      const firstTitle = valid[0]?.title.trim();
      if (valid.length > 0 && (firstTitle === title || firstTitle === parentTitle)) {
        node.nodes = postProcessing(valid.slice(1), end);
        node.endIndex = valid.length > 1 ? valid[1]!.startIndex : end;
      } else {
        node.nodes = postProcessing(valid, end);
        node.endIndex = valid.length > 0 ? valid[0]!.startIndex : end;
      }
    }
  }

  if (node.nodes && node.nodes.length > 0) {
    await Promise.all(
      node.nodes.map((child) => processLargeNodeRecursively(child, pages, options, split, steps))
    );
  }
  return node;
}
