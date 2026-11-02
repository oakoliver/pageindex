/**
 * bun-pageindex
 * Bun-native vectorless, reasoning-based RAG for document understanding
 *
 * @author Antonio Oliveira <antonio@oakoliver.com> (https://oakoliver.com)
 * @license MIT
 */

// Main API exports
export {
  PageIndex,
  createPageIndex,
  indexPdf,
  indexPdfWithLMStudio,
  indexPdfWithOcr,
  indexPdfWithLMStudioOcr,
} from "./pageindex.js";

// Types
export type {
  PageIndexOptions,
  MarkdownOptions,
  TreeNode,
  PageIndexResult,
  TocItem,
  PageContent,
  TocCheckResult,
  ExtractionMode,
  OcrPromptType,
} from "./types.js";
export { DEFAULT_INDEX_MODEL } from "./types.js";

// PDF utilities
export { parsePdf, getPdfName, type PdfInfo, type PdfPage } from "./pdf.js";

// OCR utilities
export {
  pdfToImages,
  pdfBufferToImages,
  ocrImage,
  ocrImages,
  parsePdfWithOcr,
  getPdfInfo,
  type OcrOptions,
} from "./ocr.js";

// OpenAI utilities
export {
  chatGPT,
  chatGPTWithFinishReason,
  chatGPTBatch,
  getLMStudioConfig,
  getOllamaConfig,
  setChatClient,
  isUnrecoverable,
  shouldRetry,
  retryAfter,
  retryDelay,
  LLMRetriesExhausted,
  RETRY_STATUS,
  INDEX_RETRIES,
  INDEX_MAX_DELAY,
  type ChatClient,
  type ClientConfig,
  type ChatOptions,
  type ChatResult,
} from "./openai.js";

// Tree utilities
export {
  writeNodeId,
  getNodes,
  structureToList,
  getLeafNodes,
  isLeafNode,
  listToTree,
  postProcessing,
  printToc,
  countTokens,
  extractJson,
  formatStructure,
  removeFields,
  parsePhysicalIndex,
  validatePhysicalIndices,
  validateChunkPhysicalIndices,
  extractChunkMarkerSet,
  normalizeTocItems,
  INTRO_SUFFIX,
  introTitle,
  isIntro,
  ownPages,
  coverSubtreeRanges,
  getTextOfPdfPages,
  getNode,
  getNodeParent,
  getNodePath,
  getNodeMap,
  createNodeMapping,
  type RawTocEntry,
  type NodeMapping,
} from "./utils.js";

// Tree building (PDF)
export {
  buildTree,
  addNodeText,
  processLargeNodeRecursively,
  metaProcessorNoToc,
  generateDocDescription,
  type LargeNodeSteps,
} from "./tree.js";

// Bottom-up summaries (PDF)
export {
  summarizeTree,
  fallbackSummary,
  getIntroText,
  parseSummary,
  SUMMARY_CONCURRENCY,
  STANDARD_SUMMARY_CONCURRENCY,
  SUMMARY_INTRO_MAX_PAGES,
  SUMMARY_MAX_WORDS,
  type SummarizeTreeOptions,
} from "./summary.js";

// Tree optimization (deterministic merge, intro nodes)
export {
  mergeTree,
  treeCost,
  searchSpan,
  residualSpan,
  subtreeEnd,
  addIntroNodes,
  headingAtPageStart,
  normalize,
} from "./tree-optimize.js";

// Prompt-injection hardening
export { secureDocText, sanitizeDocText, wrapDocText, SYSTEM_HARDENING } from "./prompts.js";

// Markdown processing
export {
  mdToTree,
  markdownToTree,
  extractNodesFromMarkdown,
  extractNodeTextContent,
  buildTreeFromNodes,
  treeThinningForIndex,
  printTocMd,
  countMarkdownLines,
  type MarkdownHeading,
} from "./markdown.js";
