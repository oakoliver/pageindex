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
} from "./pageindex";

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
} from "./types";

// PDF utilities
export { parsePdf, getPdfName, type PdfInfo, type PdfPage } from "./pdf";

// OCR utilities
export {
  pdfToImages,
  pdfBufferToImages,
  ocrImage,
  ocrImages,
  parsePdfWithOcr,
  getPdfInfo,
  type OcrOptions,
} from "./ocr";

// OpenAI utilities
export {
  chatGPT,
  chatGPTWithFinishReason,
  chatGPTBatch,
  getLMStudioConfig,
  getOllamaConfig,
  type ClientConfig,
  type ChatOptions,
  type ChatResult,
} from "./openai";

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
} from "./utils";

// Markdown processing
export {
  mdToTree,
  markdownToTree,
  extractNodesFromMarkdown,
  extractNodeTextContent,
  buildTreeFromNodes,
  treeThinningForIndex,
  printTocMd,
} from "./markdown";
