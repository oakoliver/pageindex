/**
 * bun-pageindex: Main PageIndex API
 * Primary entry point for PDF document indexing
 */

import { parsePdf, getPdfName, type PdfInfo, type PdfPage } from "./pdf.js";
import { parsePdfWithOcr, type OcrOptions } from "./ocr.js";
import { checkToc, checkTitleAppearanceInStartConcurrent, type TocOptions } from "./toc.js";
import {
  processNoToc,
  processTocNoPageNumbers,
  processTocWithPageNumbers,
  buildTree,
  addNodeText,
  generateSummariesForStructure,
  generateDocDescription,
  verifyToc,
  fixIncorrectToc,
  PDF_KEY_ORDER,
  type TreeOptions,
} from "./tree.js";
import { convertPhysicalIndexToInt, formatStructure } from "./utils.js";
import { DEFAULT_INDEX_MODEL } from "./types.js";
import type { PageIndexOptions, PageIndexResult, TreeNode, TocItem, ExtractionMode } from "./types.js";

interface InternalOptions extends TreeOptions {
  extractionMode: ExtractionMode;
  ocrModel: string;
  ocrPromptType: "text" | "formula" | "table";
  imageDpi: number;
  imageFormat: "png" | "jpeg";
  ocrConcurrency: number;
}

