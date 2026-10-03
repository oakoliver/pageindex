/**
 * Markdown indexing must not load the PDF stack: pdfjs-dist (via pdf-parse)
 * needs DOMMatrix, which Node 18 lacks, and used to break the whole import.
 * Runs the built ESM and CJS bundles under Node 18 when one is installed
 * (set NODE18 to its path, or have it under ~/.nvm).
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const env = { ...process.env, PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}` };

function findNode18(): string | undefined {
  if (process.env.NODE18 && existsSync(process.env.NODE18)) return process.env.NODE18;
  const nvm = join(homedir(), ".nvm/versions/node");
  if (!existsSync(nvm)) return undefined;
  const v18 = readdirSync(nvm).filter((v) => v.startsWith("v18.")).sort().pop();
  return v18 ? join(nvm, v18, "bin/node") : undefined;
}

const node18 = findNode18();
const script = (load: string) => `
${load}
const tree = await markdownToTree("# Title\\n\\nBody.\\n\\n## Child\\n\\nMore.\\n", "doc", { addNodeSummary: false });
console.log(JSON.stringify(tree.structure.map((n) => n.title)));
`;

describe.skipIf(!node18)("Node 18", () => {
  it("indexes Markdown with the ESM and CJS builds", () => {
    expect(Bun.spawnSync(["npm", "run", "build:esm"], { cwd: root, env }).exitCode).toBe(0);
    expect(Bun.spawnSync(["npm", "run", "build:cjs"], { cwd: root, env }).exitCode).toBe(0);
    for (const load of [
      `import { markdownToTree } from "./dist/index.js";`,
      `const { markdownToTree } = (await import("node:module")).createRequire(import.meta.url)("./dist/index.cjs");`,
    ]) {
      const proc = Bun.spawnSync([node18!, "--input-type=module", "-e", script(load)], { cwd: root });
      const out = proc.stdout.toString().trim().split("\n").pop();
      expect(`${proc.stderr.toString().split("\n")[0]}|${out}`).toBe(`|["Title"]`);
    }
  }, 120_000);
});
