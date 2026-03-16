/**
 * Simple Benchmark: bun-pageindex vs Python pageindex
 * 
 * Measures core LLM call performance with LM Studio.
 * This avoids the complexity of full PDF processing.
 */

import { chatGPT } from "../src/openai";
import { extractJson } from "../src/utils";
import * as prompts from "../src/prompts";

const MODEL = "mlx-community/GLM-OCR-bf16";

// Sample TOC content for testing
const SAMPLE_TOC = `Contents
Chapter 1: Introduction ........................... 1
  1.1 Background ...................................... 3
  1.2 Objectives ...................................... 5
Chapter 2: Methods .................................. 10
  2.1 Data Collection ................................ 12
  2.2 Analysis ........................................ 15
Chapter 3: Results .................................. 20
  3.1 Findings ........................................ 22
  3.2 Discussion ...................................... 28
Chapter 4: Conclusion ............................... 35
References ........................................... 40`;

interface BenchResult {
  implementation: string;
  test: string;
  timeMs: number;
  success: boolean;
  error?: string;
}

async function benchmarkBunLLMCalls(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  
  console.log("\n[Bun] Running LLM call benchmarks...");
  
  // Test 1: TOC Detection
  {
    const start = performance.now();
    try {
      const prompt = prompts.tocDetectorPrompt(SAMPLE_TOC);
      const response = await chatGPT({
        model: MODEL,
        prompt,
        baseUrl: "http://localhost:1234/v1",
      });
      const json = extractJson<{ toc_detected: string }>(response);
      const end = performance.now();
      
      results.push({
        implementation: "bun",
        test: "TOC Detection",
        timeMs: end - start,
        success: json?.toc_detected === "yes",
      });
      console.log(`  TOC Detection: ${((end - start) / 1000).toFixed(2)}s - ${json?.toc_detected}`);
    } catch (e) {
      results.push({
        implementation: "bun",
        test: "TOC Detection",
        timeMs: 0,
        success: false,
        error: String(e),
      });
    }
  }
  
  // Test 2: Page Index Detection
  {
    const start = performance.now();
    try {
      const prompt = prompts.detectPageIndexPrompt(SAMPLE_TOC);
      const response = await chatGPT({
        model: MODEL,
        prompt,
        baseUrl: "http://localhost:1234/v1",
      });
      const json = extractJson<{ page_index_given_in_toc: string }>(response);
      const end = performance.now();
      
      results.push({
        implementation: "bun",
        test: "Page Index Detection",
        timeMs: end - start,
        success: json?.page_index_given_in_toc === "yes",
      });
      console.log(`  Page Index Detection: ${((end - start) / 1000).toFixed(2)}s - ${json?.page_index_given_in_toc}`);
    } catch (e) {
      results.push({
        implementation: "bun",
        test: "Page Index Detection",
        timeMs: 0,
        success: false,
        error: String(e),
      });
    }
  }
  
  // Test 3: TOC Transformation
  {
    const start = performance.now();
    try {
      const prompt = prompts.tocTransformerPrompt(SAMPLE_TOC);
      const response = await chatGPT({
        model: MODEL,
        prompt,
        baseUrl: "http://localhost:1234/v1",
      });
      const json = extractJson<{ table_of_contents: unknown[] }>(response);
      const end = performance.now();
      
      results.push({
        implementation: "bun",
        test: "TOC Transformation",
        timeMs: end - start,
        success: Array.isArray(json?.table_of_contents),
      });
      console.log(`  TOC Transformation: ${((end - start) / 1000).toFixed(2)}s - ${json?.table_of_contents?.length || 0} items`);
    } catch (e) {
      results.push({
        implementation: "bun",
        test: "TOC Transformation",
        timeMs: 0,
        success: false,
        error: String(e),
      });
    }
  }
  
  return results;
}

