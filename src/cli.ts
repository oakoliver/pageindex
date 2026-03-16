#!/usr/bin/env node
/**
 * pageindex CLI
 * Command-line interface for processing PDFs and Markdown documents
 */

import { parseArgs } from "util";
import { PageIndex } from "./pageindex";
import { mdToTree } from "./markdown";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";

interface CliArgs {
  pdf?: string;
  md?: string;
  model: string;
  tocCheckPages: number;
  maxPagesPerNode: number;
  maxTokensPerNode: number;
  addNodeId: boolean;
  addNodeSummary: boolean;
  addDocDescription: boolean;
  addNodeText: boolean;
  thinning: boolean;
  thinningThreshold: number;
  summaryTokenThreshold: number;
  output?: string;
  lmstudio: boolean;
  ollama: boolean;
  baseUrl?: string;
  // OCR options
  ocr: boolean;
  ocrModel: string;
  ocrPromptType: "text" | "formula" | "table";
  imageDpi: number;
  help: boolean;
}

function printHelp(): void {
  console.log(`
bun-pageindex - Vectorless, reasoning-based RAG for document understanding

USAGE:
  bun-pageindex --pdf <path>     Process a PDF file
  bun-pageindex --md <path>      Process a Markdown file

OPTIONS:
  --pdf <path>                 Path to PDF file
  --md <path>                  Path to Markdown file
  --output, -o <path>          Output file path (default: ./results/<name>_structure.json)
  
  MODEL OPTIONS:
  --model <name>               Model to use (default: gpt-4o-2024-11-20)
  --lmstudio                   Use LM Studio (localhost:1234)
  --ollama                     Use Ollama (localhost:11434)
  --base-url <url>             Custom OpenAI-compatible API URL
  
  PDF OPTIONS:
  --toc-check-pages <n>        Pages to check for TOC (default: 20)
  --max-pages-per-node <n>     Max pages per node (default: 10)
  --max-tokens-per-node <n>    Max tokens per node (default: 20000)
  
  OCR OPTIONS (for scanned PDFs):
  --ocr                        Enable OCR mode for scanned PDFs
  --ocr-model <name>           OCR model (default: mlx-community/GLM-OCR-bf16)
  --ocr-prompt-type <type>     OCR prompt: text, formula, table (default: text)
  --image-dpi <n>              Image DPI for OCR (default: 150)
  
  MARKDOWN OPTIONS:
  --thinning                   Apply tree thinning
  --thinning-threshold <n>     Min tokens for thinning (default: 5000)
  --summary-token-threshold <n> Token threshold for summaries (default: 200)
  
  OUTPUT OPTIONS:
  --add-node-id                Add node IDs (default: true)
  --no-node-id                 Don't add node IDs
  --add-node-summary           Add node summaries (default: true)
  --no-node-summary            Don't add node summaries
  --add-doc-description        Add document description
  --add-node-text              Include raw text in output
  
  --help, -h                   Show this help message

EXAMPLES:
  bun-pageindex --pdf document.pdf
  bun-pageindex --md README.md --add-doc-description
  bun-pageindex --pdf paper.pdf --lmstudio --model llama3
  bun-pageindex --pdf report.pdf --base-url http://localhost:8080/v1
  bun-pageindex --pdf scanned.pdf --ocr --lmstudio --model qwen/qwen3-vl-30b
`);
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pdf: { type: "string" },
      md: { type: "string" },
      model: { type: "string", default: "gpt-4o-2024-11-20" },
      "toc-check-pages": { type: "string", default: "20" },
      "max-pages-per-node": { type: "string", default: "10" },
      "max-tokens-per-node": { type: "string", default: "20000" },
      "add-node-id": { type: "boolean", default: true },
      "no-node-id": { type: "boolean", default: false },
      "add-node-summary": { type: "boolean", default: true },
      "no-node-summary": { type: "boolean", default: false },
      "add-doc-description": { type: "boolean", default: false },
      "add-node-text": { type: "boolean", default: false },
      thinning: { type: "boolean", default: false },
      "thinning-threshold": { type: "string", default: "5000" },
      "summary-token-threshold": { type: "string", default: "200" },
      output: { type: "string", short: "o" },
      lmstudio: { type: "boolean", default: false },
      ollama: { type: "boolean", default: false },
      "base-url": { type: "string" },
      // OCR options
      ocr: { type: "boolean", default: false },
      "ocr-model": { type: "string", default: "mlx-community/GLM-OCR-bf16" },
      "ocr-prompt-type": { type: "string", default: "text" },
      "image-dpi": { type: "string", default: "150" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  return {
    pdf: values.pdf,
    md: values.md,
    model: values.model || "gpt-4o-2024-11-20",
    tocCheckPages: parseInt(values["toc-check-pages"] || "20", 10),
    maxPagesPerNode: parseInt(values["max-pages-per-node"] || "10", 10),
    maxTokensPerNode: parseInt(values["max-tokens-per-node"] || "20000", 10),
    addNodeId: values["no-node-id"] ? false : (values["add-node-id"] ?? true),
    addNodeSummary: values["no-node-summary"] ? false : (values["add-node-summary"] ?? true),
    addDocDescription: values["add-doc-description"] ?? false,
    addNodeText: values["add-node-text"] ?? false,
    thinning: values.thinning ?? false,
    thinningThreshold: parseInt(values["thinning-threshold"] || "5000", 10),
    summaryTokenThreshold: parseInt(values["summary-token-threshold"] || "200", 10),
    output: values.output,
    lmstudio: values.lmstudio ?? false,
    ollama: values.ollama ?? false,
    baseUrl: values["base-url"],
    // OCR options
    ocr: values.ocr ?? false,
    ocrModel: values["ocr-model"] || "mlx-community/GLM-OCR-bf16",
    ocrPromptType: (values["ocr-prompt-type"] || "text") as "text" | "formula" | "table",
    imageDpi: parseInt(values["image-dpi"] || "150", 10),
    help: values.help ?? false,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Validate input
  if (!args.pdf && !args.md) {
    console.error("Error: Either --pdf or --md must be specified");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  if (args.pdf && args.md) {
    console.error("Error: Only one of --pdf or --md can be specified");
    process.exit(1);
  }

  // Determine output path
  const inputPath = args.pdf || args.md!;
  const inputName = path.basename(inputPath, path.extname(inputPath));
  const outputDir = "./results";
  const outputPath = args.output || path.join(outputDir, `${inputName}_structure.json`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let result;

  if (args.pdf) {
    // Validate PDF
    if (!args.pdf.toLowerCase().endsWith(".pdf")) {
      console.error("Error: PDF file must have .pdf extension");
      process.exit(1);
    }

    if (!fs.existsSync(args.pdf)) {
      console.error(`Error: PDF file not found: ${args.pdf}`);
      process.exit(1);
    }

    console.log(`Processing PDF: ${args.pdf}`);
    if (args.ocr) {
      console.log(`[OCR Mode] Using OCR model: ${args.ocrModel}`);
    }

    // Create PageIndex instance
    const pageIndex = new PageIndex({
      model: args.model,
      tocCheckPageNum: args.tocCheckPages,
      maxPageNumEachNode: args.maxPagesPerNode,
      maxTokenNumEachNode: args.maxTokensPerNode,
      addNodeId: args.addNodeId,
      addNodeSummary: args.addNodeSummary,
      addDocDescription: args.addDocDescription,
      addNodeText: args.addNodeText,
      // OCR options
      extractionMode: args.ocr ? "ocr" : "text",
      ocrModel: args.ocrModel,
      ocrPromptType: args.ocrPromptType,
      imageDpi: args.imageDpi,
    });

    // Configure endpoint
    if (args.lmstudio) {
      pageIndex.useLMStudio();
    } else if (args.ollama) {
      pageIndex.useOllama();
    } else if (args.baseUrl) {
      pageIndex.setBaseUrl(args.baseUrl);
    }

    // Process PDF
    result = await pageIndex.fromPdf(args.pdf);

  } else {
    // Validate Markdown
    const mdPath = args.md!;
    if (!mdPath.toLowerCase().endsWith(".md") && !mdPath.toLowerCase().endsWith(".markdown")) {
      console.error("Error: Markdown file must have .md or .markdown extension");
      process.exit(1);
    }

    if (!fs.existsSync(mdPath)) {
      console.error(`Error: Markdown file not found: ${mdPath}`);
      process.exit(1);
    }

    console.log(`Processing Markdown: ${mdPath}`);

    // Process Markdown
    result = await mdToTree(mdPath, {
      model: args.model,
      addNodeId: args.addNodeId,
      addNodeSummary: args.addNodeSummary,
      addDocDescription: args.addDocDescription,
      addNodeText: args.addNodeText,
      thinning: args.thinning,
      thinningThreshold: args.thinningThreshold,
      summaryTokenThreshold: args.summaryTokenThreshold,
    });
  }

  console.log("Parsing done, saving to file...");

  // Save results
  await fsp.writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(`Tree structure saved to: ${outputPath}`);
}

// Run
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
