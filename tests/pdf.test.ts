import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { parsePdf } from "../src/pdf.js";

describe("parsePdf", () => {
  it("extracts page text (pdf-parse is loaded on first use)", async () => {
    const pdf = await parsePdf(join(import.meta.dir, "fixtures/hello.pdf"));
    expect(pdf.numPages).toBe(1);
    expect(pdf.pages[0].text).toContain("Hello from a PDF");
  });
});
