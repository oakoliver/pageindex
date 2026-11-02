/**
 * bun-pageindex: Types and interfaces
 */

/** Extraction mode for PDF processing */
export type ExtractionMode = "text" | "ocr";

/** OCR prompt type for GLM-OCR */
export type OcrPromptType = "text" | "formula" | "table";

/** Default model used to index documents (structure and summaries), as in upstream PageIndex (v0.4.0+) */
export const DEFAULT_INDEX_MODEL = "gpt-6-luna";

export interface PageIndexOptions {
  /** Model used to index the document (default: gpt-6-luna) */
  model?: string;
  /** Model for node summaries and the document description (default: `model`) */
  summaryModel?: string;
  /** Number of pages to check for TOC (default: 20) */
  tocCheckPageNum?: number;
  /** A PDF leaf longer than this many pages (and maxTokenNumEachNode tokens) is split with the LLM (default: 10) */
  maxPageNumEachNode?: number;
  /** A PDF leaf of at least this many tokens (and over maxPageNumEachNode pages) is split with the LLM (default: 20000) */
  maxTokenNumEachNode?: number;
  /** Add node IDs to output (default: true) */
  addNodeId?: boolean;
  /** Add summaries to nodes, using the LLM (default: true for PDFs; Markdown overrides it to false) */
  addNodeSummary?: boolean;
  /** Add document description (default: false) */
  addDocDescription?: boolean;
  /** Add raw text to nodes (default: false) */
  addNodeText?: boolean;
  /** OpenAI API key (default: from OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (e.g., LM Studio: http://localhost:1234/v1) */
  baseUrl?: string;
  /**
   * Receives progress messages (default: console.log). Pass `() => {}` to
   * silence them, or `console.error` to keep stdout clean.
   */
  logger?: (message: string) => void;
  
  // OCR-specific options
  /** Extraction mode: 'text' for native PDFs, 'ocr' for scanned PDFs (default: 'text') */
  extractionMode?: ExtractionMode;
  /** OCR model to use (default: mlx-community/GLM-OCR-bf16) */
  ocrModel?: string;
  /** OCR prompt type (default: 'text') */
  ocrPromptType?: OcrPromptType;
  /** Image DPI for OCR conversion (default: 150) */
  imageDpi?: number;
  /** Image format for OCR conversion (default: 'png') */
  imageFormat?: "png" | "jpeg";
  /** Concurrent OCR requests (default: 3) */
  ocrConcurrency?: number;
}

export interface MarkdownOptions extends PageIndexOptions {
  /** Add summaries to nodes, using the LLM (default: false, as upstream's md_to_tree) */
  addNodeSummary?: boolean;
  /** Apply tree thinning (default: false) */
  thinning?: boolean;
  /** Minimum token threshold for thinning (default: 5000) */
  thinningThreshold?: number;
  /** Token threshold for generating summaries (default: 200) */
  summaryTokenThreshold?: number;
}

export interface TreeNode {
  /** Section title; a parent's opening pages form a "<title> (intro)" child (PDF) */
  title: string;
  nodeId?: string;
  /** First page (PDF) */
  startIndex?: number;
  /** Last page (PDF); a parent's range covers its whole section */
  endIndex?: number;
  /** PDF: a leaf's summary of its pages, a parent's of its whole section; Markdown: leaves */
  summary?: string;
  prefixSummary?: string;
  text?: string;
  lineNum?: number;
  /** Titles of descendants folded into this node by the tree merge pass */
  keyItems?: string[];
  nodes?: TreeNode[];
}

export interface PageIndexResult {
  docName: string;
  docDescription?: string;
  /** Number of lines in the source (markdown only) */
  lineCount?: number;
  structure: TreeNode[];
}

export interface TocItem {
  structure?: string;
  title: string;
  page?: number;
  physicalIndex?: number;
  appearStart?: string;
  listIndex?: number;
}

export interface PageContent {
  text: string;
  tokenCount: number;
}

export interface TocCheckResult {
  tocContent: string | null;
  tocPageList: number[];
  pageIndexGivenInToc: string;
}
