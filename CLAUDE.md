
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## bun-pageindex Project Notes

### LM Studio API Integration

The project supports two LM Studio API modes:

1. **OpenAI-compatible endpoint** (`/v1/chat/completions`): Standard endpoint that works with all models
2. **Native REST API** (`/api/v1/chat`): Supports `reasoning: "off"` parameter for "thinking" models

**Important**: The native API's `reasoning` parameter only works with specific thinking models (qwen3.5, qwen3-coder, deepseek, o1, o3). Other models (like `qwen/qwen3-vl-30b`) will return a 400 error if `reasoning` is sent.

The code in `src/openai.ts` automatically detects thinking models via `isThinkingModel()` and routes accordingly:
- Thinking models → Native API with `reasoning: "off"` for faster inference
- Other models → Standard OpenAI-compatible endpoint

### OCR Mode (New Feature)

OCR mode enables processing of scanned PDFs that the original Python PageIndex cannot handle:

1. **Architecture**: PDF → Images (pdf-poppler) → OCR (GLM-OCR vision) → Text → Reasoning (qwen3-vl)
2. **Key files**:
   - `src/ocr.ts` - PDF to image conversion and OCR extraction
   - `src/types.ts` - ExtractionMode, OcrOptions types
   - `src/pageindex.ts` - fromPdf() checks extractionMode and routes accordingly

3. **Dependencies**:
   - `pdf-poppler` - PDF to image conversion (requires system Poppler installed)
   - Poppler system libs: `brew install poppler` (macOS)

4. **Models**:
   - OCR: `mlx-community/GLM-OCR-bf16` - Best for image-to-text extraction
   - Reasoning: `qwen/qwen3-vl-30b` - Best for TOC detection and JSON extraction

5. **Usage**:
   ```typescript
   const pageIndex = new PageIndex({
     model: "qwen/qwen3-vl-30b",
     extractionMode: "ocr",
     ocrModel: "mlx-community/GLM-OCR-bf16",
   }).useLMStudio();
   ```

### Running Benchmarks

```bash
# Simple LLM benchmark (tests TOC detection prompts)
bun run benchmarks/benchmark-simple.ts

# Full PDF benchmark
bun run benchmarks/benchmark.ts
```

### Testing

```bash
bun test
```

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
