/**
 * Benchmark: bun-pageindex vs Python pageindex
 *
 * Compares performance using LM Studio as the local LLM server.
 */

import { PageIndex } from "../src/pageindex";
import * as fs from "fs";
import * as path from "path";

// Use PDF with proper TOC for faster processing
const TEST_PDF = "/tmp/pageindex/tests/pdfs/2023-annual-report-truncated.pdf";
const MODEL = "qwen/qwen3.5-9b"; // Use available model from LM Studio

interface BenchmarkResult {
  implementation: string;
  documentName: string;
  totalTimeMs: number;
  success: boolean;
  error?: string;
}

async function benchmarkBunPdf(): Promise<BenchmarkResult> {
  const pdfName = path.basename(TEST_PDF, ".pdf");
  console.log(`\n[Bun] Processing PDF: ${pdfName}`);
  console.log("[Bun] Starting...");

  const startTime = performance.now();

  try {
    const pageIndex = new PageIndex({
      model: MODEL,
      addNodeSummary: false, // Skip summaries for faster benchmark
      addNodeText: false,
    }).useLMStudio();

    const result = await pageIndex.fromPdf(TEST_PDF);
    const endTime = performance.now();

    console.log(`[Bun] Completed. Found ${result.structure.length} top-level nodes`);

    return {
      implementation: "bun",
      documentName: pdfName,
      totalTimeMs: endTime - startTime,
      success: true,
    };
  } catch (error) {
    const endTime = performance.now();
    return {
      implementation: "bun",
      documentName: pdfName,
      totalTimeMs: endTime - startTime,
      success: false,
      error: String(error),
    };
  }
}

async function benchmarkPythonPdf(): Promise<BenchmarkResult> {
  const pdfName = path.basename(TEST_PDF, ".pdf");
  console.log(`\n[Python] Processing PDF: ${pdfName}`);
  console.log("[Python] Starting...");

  const pythonScript = `
import time
import sys
import json
import os

sys.path.insert(0, '/tmp/pageindex')
os.environ['OPENAI_API_KEY'] = 'lm-studio'
os.environ['OPENAI_BASE_URL'] = 'http://localhost:1234/v1'

from pageindex import page_index_main, config

start_time = time.time()

opt = config(
    model="${MODEL}",
    if_add_node_summary="no",
    if_add_node_text="no",
)

try:
    result = page_index_main("${TEST_PDF}", opt)
    end_time = time.time()
    
    num_nodes = len(result.get('structure', []))
    print(json.dumps({
        "success": True,
        "total_time_ms": (end_time - start_time) * 1000,
        "num_nodes": num_nodes
    }))
except Exception as e:
    end_time = time.time()
    print(json.dumps({
        "success": False,
        "total_time_ms": (end_time - start_time) * 1000,
        "error": str(e)
    }))
`;

  const startTime = performance.now();

  const proc = Bun.spawn(["python3", "-c", pythonScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENAI_API_KEY: "lm-studio",
      OPENAI_BASE_URL: "http://localhost:1234/v1",
    },
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const endTime = performance.now();

  // Print stderr for debugging (Python logs go here)
  if (stderr) {
    const lines = stderr.split("\n").filter(l => l.trim());
    for (const line of lines.slice(-10)) { // Last 10 lines
      console.log(`[Python] ${line}`);
    }
  }

  try {
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine || "{}");

    if (result.success) {
      console.log(`[Python] Completed. Found ${result.num_nodes} top-level nodes`);
    }

    return {
      implementation: "python",
      documentName: pdfName,
      totalTimeMs: result.total_time_ms || endTime - startTime,
      success: result.success || false,
      error: result.error,
    };
  } catch {
    return {
      implementation: "python",
      documentName: pdfName,
      totalTimeMs: endTime - startTime,
      success: false,
      error: "Failed to parse output",
    };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("bun-pageindex vs Python pageindex Benchmark");
  console.log("=".repeat(60));
  console.log(`\nModel: ${MODEL}`);
  console.log(`PDF: ${TEST_PDF}`);

  // Check LM Studio
  try {
    const response = await fetch("http://localhost:1234/v1/models");
    if (!response.ok) throw new Error("LM Studio not responding");
  } catch {
    console.error("\nERROR: LM Studio is not running on localhost:1234");
    process.exit(1);
  }

  console.log("\nLM Studio detected. Starting benchmarks...");

  // Run benchmarks
  const results: BenchmarkResult[] = [];

  // Run Bun benchmark
  const bunResult = await benchmarkBunPdf();
  results.push(bunResult);

  // Run Python benchmark  
  const pythonResult = await benchmarkPythonPdf();
  results.push(pythonResult);

  // Print results
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  for (const result of results) {
    const status = result.success ? "SUCCESS" : "FAILED";
    console.log(`\n${result.implementation.toUpperCase()}:`);
    console.log(`  Status: ${status}`);
    console.log(`  Time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }

  // Calculate speedup
  if (bunResult.success && pythonResult.success) {
    const speedup = pythonResult.totalTimeMs / bunResult.totalTimeMs;
    console.log("\n" + "-".repeat(60));
    if (speedup > 1) {
      console.log(`Bun is ${speedup.toFixed(2)}x FASTER than Python`);
    } else {
      console.log(`Python is ${(1 / speedup).toFixed(2)}x faster than Bun`);
    }
    console.log("-".repeat(60));
  }

  // Save results
  const resultsDir = "./benchmarks/results";
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const resultsPath = path.join(resultsDir, `benchmark-${Date.now()}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsPath}`);
}

main().catch(console.error);