async function benchmarkPythonLLMCalls(): Promise<BenchResult[]> {
  console.log("\n[Python] Running LLM call benchmarks...");
  
  const pythonScript = `
import time
import json
import os
import sys

sys.path.insert(0, '/tmp/pageindex')
os.environ['OPENAI_API_KEY'] = 'lm-studio'
os.environ['OPENAI_BASE_URL'] = 'http://localhost:1234/v1'

from openai import OpenAI

client = OpenAI(
    api_key='lm-studio',
    base_url='http://localhost:1234/v1'
)

SAMPLE_TOC = """Contents
Chapter 1: Introduction ........................... 1
  1.1 Background ...................................... 3
  1.2 Objectives ...................................... 5
Chapter 2: Methods .................................. 10
  2.1 Data Collection ................................ 12
  2.2 Analysis ........................................ 15
Chapter 3: Results .................................. 20
  3.1 Findings ........................................ 22
  3.2 Discussion ...................................... 28
Chapter 4: Conclusion ............................... 35
References ........................................... 40"""

results = []

# Test 1: TOC Detection
prompt1 = f"""Your job is to detect if there is a table of content provided in the given text.

Given text: {SAMPLE_TOC}

return the following JSON format:
{{
    "thinking": <why do you think there is a table of content in the given text>
    "toc_detected": "<yes or no>",
}}

Directly return the final JSON structure. Do not output anything else."""

start = time.time()
try:
    response = client.chat.completions.create(
        model="${MODEL}",
        messages=[{"role": "user", "content": prompt1}],
        temperature=0
    )
    content = response.choices[0].message.content
    end = time.time()
    results.append({
        "test": "TOC Detection",
        "time_ms": (end - start) * 1000,
        "success": "yes" in content.lower() if content else False
    })
except Exception as e:
    results.append({"test": "TOC Detection", "time_ms": 0, "success": False, "error": str(e)})

# Test 2: Page Index Detection  
prompt2 = f"""You will be given a table of contents.

Your job is to detect if there are page numbers/indices given within the table of contents.

Given text: {SAMPLE_TOC}

Reply format:
{{
    "thinking": <why do you think there are page numbers/indices given within the table of contents>
    "page_index_given_in_toc": "<yes or no>"
}}
Directly return the final JSON structure. Do not output anything else."""

start = time.time()
try:
    response = client.chat.completions.create(
        model="${MODEL}",
        messages=[{"role": "user", "content": prompt2}],
        temperature=0
    )
    content = response.choices[0].message.content
    end = time.time()
    results.append({
        "test": "Page Index Detection",
        "time_ms": (end - start) * 1000,
        "success": "yes" in content.lower() if content else False
    })
except Exception as e:
    results.append({"test": "Page Index Detection", "time_ms": 0, "success": False, "error": str(e)})

# Test 3: TOC Transformation
prompt3 = f"""You are an expert in extracting hierarchical tree structure.
You will be given a table of contents.
Your task is to extract the tree structure from the table of contents.

Reply format:
{{
    "table_of_contents": [
        {{
            "structure": <structure index, "x.x.x">,
            "title": <title of the section>,
            "page": <page number or null>
        }},
    ]
}}
Directly return the final JSON structure. Do not output anything else.

Given text:
{SAMPLE_TOC}"""

start = time.time()
try:
    response = client.chat.completions.create(
        model="${MODEL}",
        messages=[{"role": "user", "content": prompt3}],
        temperature=0
    )
    content = response.choices[0].message.content
    end = time.time()
    results.append({
        "test": "TOC Transformation",
        "time_ms": (end - start) * 1000,
        "success": "table_of_contents" in (content or "")
    })
except Exception as e:
    results.append({"test": "TOC Transformation", "time_ms": 0, "success": False, "error": str(e)})

print(json.dumps(results))
`;

  const proc = Bun.spawn(["python3", "-c", pythonScript], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  
  if (stderr) {
    console.error("[Python] stderr:", stderr.slice(-500));
  }

  try {
    const pythonResults = JSON.parse(output.trim()) as Array<{
      test: string;
      time_ms: number;
      success: boolean;
      error?: string;
    }>;
    
    for (const r of pythonResults) {
      console.log(`  ${r.test}: ${(r.time_ms / 1000).toFixed(2)}s - ${r.success ? "success" : "failed"}`);
    }
    
    return pythonResults.map(r => ({
      implementation: "python",
      test: r.test,
      timeMs: r.time_ms,
      success: r.success,
      error: r.error,
    }));
  } catch {
    console.error("[Python] Failed to parse output:", output.slice(0, 500));
    return [];
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("bun-pageindex vs Python LLM Call Benchmark");
  console.log("=".repeat(60));
  console.log(`Model: ${MODEL}`);
  console.log(`Using OpenAI-compatible API (localhost:1234/v1)`);

  // Check LM Studio
  try {
    const response = await fetch("http://localhost:1234/v1/models");
    if (!response.ok) throw new Error("LM Studio not responding");
  } catch {
    console.error("\nERROR: LM Studio is not running on localhost:1234");
    process.exit(1);
  }

  const bunResults = await benchmarkBunLLMCalls();
  const pythonResults = await benchmarkPythonLLMCalls();
  
  // Compare results
  console.log("\n" + "=".repeat(60));
  console.log("COMPARISON");
  console.log("=".repeat(60));
  
  const tests = ["TOC Detection", "Page Index Detection", "TOC Transformation"];
  let totalBun = 0;
  let totalPython = 0;
  
  for (const test of tests) {
    const bunResult = bunResults.find(r => r.test === test);
    const pythonResult = pythonResults.find(r => r.test === test);
    
    if (bunResult && pythonResult) {
      const speedup = pythonResult.timeMs / bunResult.timeMs;
      totalBun += bunResult.timeMs;
      totalPython += pythonResult.timeMs;
      
      console.log(`\n${test}:`);
      console.log(`  Bun:    ${(bunResult.timeMs / 1000).toFixed(2)}s`);
      console.log(`  Python: ${(pythonResult.timeMs / 1000).toFixed(2)}s`);
      console.log(`  Speedup: ${speedup.toFixed(2)}x ${speedup > 1 ? "(Bun faster)" : "(Python faster)"}`);
    }
  }
  
  console.log("\n" + "-".repeat(60));
  console.log("TOTAL:");
  console.log(`  Bun:    ${(totalBun / 1000).toFixed(2)}s`);
  console.log(`  Python: ${(totalPython / 1000).toFixed(2)}s`);
  const totalSpeedup = totalPython / totalBun;
  console.log(`  Overall: Bun is ${totalSpeedup.toFixed(2)}x ${totalSpeedup > 1 ? "FASTER" : "slower"} than Python`);
  console.log("-".repeat(60));
}

main().catch(console.error);
