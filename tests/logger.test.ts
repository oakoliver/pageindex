/**
 * Progress lines go through options.logger (default console.log), so library
 * users can silence them or keep stdout clean.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { mdToTree, markdownToTree } from "../src/markdown.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const markdown = "# Title\n\nIntro.\n\n## Part\n\nBody.\n";

describe("logger option", () => {
  test("markdownToTree and mdToTree send progress to the logger, not stdout", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pageindex-log-")), "doc.md");
    fs.writeFileSync(file, markdown);
    const stdout = spyOn(console, "log");
    try {
      const lines: string[] = [];
      await markdownToTree(markdown, "doc", { logger: (m) => lines.push(m), thinning: true });
      await mdToTree(file, { logger: (m) => lines.push(m) });
      expect(stdout).not.toHaveBeenCalled();
      expect(lines).toContain("Extracting nodes from markdown...");
      expect(lines).toContain("Thinning nodes...");
    } finally {
      stdout.mockRestore();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  test("defaults to console.log", async () => {
    const stdout = spyOn(console, "log").mockImplementation(() => {});
    try {
      await markdownToTree(markdown, "doc");
      expect(stdout).toHaveBeenCalledWith("Extracting nodes from markdown...");
    } finally {
      stdout.mockRestore();
    }
  });
});
