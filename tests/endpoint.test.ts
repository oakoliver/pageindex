/**
 * Markdown summaries must go to the configured OpenAI-compatible endpoint.
 *
 * Two local fake servers: the one passed as baseUrl, and a "fallback" set as
 * OPENAI_BASE_URL, which is where requests would land if baseUrl were dropped.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { markdownToTree } from "../src/markdown";

function fakeOpenAI(reply: string) {
  const state = { hits: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.hits++;
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      });
    },
  });
  return { state, server, url: `http://127.0.0.1:${server.port}/v1` };
}

const markdown = "# Title\n\nIntro text.\n\n## Section\n\nSection text.\n";

describe("Markdown summaries endpoint", () => {
  const configured = fakeOpenAI("configured summary");
  const fallback = fakeOpenAI("fallback summary");
  const previousBaseUrl = process.env.OPENAI_BASE_URL;

  beforeAll(() => {
    process.env.OPENAI_BASE_URL = fallback.url;
  });

  afterAll(() => {
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    configured.server.stop(true);
    fallback.server.stop(true);
  });

  test("markdownToTree sends summary requests to options.baseUrl", async () => {
    configured.state.hits = 0;
    fallback.state.hits = 0;
    const result = await markdownToTree(markdown, "doc", {
      baseUrl: configured.url,
      apiKey: "test",
      addNodeSummary: true,
      addDocDescription: true,
      summaryTokenThreshold: 0,
    });

    expect(fallback.state.hits).toBe(0);
    expect(configured.state.hits).toBeGreaterThan(0);
    expect(result.docDescription).toBe("configured summary");
  });

  test("the CLI passes --base-url to the markdown path", async () => {
    configured.state.hits = 0;
    fallback.state.hits = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pageindex-endpoint-"));
    const mdPath = path.join(dir, "doc.md");
    const outPath = path.join(dir, "out.json");
    fs.writeFileSync(mdPath, markdown);

    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "--md", mdPath, "--base-url", configured.url, "--add-node-summary", "--summary-token-threshold", "0", "-o", outPath],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: { ...process.env, OPENAI_BASE_URL: fallback.url, OPENAI_API_KEY: "test" },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await proc.exited).toBe(0);

    expect(fallback.state.hits).toBe(0);
    expect(configured.state.hits).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
