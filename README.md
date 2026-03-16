# bun-pageindex

Bun-native vectorless, reasoning-based RAG for document understanding. A TypeScript port of [PageIndex](https://github.com/VectifyAI/PageIndex) optimized for the Bun runtime.

## Features

- **Vectorless RAG**: Uses LLM reasoning to build hierarchical document indices without vector databases
- **PDF Support**: Extract structure and content from PDF documents
- **OCR Mode**: Process scanned PDFs using GLM-OCR vision model (not in original PageIndex!)
- **Markdown Support**: Convert markdown documents to tree structures
- **LLM Agnostic**: Works with OpenAI, LM Studio, Ollama, or any OpenAI-compatible API
- **Bun Native**: Optimized for Bun runtime with minimal dependencies
- **CLI & API**: Use as a library or command-line tool

## Installation

```bash
bun add bun-pageindex
```

### For OCR Mode (Scanned PDFs)

OCR mode requires Poppler to be installed on your system:

```bash
# macOS
brew install poppler

# Ubuntu/Debian
sudo apt-get install poppler-utils

# Windows
# Download from https://github.com/oschwartz10612/poppler-windows/releases
```

## Quick Start

### As a Library

```typescript
import { PageIndex, indexPdf, mdToTree } from "bun-pageindex";

// Process a PDF with OpenAI
const result = await indexPdf("document.pdf", {
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o",
});

console.log(result.structure);

// Or use the PageIndex class for more control
const pageIndex = new PageIndex({
  model: "gpt-4o",
  addNodeSummary: true,
  addDocDescription: true,
});

const pdfResult = await pageIndex.fromPdf("document.pdf");

// Process markdown
const mdResult = await mdToTree("document.md", {
  addNodeSummary: true,
  thinning: true,
  thinningThreshold: 5000,
});
```

### Using LM Studio (Local LLMs)

```typescript
import { PageIndex } from "bun-pageindex";

const pageIndex = new PageIndex({
  model: "local-model", // Your LM Studio model name
}).useLMStudio();

const result = await pageIndex.fromPdf("document.pdf");
```

### Using Ollama

```typescript
import { PageIndex } from "bun-pageindex";

const pageIndex = new PageIndex({
  model: "llama3",
}).useOllama();

const result = await pageIndex.fromPdf("document.pdf");
```

### OCR Mode for Scanned PDFs

OCR mode converts PDF pages to images and uses a vision model (like GLM-OCR) to extract text, then processes with a reasoning model.

```typescript
import { PageIndex, indexPdfWithOcr, indexPdfWithLMStudioOcr } from "bun-pageindex";

// Using OpenAI
const result = await indexPdfWithOcr("scanned-document.pdf", {
  apiKey: process.env.OPENAI_API_KEY,
  reasoningModel: "gpt-4o",
  ocrModel: "gpt-4o", // OpenAI vision model
});

// Using LM Studio with local models
const result = await indexPdfWithLMStudioOcr(
  "scanned-document.pdf",
  "qwen/qwen3-vl-30b",           // Reasoning model
  "mlx-community/GLM-OCR-bf16"   // OCR vision model
);

// Or use the PageIndex class directly
const pageIndex = new PageIndex({
  model: "qwen/qwen3-vl-30b",
  extractionMode: "ocr",
  ocrModel: "mlx-community/GLM-OCR-bf16",
  imageDpi: 150,
}).useLMStudio();

const result = await pageIndex.fromPdf("scanned-document.pdf");
```

### CLI Usage

```bash
# Process a PDF
bun-pageindex --pdf document.pdf

# Process with LM Studio
bun-pageindex --pdf document.pdf --lmstudio --model llama3

# Process scanned PDF with OCR
bun-pageindex --pdf scanned.pdf --ocr --lmstudio --model qwen/qwen3-vl-30b

# Process markdown with options
bun-pageindex --md README.md --add-doc-description --thinning

# See all options
bun-pageindex --help
```

## API Reference

### PageIndex Class

```typescript
const pageIndex = new PageIndex(options);
```

**Options:**
- `model`: LLM model to use (default: "gpt-4o-2024-11-20")
- `apiKey`: OpenAI API key (default: from OPENAI_API_KEY env var)
- `baseUrl`: Custom API base URL (for LM Studio, Ollama, etc.)
- `tocCheckPageNum`: Pages to check for TOC (default: 20)
- `maxPageNumEachNode`: Max pages per node (default: 10)
- `maxTokenNumEachNode`: Max tokens per node (default: 20000)
- `addNodeId`: Add node IDs (default: true)
- `addNodeSummary`: Generate summaries (default: true)
- `addDocDescription`: Add document description (default: false)
- `addNodeText`: Include raw text (default: false)

**OCR Options:**
- `extractionMode`: "text" (default) or "ocr" for scanned PDFs
- `ocrModel`: Vision model for OCR (default: "mlx-community/GLM-OCR-bf16")
- `ocrPromptType`: "text", "formula", or "table" (default: "text")
- `imageDpi`: DPI for PDF to image conversion (default: 150)
- `imageFormat`: "png" or "jpeg" (default: "png")
- `ocrConcurrency`: Concurrent OCR requests (default: 3)

**Methods:**
- `fromPdf(input)`: Process a PDF file or buffer
- `useLMStudio()`: Configure for LM Studio
- `useOllama()`: Configure for Ollama
- `useOcrMode(ocrModel?)`: Enable OCR mode
- `setBaseUrl(url)`: Set custom API base URL

### mdToTree Function

```typescript
const result = await mdToTree(path, options);
```

**Additional Options:**
- `thinning`: Apply tree thinning (default: false)
- `thinningThreshold`: Min tokens for thinning (default: 5000)
- `summaryTokenThreshold`: Token threshold for summaries (default: 200)

### Result Structure

```typescript
interface PageIndexResult {
  docName: string;
  docDescription?: string;
  structure: TreeNode[];
}

interface TreeNode {
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
```

## Benchmarks

Run benchmarks comparing Bun vs Python implementations:

```bash
# Requires LM Studio running on localhost:1234
bun run benchmark
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build
```

## How It Works

PageIndex uses LLM reasoning to:

1. **Detect Table of Contents**: Scans initial pages for TOC
2. **Extract Structure**: Parses TOC or generates structure from content
3. **Map Page Numbers**: Associates logical page numbers with physical pages
4. **Build Tree**: Creates hierarchical tree structure
5. **Generate Summaries**: Creates summaries for each node (optional)

This approach provides human-like document understanding without the limitations of vector-based retrieval.

### OCR Mode (New in bun-pageindex)

For scanned PDFs, OCR mode adds an additional step:

1. **Convert PDF to Images**: Uses Poppler to render each page as an image
2. **OCR Extraction**: Uses a vision model (GLM-OCR) to extract text from images
3. **Standard Processing**: Continues with the same reasoning-based indexing

This enables processing of scanned documents that the original Python PageIndex cannot handle.

## Credits

This is a Bun/TypeScript port of [PageIndex](https://github.com/VectifyAI/PageIndex) by VectifyAI.

## License

MIT

## Author

Antonio Oliveira <antonio@oakoliver.com> ([oakoliver.com](https://oakoliver.com))
