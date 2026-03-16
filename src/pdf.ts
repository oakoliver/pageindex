/**
 * bun-pageindex: PDF parsing utilities
 * Uses pdf-parse for text extraction
 */

import { PDFParse } from "pdf-parse";
import { countTokens } from "./utils";
import type { PageContent } from "./types";
import * as fs from "fs/promises";

export interface PdfPage {
  text: string;
  tokenCount: number;
}

export interface PdfInfo {
  title: string;
  numPages: number;
  pages: PdfPage[];
}

/**
 * Parse PDF and extract text per page with token counts
 */
export async function parsePdf(
  input: string | Buffer | ArrayBuffer
): Promise<PdfInfo> {
  // Convert input to Uint8Array if needed
  let data: Uint8Array;
  if (typeof input === "string") {
    // File path
    const buffer = await fs.readFile(input);
    data = new Uint8Array(buffer);
  } else if (input instanceof ArrayBuffer) {
    data = new Uint8Array(input);
  } else {
    data = new Uint8Array(input);
  }

  // Parse PDF with data
  const parser = new PDFParse({ data });
  
  // Get text for all pages
  const textResult = await parser.getText();
  
  // Get metadata
  const infoResult = await parser.getInfo();

  const pages: PdfPage[] = [];
  let title = "Untitled";

  // Get title from metadata
  if (infoResult?.info?.Title) {
    title = infoResult.info.Title;
  }

  // Extract text from each page
  for (const pageText of textResult.pages) {
    const text = pageText.text;
    const tokenCount = countTokens(text);
    pages.push({ text, tokenCount });
  }

  // Clean up
  await parser.destroy();

  return {
    title,
    numPages: textResult.pages.length,
    pages,
  };
}

/**
 * Get text from specific pages (1-indexed)
 */
export function getTextOfPages(
  pages: PdfPage[],
  startPage: number,
  endPage: number,
  addTags: boolean = true
): string {
  let text = "";
  
  for (let pageNum = startPage - 1; pageNum < Math.min(endPage, pages.length); pageNum++) {
    const pageText = pages[pageNum]?.text || "";
    if (addTags) {
      text += `<physical_index_${pageNum + 1}>\n${pageText}\n</physical_index_${pageNum + 1}>\n`;
    } else {
      text += pageText;
    }
  }
  
  return text;
}

/**
 * Get text of pages with start_index tags (for legacy compatibility)
 */
export function getTextOfPagesWithStartIndex(
  pages: PdfPage[],
  startPage: number,
  endPage: number
): string {
  let text = "";
  
  for (let pageNum = startPage - 1; pageNum < Math.min(endPage, pages.length); pageNum++) {
    const pageText = pages[pageNum]?.text || "";
    text += `<start_index_${pageNum + 1}>\n${pageText}\n<end_index_${pageNum + 1}>\n`;
  }
  
  return text;
}

/**
 * Get token count for a range of pages
 */
export function getTokenCountForPages(
  pages: PdfPage[],
  startPage: number,
  endPage: number
): number {
  let totalTokens = 0;
  
  for (let pageNum = startPage - 1; pageNum < Math.min(endPage, pages.length); pageNum++) {
    totalTokens += pages[pageNum]?.tokenCount || 0;
  }
  
  return totalTokens;
}

/**
 * Get all text from PDF pages
 */
export function getAllText(pages: PdfPage[]): string {
  return pages.map((p) => p.text).join("\n");
}

/**
 * Extract PDF name from path or metadata
 */
export function getPdfName(pdfPath: string): string {
  // Get basename from path
  const parts = pdfPath.split("/");
  const basename = parts[parts.length - 1] || "Untitled";
  // Remove .pdf extension if present
  return basename.replace(/\.pdf$/i, "");
}

/**
 * Get total number of pages
 */
export function getNumberOfPages(pages: PdfPage[]): number {
  return pages.length;
}

/**
 * Convert pages to PageContent format for compatibility
 */
export function pagesToPageContent(pages: PdfPage[]): PageContent[] {
  return pages.map((p) => ({
    text: p.text,
    tokenCount: p.tokenCount,
  }));
}
