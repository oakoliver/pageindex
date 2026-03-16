/**
 * bun-pageindex: OpenAI-compatible API utilities
 * Supports OpenAI, LM Studio, Ollama, and other compatible endpoints
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** Cross-runtime sleep function */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let clientInstance: OpenAI | null = null;
let currentBaseUrl: string | undefined;

export interface ClientConfig {
  apiKey?: string;
  baseUrl?: string; // For LM Studio: http://localhost:1234/v1
}

function getClient(config: ClientConfig = {}): OpenAI {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || "lm-studio";
  const baseUrl = config.baseUrl || process.env.OPENAI_BASE_URL;

  // Reuse client if same config
  if (clientInstance && currentBaseUrl === baseUrl) {
    return clientInstance;
  }

  clientInstance = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  currentBaseUrl = baseUrl;

  return clientInstance;
}

export interface ChatOptions {
  model: string;
  prompt: string;
  apiKey?: string;
  baseUrl?: string;
  chatHistory?: ChatCompletionMessageParam[];
  temperature?: number;
  maxRetries?: number;
}

export interface ChatResult {
  content: string;
  finishReason: "finished" | "max_output_reached" | "error";
}

/**
 * Call ChatGPT-compatible API with retry logic
 * Works with OpenAI, LM Studio, Ollama, etc.
 * For LM Studio thinking models, uses native API with reasoning disabled for better performance
 */
export async function chatGPT(options: ChatOptions): Promise<string> {
  // Use native LM Studio API only for known thinking models that support reasoning parameter
  // Other models should use the standard OpenAI-compatible endpoint
  if (isLMStudio(options.baseUrl) && isThinkingModel(options.model)) {
    const result = await chatLMStudioNative(options);
    return result.content;
  }
  
  // Use OpenAI-compatible endpoint for all other cases
  const result = await chatGPTWithFinishReason(options);
  return result.content;
}

/**
 * Call ChatGPT-compatible API with retry logic and finish reason
 */
export async function chatGPTWithFinishReason(
  options: ChatOptions
): Promise<ChatResult> {
  const {
    model,
    prompt,
    apiKey,
    baseUrl,
    chatHistory,
    temperature = 0,
    maxRetries = 10,
  } = options;

  const client = getClient({ apiKey, baseUrl });

  const messages: ChatCompletionMessageParam[] = chatHistory
    ? [...chatHistory, { role: "user" as const, content: prompt }]
    : [{ role: "user" as const, content: prompt }];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No response from model");
      }

      const finishReason =
        choice.finish_reason === "length" ? "max_output_reached" : "finished";

      return {
        content: choice.message.content || "",
        finishReason,
      };
    } catch (error) {
      console.error(`[Retry ${attempt + 1}/${maxRetries}]`, error);
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1)); // Exponential backoff
      } else {
        console.error("Max retries reached for prompt:", prompt.slice(0, 100));
        return { content: "Error", finishReason: "error" };
      }
    }
  }

  return { content: "Error", finishReason: "error" };
}

/**
 * Batch multiple chat calls concurrently with rate limiting
 */
