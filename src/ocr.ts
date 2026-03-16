/**
 * bun-pageindex: OCR module for scanned PDFs
 * Uses system poppler tools for PDF→image conversion and GLM-OCR for text extraction
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { countTokens } from "./utils";
import type { PdfPage } from "./pdf";

const execAsync = promisify(exec);

export interface OcrOptions {
  /** OCR model to use (default: mlx-community/GLM-OCR-bf16) */
  ocrModel?: string;
  /** API key for OCR model */
  apiKey?: string;
  /** Base URL for OCR model API (e.g., LM Studio) */
  baseUrl?: string;
  /** Image format for conversion (default: png) */
  imageFormat?: "png" | "jpeg";
  /** Image DPI for conversion (default: 150) */
  imageDpi?: number;
  /** OCR prompt type (default: text) */
  ocrPromptType?: "text" | "formula" | "table";
  /** Concurrent OCR requests (default: 3) */
  concurrency?: number;
}

const DEFAULT_OCR_OPTIONS: Required<Omit<OcrOptions, "apiKey" | "baseUrl">> = {
  ocrModel: "mlx-community/GLM-OCR-bf16",
  imageFormat: "png",
  imageDpi: 150,
  ocrPromptType: "text",
  concurrency: 3,
};

/**
 * GLM-OCR specific prompts based on extraction type
 */
const OCR_PROMPTS: Record<string, string> = {
  text: "Text Recognition:",
  formula: "Formula Recognition:",
  table: "Table Recognition:",
};

/**
 * Check if poppler tools are installed on the system
 */
