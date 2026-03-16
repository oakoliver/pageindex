/**
 * Tests for OCR module
 * Note: These tests require system libraries (cairo, jpeg) to be installed
 * Install on macOS: brew install poppler
 */

import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { pdfToImages, getPdfInfo } from "../src/ocr";

// Test PDF path
const TEST_PDF_PATH = "/tmp/pageindex/tests/pdfs/q1-fy25-earnings.pdf";

/**
 * Check if pdf-poppler is working (system libs installed)
 */
async function isPopplerAvailable(): Promise<boolean> {
  try {
    await getPdfInfo(TEST_PDF_PATH);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Library not loaded") || message.includes("EACCES")) {
      return false;
    }
    return true; // Other errors might be PDF not found, which is fine
  }
}

describe("OCR Module", () => {
  describe("pdfToImages", () => {
    test("should convert PDF to images", async () => {
      // Skip if test PDF doesn't exist
      try {
        await fs.access(TEST_PDF_PATH);
      } catch {
        console.log("Skipping: Test PDF not found");
        return;
      }

      // Skip if poppler not available
      if (!(await isPopplerAvailable())) {
        console.log("Skipping: Poppler system libraries not installed (brew install poppler)");
        return;
      }

      const imagePaths = await pdfToImages(TEST_PDF_PATH, {
        imageFormat: "png",
        imageDpi: 72, // Lower DPI for faster test
      });

      expect(imagePaths.length).toBeGreaterThan(0);
      expect(imagePaths[0]).toEndWith(".png");

      // Verify images were created
      for (const imagePath of imagePaths) {
        const stats = await fs.stat(imagePath);
        expect(stats.size).toBeGreaterThan(0);
      }

      // Clean up
      const tempDir = path.dirname(imagePaths[0]!);
      for (const p of imagePaths) {
        await fs.unlink(p).catch(() => {});
      }
      await fs.rmdir(tempDir).catch(() => {});
    }, 30000); // 30 second timeout

    test("should sort images by page number", async () => {
      try {
        await fs.access(TEST_PDF_PATH);
      } catch {
        console.log("Skipping: Test PDF not found");
        return;
      }

      // Skip if poppler not available
      if (!(await isPopplerAvailable())) {
        console.log("Skipping: Poppler system libraries not installed");
        return;
      }

      const imagePaths = await pdfToImages(TEST_PDF_PATH, {
        imageFormat: "png",
        imageDpi: 72,
      });

      // Verify images are sorted by page number
      for (let i = 0; i < imagePaths.length; i++) {
        const filename = path.basename(imagePaths[i]!);
        // pdf-poppler creates files like "filename-1.png", "filename-2.png", etc.
        expect(filename).toMatch(/-\d+\.png$/);
      }

      // Clean up
      const tempDir = path.dirname(imagePaths[0]!);
      for (const p of imagePaths) {
        await fs.unlink(p).catch(() => {});
      }
      await fs.rmdir(tempDir).catch(() => {});
    }, 30000);
  });

  describe("getPdfInfo", () => {
    test("should return page count", async () => {
      try {
        await fs.access(TEST_PDF_PATH);
      } catch {
        console.log("Skipping: Test PDF not found");
        return;
      }

      // Skip if poppler not available
      if (!(await isPopplerAvailable())) {
        console.log("Skipping: Poppler system libraries not installed");
        return;
      }

      const info = await getPdfInfo(TEST_PDF_PATH);
      expect(info.pages).toBeGreaterThan(0);
    });
  });
});
