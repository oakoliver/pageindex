/**
 * A scripted stand-in for the chat client, injected with setChatClient():
 * tests run without API keys or network.
 */

import { setChatClient, type ChatClient } from "../../src/openai";
import type { PdfPage } from "../../src/pdf";

export interface Call {
  model: string;
  prompt: string;
}

/** A reply, or a reply with no choices at all (an empty 200) */
export type Reply = string | { choices: [] };
export type Handler = (prompt: string, call: Call) => Reply | Promise<Reply>;

export const calls: Call[] = [];

export function useFakeLLM(handler: Handler): void {
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (params) => {
          const messages = params.messages as Array<{ content: unknown }>;
          const prompt = String(messages[messages.length - 1]?.content ?? "");
          const call: Call = { model: params.model, prompt };
          calls.push(call);
          const reply = await handler(prompt, call);
          if (typeof reply !== "string") return { choices: [] };
          return { choices: [{ finish_reason: "stop", message: { content: reply } }] };
        },
      },
    },
  };
  setChatClient(client);
}

export function resetFakeLLM(): void {
  calls.length = 0;
  setChatClient(null);
}

/** An error as the OpenAI SDK raises it for an HTTP reply: status and headers */
export function httpError(
  status: number,
  headers: Record<string, string> = {}
): Error & { status: number; headers: Headers } {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers: new Headers(headers) });
}

/** Pages with the given text; token counts as the port estimates them, unless given */
export function pagesOf(texts: string[], tokenCount?: number): PdfPage[] {
  return texts.map((text) => ({ text, tokenCount: tokenCount ?? Math.ceil(text.length / 4) }));
}