export async function chatGPTBatch(
  prompts: Array<{ prompt: string; model: string }>,
  options: { apiKey?: string; baseUrl?: string; concurrency?: number } = {}
): Promise<string[]> {
  const { concurrency = 5 } = options;
  const results: string[] = [];

  for (let i = 0; i < prompts.length; i += concurrency) {
    const batch = prompts.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((p) =>
        chatGPT({ ...p, apiKey: options.apiKey, baseUrl: options.baseUrl })
      )
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Get default LM Studio configuration
 */
export function getLMStudioConfig(): ClientConfig {
  return {
    apiKey: "lm-studio",
    baseUrl: "http://localhost:1234/v1",
  };
}

/**
 * Get default Ollama configuration
 */
export function getOllamaConfig(): ClientConfig {
  return {
    apiKey: "ollama",
    baseUrl: "http://localhost:11434/v1",
  };
}

/**
 * Check if we're using LM Studio based on the baseUrl
 */
function isLMStudio(baseUrl?: string): boolean {
  return baseUrl?.includes("localhost:1234") ?? false;
}

/**
 * Check if a model is a known "thinking" model that supports the reasoning parameter
 * These models benefit from reasoning: "off" for faster inference
 */
function isThinkingModel(model: string): boolean {
  const thinkingModelPatterns = [
    /qwen3\.5/i,          // qwen3.5 series supports reasoning
    /qwen3-coder/i,       // qwen3-coder supports reasoning
    /deepseek/i,          // deepseek models support reasoning
    /o1/i,                // OpenAI o1 models
    /o3/i,                // OpenAI o3 models
  ];
  
  return thinkingModelPatterns.some(pattern => pattern.test(model));
}

// Track which models don't support reasoning parameter
const modelsWithoutReasoning = new Set<string>();

/**
 * Call LM Studio's native REST API with reasoning disabled (if supported)
 * This is much faster for thinking models like Qwen
 */
async function chatLMStudioNative(options: ChatOptions): Promise<ChatResult> {
  const {
    model,
    prompt,
    temperature = 0,
    maxRetries = 10,
  } = options;

  const baseUrl = "http://localhost:1234";
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Build request body - only include reasoning: "off" if model supports it
      const body: Record<string, unknown> = {
        model,
        input: prompt,
        temperature,
      };
      
      if (!modelsWithoutReasoning.has(model)) {
        body.reasoning = "off";
      }

      const response = await fetch(`${baseUrl}/api/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json() as {
        output?: Array<{ type: string; content?: string }>;
        message?: string;
        type?: string;
        param?: string;
      };

      // Check for errors first
      if (!response.ok) {
        // If reasoning not supported, remember this and retry without it
        if (data.type === "invalid_request" && data.param === "reasoning") {
          console.log(`[LM Studio] Model ${model} doesn't support reasoning parameter, retrying without it`);
          modelsWithoutReasoning.add(model);
          
          const retryResponse = await fetch(`${baseUrl}/api/v1/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              input: prompt,
              temperature,
            }),
          });
          
          if (!retryResponse.ok) {
            const retryError = await retryResponse.text();
            throw new Error(`LM Studio API error on retry: ${retryResponse.status} - ${retryError}`);
          }
          
          const retryData = await retryResponse.json() as {
            output?: Array<{ type: string; content?: string }>;
          };
          
          const messageOutput = retryData.output?.find(o => o.type === "message");
          return {
            content: messageOutput?.content || "",
            finishReason: "finished",
          };
        }
        
        throw new Error(`LM Studio API error: ${response.status} - ${data.message || JSON.stringify(data)}`);
      }

      // Extract the message content from the response
      const messageOutput = data.output?.find(o => o.type === "message");
      const content = messageOutput?.content || "";

      return {
        content,
        finishReason: "finished",
      };
    } catch (error) {
      console.error(`[LM Studio Retry ${attempt + 1}/${maxRetries}]`, error);
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      } else {
        console.error("Max retries reached for prompt:", prompt.slice(0, 100));
        return { content: "Error", finishReason: "error" };
      }
    }
  }

  return { content: "Error", finishReason: "error" };
}

/**
 * Call ChatGPT-compatible API with retry logic
 * Works with OpenAI, LM Studio, Ollama, etc.
 * For LM Studio thinking models, uses native API with reasoning disabled for better performance
 */
export async function chatGPTAuto(options: ChatOptions): Promise<string> {
  // Use native LM Studio API only for known thinking models
  if (isLMStudio(options.baseUrl) && isThinkingModel(options.model)) {
    const result = await chatLMStudioNative(options);
    return result.content;
  }
  
  // Use OpenAI-compatible endpoint for all other cases
  const result = await chatGPTWithFinishReason(options);
  return result.content;
}
