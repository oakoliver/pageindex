/**
 * Compare Text vs OCR mode extraction
 * Processes the same PDF with both modes and compares results
 */

import { PageIndex } from "../src/pageindex";
import { parsePdf } from "../src/pdf";
import { parsePdfWithOcr } from "../src/ocr";
import * as fs from "fs/promises";

const TEST_PDF = "/tmp/pageindex/tests/pdfs/q1-fy25-earnings.pdf";

// LM Studio config
const LM_STUDIO_CONFIG = {
  baseUrl: "http://localhost:1234/v1",
  apiKey: "lm-studio",
};

// Models
const REASONING_MODEL = "qwen/qwen3-vl-30b";
const OCR_MODEL = "mlx-community/GLM-OCR-bf16";

async function compareTextVsOcr() {
  console.log("=".repeat(60));
  console.log("TEXT vs OCR Mode Comparison");
  console.log("=".repeat(60));
  console.log(`\nPDF: ${TEST_PDF}`);
  console.log(`Reasoning Model: ${REASONING_MODEL}`);
  console.log(`OCR Model: ${OCR_MODEL}\n`);

  // Check if PDF exists
  try {
    await fs.access(TEST_PDF);
  } catch {
    console.error(`ERROR: Test PDF not found: ${TEST_PDF}`);
    process.exit(1);
  }

  // ============================================
  // 1. TEXT MODE - Direct text extraction
  // ============================================
  console.log("-".repeat(60));
  console.log("1. TEXT MODE (pdf-parse)");
  console.log("-".repeat(60));

  const textStartTime = performance.now();
  
  // Extract text
  const textPdfInfo = await parsePdf(TEST_PDF);
  const textExtractTime = performance.now() - textStartTime;
  
  console.log(`Pages extracted: ${textPdfInfo.pages.length}`);
  console.log(`Extraction time: ${textExtractTime.toFixed(2)}ms`);
  
  // Show sample text from first page
  const textSample = textPdfInfo.pages[0]?.text.slice(0, 500) || "";
  console.log(`\nFirst page sample (500 chars):\n${textSample}...`);
  
  // Count total tokens
  const textTotalTokens = textPdfInfo.pages.reduce((sum, p) => sum + p.tokenCount, 0);
  console.log(`\nTotal tokens: ${textTotalTokens}`);

  // ============================================
  // 2. OCR MODE - Image + Vision model
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("2. OCR MODE (pdf-poppler + GLM-OCR)");
  console.log("-".repeat(60));

  const ocrStartTime = performance.now();
  
  try {
    const ocrResult = await parsePdfWithOcr(TEST_PDF, {
      ocrModel: OCR_MODEL,
      ...LM_STUDIO_CONFIG,
      imageDpi: 150,
      imageFormat: "png",
      ocrPromptType: "text",
      concurrency: 2,
    });
    
    const ocrExtractTime = performance.now() - ocrStartTime;
    
    console.log(`Pages extracted: ${ocrResult.pages.length}`);
    console.log(`Extraction time: ${(ocrExtractTime / 1000).toFixed(2)}s`);
    
    // Show sample text from first page
    const ocrSample = ocrResult.pages[0]?.text.slice(0, 500) || "";
    console.log(`\nFirst page sample (500 chars):\n${ocrSample}...`);
    
    // Count total tokens
    const ocrTotalTokens = ocrResult.pages.reduce((sum, p) => sum + p.tokenCount, 0);
    console.log(`\nTotal tokens: ${ocrTotalTokens}`);

    // ============================================
    // 3. COMPARISON
    // ============================================
    console.log("\n" + "=".repeat(60));
    console.log("COMPARISON SUMMARY");
    console.log("=".repeat(60));
    
    console.log(`\n${"Metric".padEnd(25)} ${"Text Mode".padEnd(15)} ${"OCR Mode".padEnd(15)}`);
    console.log("-".repeat(55));
    console.log(`${"Pages".padEnd(25)} ${textPdfInfo.pages.length.toString().padEnd(15)} ${ocrResult.pages.length.toString().padEnd(15)}`);
    console.log(`${"Total Tokens".padEnd(25)} ${textTotalTokens.toString().padEnd(15)} ${ocrTotalTokens.toString().padEnd(15)}`);
    console.log(`${"Extraction Time".padEnd(25)} ${(textExtractTime).toFixed(0).padEnd(12)}ms ${(ocrExtractTime / 1000).toFixed(2).padEnd(12)}s`);
    console.log(`${"Speed Ratio".padEnd(25)} ${("1x").padEnd(15)} ${(ocrExtractTime / textExtractTime).toFixed(0)}x slower`);
    
    // Token per page comparison
    const textAvgTokens = Math.round(textTotalTokens / textPdfInfo.pages.length);
    const ocrAvgTokens = Math.round(ocrTotalTokens / ocrResult.pages.length);
    console.log(`${"Avg Tokens/Page".padEnd(25)} ${textAvgTokens.toString().padEnd(15)} ${ocrAvgTokens.toString().padEnd(15)}`);

    // Quality notes
    console.log("\n" + "-".repeat(60));
    console.log("QUALITY NOTES:");
    console.log("-".repeat(60));
    console.log("- Text mode: Fast, accurate for native PDFs with embedded text");
    console.log("- OCR mode: Slower, but works with scanned/image PDFs");
    console.log("- OCR may have lower accuracy on complex layouts or low-quality scans");
    console.log("- Use text mode when possible, OCR mode only when needed");

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Library not loaded") || message.includes("poppler")) {
      console.log("\nERROR: Poppler system libraries not installed");
      console.log("Install with: brew install poppler");
      console.log("\nSkipping OCR comparison...");
    } else if (message.includes("ECONNREFUSED")) {
      console.log("\nERROR: LM Studio not running");
      console.log("Start LM Studio and load the OCR model");
    } else {
      console.error("\nERROR:", message);
    }
  }
}

// Run comparison
compareTextVsOcr().catch(console.error);
