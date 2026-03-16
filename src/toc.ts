/**
 * bun-pageindex: TOC Detection and Extraction
 * Functions for detecting, extracting, and processing table of contents
 */

import { chatGPT, chatGPTWithFinishReason, type ClientConfig } from "./openai";
import type { PdfPage } from "./pdf";
import type { TocItem, TocCheckResult } from "./types";
import { extractJson, getJsonContent, countTokens, convertPhysicalIndexToInt, convertPageToInt } from "./utils";
import * as prompts from "./prompts";

export interface TocOptions {
  model: string;
  tocCheckPageNum: number;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Detect if a single page contains a TOC
 */
export async function tocDetectorSinglePage(
  content: string,
  options: TocOptions
): Promise<"yes" | "no"> {
  const prompt = prompts.tocDetectorPrompt(content);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ toc_detected: string }>(response);
  return (json?.toc_detected === "yes" ? "yes" : "no");
}

/**
 * Find all pages containing TOC
 */
export async function findTocPages(
  startPageIndex: number,
  pages: PdfPage[],
  options: TocOptions
): Promise<number[]> {
  let lastPageIsYes = false;
  const tocPageList: number[] = [];
  let i = startPageIndex;

  while (i < pages.length) {
    // Only check beyond max_pages if we're still finding TOC pages
    if (i >= options.tocCheckPageNum && !lastPageIsYes) {
      break;
    }

    const page = pages[i];
    if (!page) {
      i++;
      continue;
    }
    
    const detected = await tocDetectorSinglePage(page.text, options);
    
    if (detected === "yes") {
      tocPageList.push(i);
      lastPageIsYes = true;
    } else if (detected === "no" && lastPageIsYes) {
      break;
    }
    
    i++;
  }

  return tocPageList;
}

/**
 * Transform dots/ellipsis to colon in TOC text
 */
function transformDotsToColon(text: string): string {
  // Handle multiple consecutive dots
  text = text.replace(/\.{5,}/g, ": ");
  // Handle dots separated by spaces
  text = text.replace(/(?:\. ){5,}\.?/g, ": ");
  return text;
}

/**
 * Detect if page numbers are given in TOC
 */
export async function detectPageIndex(
  tocContent: string,
  options: TocOptions
): Promise<"yes" | "no"> {
  const prompt = prompts.detectPageIndexPrompt(tocContent);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ page_index_given_in_toc: string }>(response);
  return json?.page_index_given_in_toc === "yes" ? "yes" : "no";
}

/**
 * Extract TOC content from pages
 */
export async function tocExtractor(
  pages: PdfPage[],
  tocPageList: number[],
  options: TocOptions
): Promise<{ tocContent: string; pageIndexGivenInToc: "yes" | "no" }> {
  let tocContent = "";
  for (const pageIndex of tocPageList) {
    const page = pages[pageIndex];
    if (page) {
      tocContent += page.text;
    }
  }
  tocContent = transformDotsToColon(tocContent);
  
  const hasPageIndex = await detectPageIndex(tocContent, options);

  return {
    tocContent,
    pageIndexGivenInToc: hasPageIndex,
  };
}

/**
 * Check if TOC transformation is complete
 */
async function checkTocTransformationComplete(
  rawToc: string,
  cleanedToc: string,
  options: TocOptions
): Promise<boolean> {
  const prompt = prompts.checkTocTransformationCompletePrompt(rawToc, cleanedToc);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ completed: string }>(response);
  return json?.completed === "yes";
}

/**
 * Transform raw TOC content to JSON structure
 */
