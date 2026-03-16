/**
 * bun-pageindex: Types and interfaces
 */

/** Extraction mode for PDF processing */
export type ExtractionMode = "text" | "ocr";

/** OCR prompt type for GLM-OCR */
export type OcrPromptType = "text" | "formula" | "table";

export interface PageIndexOptions {
  /** OpenAI model to use for reasoning (default: gpt-4o-2024-11-20) */
  model?: string;
  /** Number of pages to check for TOC (default: 20) */
  tocCheckPageNum?: number;
  /** Max pages per node before splitting (default: 10) */
  maxPageNumEachNode?: number;
  /** Max tokens per node before splitting (default: 20000) */
  maxTokenNumEachNode?: number;
  /** Add node IDs to output (default: true) */
  addNodeId?: boolean;
  /** Add summaries to nodes (default: true) */
  addNodeSummary?: boolean;
  /** Add document description (default: false) */
  addDocDescription?: boolean;
  /** Add raw text to nodes (default: false) */
  addNodeText?: boolean;
  /** OpenAI API key (default: from OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (e.g., LM Studio: http://localhost:1234/v1) */
  baseUrl?: string;
  
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
  /** Apply tree thinning (default: false) */
  thinning?: boolean;
  /** Minimum token threshold for thinning (default: 5000) */
  thinningThreshold?: number;
  /** Token threshold for generating summaries (default: 200) */
  summaryTokenThreshold?: number;
}

export interface TreeNode {
  title: string;
  nodeId?: string;
  startIndex?: number;
  endIndex?: number;
  summary?: string;
  prefixSummary?: string;
  text?: string;
  lineNum?: number;
  nodes?: TreeNode[];
}

export interface PageIndexResult {
  docName: string;
  docDescription?: string;
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