export async function checkPopplerInstalled(): Promise<boolean> {
  try {
    await execAsync("which pdftocairo");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get PDF page count using pdfinfo
 */
async function getPdfPageCount(pdfPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`pdfinfo "${pdfPath}" | grep -i "^Pages:" | awk '{print $2}'`);
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Convert a PDF file to images using system pdftocairo
 * Returns paths to the generated images
 */
export async function pdfToImages(
  pdfPath: string,
  options: Pick<OcrOptions, "imageFormat" | "imageDpi"> = {}
): Promise<string[]> {
  const format = options.imageFormat || DEFAULT_OCR_OPTIONS.imageFormat;
  const dpi = options.imageDpi || DEFAULT_OCR_OPTIONS.imageDpi;

  // Check if poppler is installed
  const installed = await checkPopplerInstalled();
  if (!installed) {
    throw new Error(
      "Poppler tools not installed. Install with:\n" +
      "  macOS: brew install poppler\n" +
      "  Ubuntu: sudo apt-get install poppler-utils"
    );
  }

  // Create temp directory for images
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pageindex-ocr-"));
  const outputPrefix = path.join(tempDir, "page");

  // Use pdftocairo for conversion
  const formatFlag = format === "png" ? "-png" : "-jpeg";
  const cmd = `pdftocairo ${formatFlag} -r ${dpi} "${pdfPath}" "${outputPrefix}"`;

  try {
    await execAsync(cmd);
  } catch (error) {
    // Cleanup on error
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Get list of generated images (sorted by page number)
  const files = await fs.readdir(tempDir);
  const imageFiles = files
    .filter((f) => f.endsWith(`.${format}`))
    .sort((a, b) => {
      // Extract page numbers from filenames like "page-1.png" or "page-01.png"
      const numA = parseInt(a.match(/-(\d+)\./)?.[1] || "0");
      const numB = parseInt(b.match(/-(\d+)\./)?.[1] || "0");
      return numA - numB;
    })
    .map((f) => path.join(tempDir, f));

  return imageFiles;
}

/**
 * Convert a PDF buffer to images
 */
export async function pdfBufferToImages(
  pdfBuffer: Buffer | ArrayBuffer,
  options: Pick<OcrOptions, "imageFormat" | "imageDpi"> = {}
): Promise<string[]> {
  // Write buffer to temp file
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pageindex-pdf-"));
  const tempPdfPath = path.join(tempDir, "input.pdf");

  const buffer = pdfBuffer instanceof ArrayBuffer ? Buffer.from(pdfBuffer) : pdfBuffer;
  await fs.writeFile(tempPdfPath, buffer);

  try {
    return await pdfToImages(tempPdfPath, options);
  } finally {
    // Cleanup temp PDF (images will be cleaned up after OCR)
    await fs.unlink(tempPdfPath).catch(() => {});
    await fs.rmdir(tempDir).catch(() => {});
  }
}

/**
 * Run OCR on a single image using GLM-OCR vision model
 */
export async function ocrImage(
  imagePath: string,
  options: OcrOptions = {}
): Promise<string> {
  const model = options.ocrModel || DEFAULT_OCR_OPTIONS.ocrModel;
  const promptType = options.ocrPromptType || DEFAULT_OCR_OPTIONS.ocrPromptType;
  const prompt = OCR_PROMPTS[promptType] ?? OCR_PROMPTS.text ?? "Text Recognition:";

  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "lm-studio";
  const baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || "http://localhost:1234/v1";

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });

  // Read image and convert to base64
  const imageData = await fs.readFile(imagePath);
  const base64Image = imageData.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

  try {
    // Build content parts for vision API
    const contentParts: ChatCompletionContentPart[] = [
      {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`,
        },
      },
      {
        type: "text",
        text: prompt,
      },
    ];

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: contentParts,
        },
      ],
      max_tokens: 4096,
    });

    return response.choices[0]?.message?.content || "";
  } catch (error) {
    console.error(`[OCR Error] Failed to process ${imagePath}:`, error);
    return "";
  }
}

/**
 * Run OCR on multiple images concurrently
 */
export async function ocrImages(
  imagePaths: string[],
  options: OcrOptions = {}
): Promise<string[]> {
  const concurrency = options.concurrency || DEFAULT_OCR_OPTIONS.concurrency;
  const results: string[] = [];

  for (let i = 0; i < imagePaths.length; i += concurrency) {
    const batch = imagePaths.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((imagePath) => ocrImage(imagePath, options))
    );
    results.push(...batchResults);

    // Log progress
    const processed = Math.min(i + concurrency, imagePaths.length);
    console.log(`[OCR] Processed ${processed}/${imagePaths.length} pages`);
  }

  return results;
}

/**
 * Parse PDF using OCR mode (for scanned PDFs)
 * Converts PDF to images, then uses GLM-OCR to extract text
 */
export async function parsePdfWithOcr(
  input: string | Buffer | ArrayBuffer,
  options: OcrOptions = {}
): Promise<{ pages: PdfPage[]; tempDir?: string }> {
  console.log("[OCR Mode] Converting PDF to images...");

  let imagePaths: string[];
  let tempDir: string | undefined;

  if (typeof input === "string") {
    // File path
    imagePaths = await pdfToImages(input, options);
  } else {
    // Buffer
    const buffer = input instanceof ArrayBuffer ? Buffer.from(input) : input;
    imagePaths = await pdfBufferToImages(buffer, options);
  }

  if (imagePaths.length > 0) {
    tempDir = path.dirname(imagePaths[0]!);
  }

  console.log(`[OCR Mode] Extracted ${imagePaths.length} page images`);
  console.log("[OCR Mode] Running OCR on pages...");

  // Run OCR on all images
  const texts = await ocrImages(imagePaths, options);

  // Convert to PdfPage format
  const pages: PdfPage[] = texts.map((text) => ({
    text,
    tokenCount: countTokens(text),
  }));

  // Cleanup images
  await cleanupTempImages(imagePaths);

  return { pages };
}

/**
 * Clean up temporary image files
 */
async function cleanupTempImages(imagePaths: string[]): Promise<void> {
  if (imagePaths.length === 0) return;

  const firstPath = imagePaths[0];
  if (!firstPath) return;
  
  const tempDir = path.dirname(firstPath);

  // Delete all images
  await Promise.all(
    imagePaths.map((p) => fs.unlink(p).catch(() => {}))
  );

  // Try to remove the temp directory
  await fs.rmdir(tempDir).catch(() => {});
}

/**
 * Get PDF info (page count) without full parsing
 */
export async function getPdfInfo(pdfPath: string): Promise<{ pages: number }> {
  const pages = await getPdfPageCount(pdfPath);
  return { pages };
}
