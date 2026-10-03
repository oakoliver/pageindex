# bun-pageindex

Bun-native vectorless, reasoning-based RAG for document understanding. A TypeScript port of [PageIndex](https://github.com/VectifyAI/PageIndex) optimized for the Bun runtime.

> **Upstream parity:** the standard (LLM) PDF pipeline and the Markdown pipeline are at parity with upstream PageIndex **v0.2.19** (2026-09-21). Previous baseline: upstream commit `959452d` (2026-03-04). Upstream-only surfaces that are not ported: PageIndex Flash (the deterministic PDF parser), the LLM-driven `optimize_tree` expand pass, the local/cloud SDK clients, chat/agent tools, MCP bridge and LiteLLM provider routing (this port stays on OpenAI-compatible endpoints).

<p align="center">
  <img src="https://raw.githubusercontent.com/oakoliver/pageindex/main/assets/tree.gif" alt="Terminal recording: bun examples/tree.ts turns a sample Markdown handbook into a 15-node tree with node IDs, line numbers and token estimates, then reruns with --thinning 120 and the small sections merge into their parents, leaving 11 nodes" width="760">
</p>

<sub>Recorded with <a href="https://github.com/oakoliver/vhs">@oakoliver/vhs</a> from <a href="examples/tree.ts"><code>examples/tree.ts</code></a> on <a href="examples/weather-station.md">a sample document</a>. Markdown indexing with summaries off makes no LLM calls, so this runs offline.</sub>

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

# Process markdown with options (Markdown runs no LLM passes unless asked)
bun-pageindex --md README.md --add-node-summary --add-doc-description --thinning

# Separate models for indexing and summaries
bun-pageindex --pdf document.pdf --index-model gpt-5.6-luna --summary-model gpt-4.1-mini

# See all options
bun-pageindex --help
```

<img src="https://raw.githubusercontent.com/oakoliver/pageindex/main/assets/cli.png" alt="Running bun src/cli.ts --md examples/weather-station.md --no-node-summary -o /tmp/ws.json, followed by the first lines of the JSON tree it writes: docName, then nested nodes with title, nodeId and lineNum" width="720">

<sub>The CLI from source on the sample Markdown file, summaries off (no API key needed).</sub>

## API Reference

### PageIndex Class

```typescript
const pageIndex = new PageIndex(options);
```

**Options:**
- `model`: Model used to index the document (default: "gpt-5.6-luna", upstream's default index model)
- `summaryModel`: Model for node summaries and the document description (default: `model`)
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

Lines consisting only of bold text (`**Heading**`) are treated as level-1 headings, and the result includes `lineCount`.

**Additional Options:**
- `thinning`: Apply tree thinning (default: false)
- `thinningThreshold`: Min tokens for thinning (default: 5000)
- `summaryTokenThreshold`: Token threshold for summaries (default: 200)

### Result Structure

```typescript
interface PageIndexResult {
  docName: string;
  docDescription?: string;
  lineCount?: number; // markdown only
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
  keyItems?: string[]; // titles folded into this node by the tree merge pass
  nodes?: TreeNode[];
}
```

### Behavior notes (upstream v0.2.19)

- **Prompt-injection hardening**: document text is sanitized (known injection phrases are redacted) and wrapped in `<user_document>` delimiters before it reaches the LLM, and document-bearing prompts carry a hardening preamble.
- **Physical index validation**: page markers returned by the LLM are dropped when they are not in the chunk the model saw or fall outside the document; TOC entries that end up unplaced are left out of the tree.
- **Tree merge**: after the tree is built, subtrees whose structure does not beat a linear scan of their pages are collapsed into their parent; the removed titles are kept as `keyItems`.
- **Fail-loud LLM errors**: 400/401/403/404 are not retried; exhausted retries throw `LLMRetriesExhausted` instead of returning `"Error"`. Bad credentials or a missing model fail the run; per-prompt failures (e.g. context overflow) leave an empty summary/description; if every summary comes back empty the run fails.
- `temperature` is no longer sent unless you pass one explicitly; `CHATGPT_API_KEY` is accepted as a deprecated alias for `OPENAI_API_KEY`.

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

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/oakoliver/pageindex/main/assets/indexing-dark.png">
  <img src="https://raw.githubusercontent.com/oakoliver/pageindex/main/assets/indexing-light.png" alt="Pipeline diagram. PDF input: PDF file to page text (pdf-parse, or OCR with Poppler and a vision model). LLM reasoning: detect TOC (are page numbers given?), build TOC entries from the TOC or from content, verify and fix them against the pages. Local: build tree with node IDs, written as the JSON tree index; optional LLM summaries. Markdown input: Markdown file to headings to optional thinning, joining the same build-tree step without any LLM call." width="820">
</picture>

<sub>Drawn from <code>PageIndex.processPdfPages</code> and <code>mdToTree</code>; source: <a href="assets/diagrams/indexing.workflow.json"><code>assets/diagrams/indexing.workflow.json</code></a> (<a href="assets/indexing.svg">SVG</a>). This package builds the index; searching the tree is up to your application.</sub>

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