export async function tocTransformer(
  tocContent: string,
  options: TocOptions
): Promise<TocItem[]> {
  const prompt = prompts.tocTransformerPrompt(tocContent);
  
  let { content: lastComplete, finishReason } = await chatGPTWithFinishReason({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  let isComplete = await checkTocTransformationComplete(tocContent, lastComplete, options);
  
  if (isComplete && finishReason === "finished") {
    const json = extractJson<{ table_of_contents: TocItem[] }>(lastComplete);
    if (json?.table_of_contents) {
      return convertPageToInt(json.table_of_contents);
    }
  }

  // Handle continuation if not complete
  lastComplete = getJsonContent(lastComplete);
  let attempts = 0;
  const maxAttempts = 5;

  while (!(isComplete && finishReason === "finished") && attempts < maxAttempts) {
    // Trim to last complete object
    const position = lastComplete.lastIndexOf("}");
    if (position !== -1) {
      lastComplete = lastComplete.slice(0, position + 2);
    }

    const continuePrompt = prompts.tocTransformerContinuePrompt(tocContent, lastComplete);
    const result = await chatGPTWithFinishReason({
      model: options.model,
      prompt: continuePrompt,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });

    let newContent = result.content;
    finishReason = result.finishReason;

    if (newContent.startsWith("```json")) {
      newContent = getJsonContent(newContent);
    }
    lastComplete = lastComplete + newContent;

    isComplete = await checkTocTransformationComplete(tocContent, lastComplete, options);
    attempts++;
  }

  try {
    const parsed = JSON.parse(lastComplete);
    return convertPageToInt(parsed.table_of_contents || parsed);
  } catch {
    console.error("Failed to parse TOC JSON");
    return [];
  }
}

/**
 * Extract physical index from pages for TOC items
 */
export async function tocIndexExtractor(
  toc: TocItem[],
  content: string,
  options: TocOptions
): Promise<TocItem[]> {
  const prompt = prompts.tocIndexExtractorPrompt(JSON.stringify(toc), content);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<TocItem[]>(response);
  return json || [];
}

/**
 * Generate TOC from document pages (no existing TOC)
 */
export async function generateTocInit(
  part: string,
  options: TocOptions
): Promise<TocItem[]> {
  const prompt = prompts.generateTocInitPrompt(part);
  const { content, finishReason } = await chatGPTWithFinishReason({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  if (finishReason === "finished") {
    const json = extractJson<TocItem[]>(content);
    return json || [];
  }
  
  throw new Error(`Generation incomplete: ${finishReason}`);
}

/**
 * Continue TOC generation with previous structure
 */
export async function generateTocContinue(
  tocContent: TocItem[],
  part: string,
  options: TocOptions
): Promise<TocItem[]> {
  const prompt = prompts.generateTocContinuePrompt(part, JSON.stringify(tocContent, null, 2));
  const { content, finishReason } = await chatGPTWithFinishReason({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  if (finishReason === "finished") {
    const json = extractJson<TocItem[]>(content);
    return json || [];
  }
  
  throw new Error(`Generation incomplete: ${finishReason}`);
}

/**
 * Add page numbers to TOC structure from document parts
 */
export async function addPageNumberToToc(
  part: string,
  structure: TocItem[],
  options: TocOptions
): Promise<TocItem[]> {
  const prompt = prompts.addPageNumberToTocPrompt(part, JSON.stringify(structure, null, 2));
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<TocItem[]>(response);
  if (!json) return structure;

  // Remove 'start' field from items
  for (const item of json) {
    delete (item as unknown as Record<string, unknown>).start;
  }

  return json;
}

/**
 * Check title appearance in page
 */
export async function checkTitleAppearance(
  item: TocItem,
  pages: PdfPage[],
  startIndex: number,
  options: TocOptions
): Promise<{ listIndex: number | undefined; answer: "yes" | "no"; title: string; pageNumber: number | undefined }> {
  const title = item.title;
  
  if (!item.physicalIndex) {
    return { listIndex: item.listIndex, answer: "no", title, pageNumber: undefined };
  }

  const pageNumber = item.physicalIndex;
  const pageText = pages[pageNumber - startIndex]?.text || "";

  const prompt = prompts.checkTitleAppearancePrompt(title, pageText);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ answer: string }>(response);
  const answer = json?.answer === "yes" ? "yes" : "no";

  return { listIndex: item.listIndex, answer, title, pageNumber };
}

/**
 * Check title appearance at start of page
 */
export async function checkTitleAppearanceInStart(
  title: string,
  pageText: string,
  options: TocOptions
): Promise<"yes" | "no"> {
  const prompt = prompts.checkTitleStartAtBeginningPrompt(title, pageText);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ start_begin: string }>(response);
  return json?.start_begin === "yes" ? "yes" : "no";
}

/**
 * Check title appearance in start for multiple items concurrently
 */
export async function checkTitleAppearanceInStartConcurrent(
  structure: TocItem[],
  pages: PdfPage[],
  options: TocOptions
): Promise<TocItem[]> {
  const results: TocItem[] = [];

  for (const item of structure) {
    if (!item.physicalIndex) {
      results.push({ ...item, appearStart: "no" });
      continue;
    }

    const pageText = pages[item.physicalIndex - 1]?.text || "";
    const appearStart = await checkTitleAppearanceInStart(item.title, pageText, options);
    results.push({ ...item, appearStart });
  }

  return results;
}

/**
 * Check for TOC in PDF and return result
 */
export async function checkToc(
  pages: PdfPage[],
  options: TocOptions
): Promise<TocCheckResult> {
  const tocPageList = await findTocPages(0, pages, options);

  if (tocPageList.length === 0) {
    return {
      tocContent: null,
      tocPageList: [],
      pageIndexGivenInToc: "no",
    };
  }

  const tocResult = await tocExtractor(pages, tocPageList, options);

  if (tocResult.pageIndexGivenInToc === "yes") {
    return {
      tocContent: tocResult.tocContent,
      tocPageList,
      pageIndexGivenInToc: "yes",
    };
  }

  // Try to find additional TOC pages with page indices
  const lastTocPage = tocPageList[tocPageList.length - 1];
  let currentStartIndex = lastTocPage !== undefined ? lastTocPage + 1 : 0;
  
  while (currentStartIndex < pages.length && currentStartIndex < options.tocCheckPageNum) {
    const additionalTocPages = await findTocPages(currentStartIndex, pages, options);
    
    if (additionalTocPages.length === 0) {
      break;
    }

    const additionalTocResult = await tocExtractor(pages, additionalTocPages, options);
    
    if (additionalTocResult.pageIndexGivenInToc === "yes") {
      return {
        tocContent: additionalTocResult.tocContent,
        tocPageList: additionalTocPages,
        pageIndexGivenInToc: "yes",
      };
    }

    const lastAdditionalPage = additionalTocPages[additionalTocPages.length - 1];
    currentStartIndex = lastAdditionalPage !== undefined ? lastAdditionalPage + 1 : pages.length;
  }

  return {
    tocContent: tocResult.tocContent,
    tocPageList,
    pageIndexGivenInToc: "no",
  };
}

/**
 * Fix single TOC item index
 */
export async function singleTocItemIndexFixer(
  sectionTitle: string,
  content: string,
  options: TocOptions
): Promise<number | null> {
  const prompt = prompts.singleTocItemIndexFixerPrompt(sectionTitle, content);
  const response = await chatGPT({
    model: options.model,
    prompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const json = extractJson<{ physical_index: string }>(response);
  if (!json?.physical_index) return null;

  const result = convertPhysicalIndexToInt(json.physical_index);
  return typeof result === "number" ? result : null;
}
