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

/**
 * Minimal shape of the client used for chat completions.
 * Anything implementing `chat.completions.create` can be injected via
 * `setChatClient()` (useful for tests or custom transports).
 */
export interface ChatClient {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: ChatCompletionMessageParam[];
        temperature?: number;
      }) => Promise<{
        choices: Array<{
          finish_reason?: string | null;
          message: { content: string | null };
        }>;
      }>;
    };
  };
}

let clientOverride: ChatClient | null = null;

/**
 * Override the chat client used by chatGPT/chatGPTWithFinishReason.
 * Pass null to restore the default OpenAI client.
 */
export function setChatClient(client: ChatClient | null): void {
  clientOverride = client;
}

export interface ClientConfig {
  apiKey?: string;
  baseUrl?: string; // For LM Studio: http://localhost:1234/v1
}

let warnedChatgptApiKey = false;

/**
 * Resolve the API key. CHATGPT_API_KEY is accepted as a deprecated alias for
 * OPENAI_API_KEY (upstream PageIndex keeps the same backward compatibility).
 */
export function resolveApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.CHATGPT_API_KEY) {
    if (!warnedChatgptApiKey) {
      warnedChatgptApiKey = true;
      console.warn("CHATGPT_API_KEY is deprecated — set OPENAI_API_KEY instead.");
    }
    return process.env.CHATGPT_API_KEY;
  }
  return undefined;
}

function getClient(config: ClientConfig = {}): ChatClient {
  if (clientOverride) {
    return clientOverride;
  }

  const apiKey = resolveApiKey(config.apiKey) || "lm-studio";
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
 * Misconfiguration: no retry can fix a rejected key or a model that does not
 * exist, and every later call fails the same way.
 */
export const UNRECOVERABLE_STATUS: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * A 400 (e.g. context_length_exceeded) is equally unfixable by retry, but it is
 * per-prompt: it is raised immediately and callers absorb it instead of failing
 * the whole run.
 */
export const NO_RETRY_STATUS: ReadonlySet<number> = new Set([...UNRECOVERABLE_STATUS, 400]);

/**
 * The retry ladder gave up; carries the last error's status code.
 */
export class LLMRetriesExhausted extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LLMRetriesExhausted";
    this.statusCode = statusCode;
  }
}

/** HTTP status carried by an error thrown from an LLM call, if any */
export function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

/**
 * Whether an LLM error must fail the whole run (bad key, missing model, or an
 * exhausted retry ladder not caused by a per-prompt 400).
 */
export function isUnrecoverable(error: unknown): boolean {
  if (error instanceof LLMRetriesExhausted) {
    return error.statusCode !== 400;
  }
  const status = getErrorStatus(error);
  return status !== undefined && UNRECOVERABLE_STATUS.has(status);
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
    temperature,
    maxRetries = 10,
  } = options;

  const client = getClient({ apiKey, baseUrl });

  const messages: ChatCompletionMessageParam[] = chatHistory
    ? [...chatHistory, { role: "user" as const, content: prompt }]
    : [{ role: "user" as const, content: prompt }];

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // temperature is only sent when explicitly requested: newer (reasoning)
      // models reject non-default values, and upstream no longer sends one.
      const response = await client.chat.completions.create({
        model,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
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
      const status = getErrorStatus(error);
      if (status !== undefined && NO_RETRY_STATUS.has(status)) {
        throw error;
      }
      lastError = error;
      console.error(`[Retry ${attempt + 1}/${maxRetries}]`, error);
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1)); // Exponential backoff
      }
    }
  }

  throw new LLMRetriesExhausted(
    `LLM completion failed after ${maxRetries} retries: ${errorMessage(lastError)}`,
    getErrorStatus(lastError),
    { cause: lastError }
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  let lastError: unknown;
  
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
            throw httpError(`LM Studio API error on retry: ${retryResponse.status} - ${retryError}`, retryResponse.status);
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
        
        throw httpError(`LM Studio API error: ${response.status} - ${data.message || JSON.stringify(data)}`, response.status);
      }

      // Extract the message content from the response
      const messageOutput = data.output?.find(o => o.type === "message");
      const content = messageOutput?.content || "";

      return {
        content,
        finishReason: "finished",
      };
    } catch (error) {
      const status = getErrorStatus(error);
      if (status !== undefined && NO_RETRY_STATUS.has(status)) {
        throw error;
      }
      lastError = error;
      console.error(`[LM Studio Retry ${attempt + 1}/${maxRetries}]`, error);
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  throw new LLMRetriesExhausted(
    `LLM completion failed after ${maxRetries} retries: ${errorMessage(lastError)}`,
    getErrorStatus(lastError),
    { cause: lastError }
  );
}

/** Error carrying an HTTP status, so the retry policy can classify it */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
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