/** Local OpenAI-compatible endpoint presets (LM Studio, Ollama). */
export const LMSTUDIO_ENDPOINT = { baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" } as const;
export const OLLAMA_ENDPOINT = { baseUrl: "http://localhost:11434/v1", apiKey: "ollama" } as const;

const DEFAULT_OPTIONS: Required<Omit<PageIndexOptions, "apiKey" | "baseUrl" | "summaryModel">> = {
  model: DEFAULT_INDEX_MODEL,
  tocCheckPageNum: 20,
  maxPageNumEachNode: 10,
  maxTokenNumEachNode: 20000,
  addNodeId: true,
  addNodeSummary: true,
  addDocDescription: false,
  addNodeText: false,
  // OCR defaults
  extractionMode: "text",
  ocrModel: "mlx-community/GLM-OCR-bf16",
  ocrPromptType: "text",
  imageDpi: 150,
  imageFormat: "png",
  ocrConcurrency: 3,
};

/**
 * Main PageIndex class for processing PDFs
 * Supports both text extraction (native PDFs) and OCR mode (scanned PDFs)
 */
export class PageIndex {
  private options: InternalOptions;

  constructor(options: PageIndexOptions = {}) {
    this.options = {
      model: options.model || DEFAULT_OPTIONS.model,
      summaryModel: options.summaryModel || undefined,
      tocCheckPageNum: options.tocCheckPageNum || DEFAULT_OPTIONS.tocCheckPageNum,
      maxPageNumEachNode: options.maxPageNumEachNode || DEFAULT_OPTIONS.maxPageNumEachNode,
      maxTokenNumEachNode: options.maxTokenNumEachNode || DEFAULT_OPTIONS.maxTokenNumEachNode,
      addNodeId: options.addNodeId ?? DEFAULT_OPTIONS.addNodeId,
      addNodeSummary: options.addNodeSummary ?? DEFAULT_OPTIONS.addNodeSummary,
      addDocDescription: options.addDocDescription ?? DEFAULT_OPTIONS.addDocDescription,
      addNodeText: options.addNodeText ?? DEFAULT_OPTIONS.addNodeText,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      // OCR options
      extractionMode: options.extractionMode || DEFAULT_OPTIONS.extractionMode,
      ocrModel: options.ocrModel || DEFAULT_OPTIONS.ocrModel,
      ocrPromptType: options.ocrPromptType || DEFAULT_OPTIONS.ocrPromptType,
      imageDpi: options.imageDpi || DEFAULT_OPTIONS.imageDpi,
      imageFormat: options.imageFormat || DEFAULT_OPTIONS.imageFormat,
      ocrConcurrency: options.ocrConcurrency || DEFAULT_OPTIONS.ocrConcurrency,
    };
  }

  /**
   * Set base URL for OpenAI-compatible API (e.g., LM Studio)
   */
  setBaseUrl(baseUrl: string): this {
    this.options.baseUrl = baseUrl;
    return this;
  }

  /**
   * Use LM Studio configuration
   */
  useLMStudio(): this {
    Object.assign(this.options, LMSTUDIO_ENDPOINT);
    return this;
  }

  /**
   * Use Ollama configuration
   */
  useOllama(): this {
    Object.assign(this.options, OLLAMA_ENDPOINT);
    return this;
  }

  /**
   * Enable OCR mode for scanned PDFs
   */
  useOcrMode(ocrModel?: string): this {
    this.options.extractionMode = "ocr";
    if (ocrModel) {
      this.options.ocrModel = ocrModel;
    }
    return this;
  }

  /**
   * Process a PDF file and build tree index
   */
  async fromPdf(input: string | Buffer | ArrayBuffer): Promise<PageIndexResult> {
    let pages: PdfPage[];
    let pdfName: string;

    if (this.options.extractionMode === "ocr") {
      // OCR mode: Convert PDF to images and extract text via vision model
      console.log("[OCR Mode] Processing PDF with OCR...");
      const ocrOptions: OcrOptions = {
        ocrModel: this.options.ocrModel,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        imageFormat: this.options.imageFormat,
        imageDpi: this.options.imageDpi,
        ocrPromptType: this.options.ocrPromptType,
        concurrency: this.options.ocrConcurrency,
      };
      const result = await parsePdfWithOcr(input, ocrOptions);
      pages = result.pages;
      pdfName = typeof input === "string" ? getPdfName(input) : "Untitled";
    } else {
      // Text mode: Direct text extraction
      const pdfInfo = await parsePdf(input);
      pages = pdfInfo.pages;
      pdfName = typeof input === "string" ? getPdfName(input) : pdfInfo.title;
    }

    return this.processPdfPages(pages, pdfName);
  }

  /**
   * Process PDF pages directly
   */
  async processPdfPages(pages: PdfPage[], docName: string): Promise<PageIndexResult> {
    const startIndex = 1;
    const endPhysicalIndex = pages.length;

    // Check for TOC
    const tocResult = await checkToc(pages, this.options);
    console.log(
      `TOC found: ${tocResult.tocContent !== null}, Pages: ${tocResult.tocPageList.length}, Has page numbers: ${tocResult.pageIndexGivenInToc}`
    );

    let tocItems: TocItem[];

    if (tocResult.tocContent === null) {
      // No TOC - generate structure from document
      console.log("Generating structure from document content...");
      tocItems = await processNoToc(pages, startIndex, this.options);
    } else if (tocResult.pageIndexGivenInToc === "no") {
      // TOC without page numbers
      console.log("Processing TOC without page numbers...");
      tocItems = await processTocNoPageNumbers(
        tocResult.tocContent,
        pages,
        startIndex,
        this.options
      );
    } else {
      // TOC with page numbers
      console.log("Processing TOC with page numbers...");
      tocItems = await processTocWithPageNumbers(
        tocResult.tocContent,
        tocResult.tocPageList,
        pages,
        this.options
      );
    }

    // Convert physical_index strings to integers
    tocItems = convertPhysicalIndexToInt(tocItems) as TocItem[];

    // Add appear_start field
    tocItems = await checkTitleAppearanceInStartConcurrent(tocItems, pages, this.options);

    // Verify TOC
    console.log("Verifying TOC...");
    const { incorrect } = await verifyToc(pages, tocItems, startIndex, this.options);

    // Fix incorrect items if any
    if (incorrect.length > 0) {
      console.log(`Fixing ${incorrect.length} incorrect TOC items...`);
      const { fixed } = await fixIncorrectToc(
        tocItems,
        pages,
        incorrect,
        startIndex,
        this.options
      );
      tocItems = fixed;
    }

    // Items without a (valid) physical index cannot be placed in the tree
    tocItems = tocItems.filter((item) => item.physicalIndex !== undefined && item.physicalIndex !== null);

    // Build tree structure
    const tree = buildTree(tocItems, endPhysicalIndex, this.options);

    // Add node text if requested
    if (this.options.addNodeText || this.options.addNodeSummary) {
      addNodeText(tree, pages);
    }

    // Generate summaries if requested
    if (this.options.addNodeSummary) {
      console.log("Generating summaries...");
      await generateSummariesForStructure(tree, this.options);
    }

    // Generate document description if requested
    let docDescription: string | undefined;
    if (this.options.addDocDescription) {
      console.log("Generating document description...");
      docDescription = await generateDocDescription(tree, this.options);
    }

    // Final key order; text is dropped unless requested in output
    const keyOrder = this.options.addNodeText
      ? PDF_KEY_ORDER
      : PDF_KEY_ORDER.filter((key) => key !== "text");
    const finalStructure = formatStructure(tree, keyOrder) as TreeNode[];

    return {
      docName,
      docDescription,
      structure: finalStructure,
    };
  }
}

/**
 * Create a PageIndex instance with options
 */
export function createPageIndex(options?: PageIndexOptions): PageIndex {
  return new PageIndex(options);
}

/**
 * Quick function to process a PDF file
 */
export async function indexPdf(
  input: string | Buffer | ArrayBuffer,
  options?: PageIndexOptions
): Promise<PageIndexResult> {
  const pageIndex = new PageIndex(options);
  return pageIndex.fromPdf(input);
}

/**
 * Quick function to process a PDF with LM Studio
 */
export async function indexPdfWithLMStudio(
  input: string | Buffer | ArrayBuffer,
  model: string = "local-model",
  options?: Omit<PageIndexOptions, "model" | "apiKey">
): Promise<PageIndexResult> {
  const pageIndex = new PageIndex({ ...options, model }).useLMStudio();
  return pageIndex.fromPdf(input);
}

/**
 * Quick function to process a scanned PDF with OCR mode
 * Uses GLM-OCR for text extraction and a reasoning model for indexing
 */
export async function indexPdfWithOcr(
  input: string | Buffer | ArrayBuffer,
  options?: Omit<PageIndexOptions, "extractionMode"> & {
    reasoningModel?: string;
    ocrModel?: string;
  }
): Promise<PageIndexResult> {
  const pageIndex = new PageIndex({
    ...options,
    extractionMode: "ocr",
    model: options?.reasoningModel || options?.model || DEFAULT_INDEX_MODEL,
    ocrModel: options?.ocrModel || "mlx-community/GLM-OCR-bf16",
  });
  return pageIndex.fromPdf(input);
}

/**
 * Quick function to process a scanned PDF with LM Studio (OCR mode)
 * Uses GLM-OCR for text extraction and a local reasoning model
 */
export async function indexPdfWithLMStudioOcr(
  input: string | Buffer | ArrayBuffer,
  reasoningModel: string = "qwen/qwen3-vl-30b",
  ocrModel: string = "mlx-community/GLM-OCR-bf16",
  options?: Omit<PageIndexOptions, "model" | "apiKey" | "extractionMode" | "ocrModel">
): Promise<PageIndexResult> {
  const pageIndex = new PageIndex({
    ...options,
    model: reasoningModel,
    ocrModel,
    extractionMode: "ocr",
  }).useLMStudio();
  return pageIndex.fromPdf(input);
}
