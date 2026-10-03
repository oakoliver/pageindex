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
  LLMRetriesExhausted,
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
  type RawTocEntry,
} from "./utils.js";

// Tree optimization (deterministic merge)
export { mergeTree, treeCost, searchSpan, residualSpan, subtreeEnd } from "./tree-optimize.js";

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
