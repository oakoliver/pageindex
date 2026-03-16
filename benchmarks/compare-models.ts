import { chatGPT } from "../src/openai";
import { extractJson } from "../src/utils";
import * as prompts from "../src/prompts";

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

const MODELS = [
  "qwen/qwen3-vl-30b",
  "mlx-community/GLM-OCR-bf16"
];

async function testModel(model: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`MODEL: ${model}`);
  console.log("=".repeat(60));
  
  // Test 1: TOC Detection
  console.log("\n--- TOC Detection ---");
  const prompt1 = prompts.tocDetectorPrompt(SAMPLE_TOC);
  const start1 = performance.now();
  const response1 = await chatGPT({
    model,
    prompt: prompt1,
    baseUrl: "http://localhost:1234/v1",
  });
  const time1 = ((performance.now() - start1) / 1000).toFixed(2);
  const json1 = extractJson<{ toc_detected: string; thinking?: string }>(response1);
  console.log(`Time: ${time1}s`);
  console.log(`Raw response (first 500 chars):\n${response1.slice(0, 500)}`);
  console.log(`\nParsed: toc_detected = ${json1?.toc_detected}`);
  
  // Test 2: Page Index Detection
  console.log("\n--- Page Index Detection ---");
  const prompt2 = prompts.detectPageIndexPrompt(SAMPLE_TOC);
  const start2 = performance.now();
  const response2 = await chatGPT({
    model,
    prompt: prompt2,
    baseUrl: "http://localhost:1234/v1",
  });
  const time2 = ((performance.now() - start2) / 1000).toFixed(2);
  const json2 = extractJson<{ page_index_given_in_toc: string }>(response2);
  console.log(`Time: ${time2}s`);
  console.log(`Raw response (first 500 chars):\n${response2.slice(0, 500)}`);
  console.log(`\nParsed: page_index_given_in_toc = ${json2?.page_index_given_in_toc}`);
  
  // Test 3: TOC Transformation
  console.log("\n--- TOC Transformation ---");
  const prompt3 = prompts.tocTransformerPrompt(SAMPLE_TOC);
  const start3 = performance.now();
  const response3 = await chatGPT({
    model,
    prompt: prompt3,
    baseUrl: "http://localhost:1234/v1",
  });
  const time3 = ((performance.now() - start3) / 1000).toFixed(2);
  const json3 = extractJson<{ table_of_contents: unknown[] }>(response3);
  console.log(`Time: ${time3}s`);
  console.log(`Raw response (first 1000 chars):\n${response3.slice(0, 1000)}`);
  console.log(`\nParsed items: ${json3?.table_of_contents?.length || 0}`);
  if (json3?.table_of_contents) {
    console.log(`First 3 items:\n${JSON.stringify(json3.table_of_contents.slice(0, 3), null, 2)}`);
  }
  
  return {
    model,
    tocDetected: json1?.toc_detected,
    pageIndexDetected: json2?.page_index_given_in_toc,
    tocItems: json3?.table_of_contents?.length || 0,
    totalTime: parseFloat(time1) + parseFloat(time2) + parseFloat(time3)
  };
}

async function main() {
  const results = [];
  
  for (const model of MODELS) {
    try {
      const result = await testModel(model);
      results.push(result);
    } catch (e) {
      console.error(`Error with ${model}:`, e);
    }
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log("\n| Model | TOC Detected | Page Index | TOC Items | Time |");
  console.log("|-------|--------------|------------|-----------|------|");
  for (const r of results) {
    console.log(`| ${r.model} | ${r.tocDetected} | ${r.pageIndexDetected} | ${r.tocItems} | ${r.totalTime.toFixed(1)}s |`);
  }
}

main().catch(console.error);
