import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { Message, Tool } from "./prompt.ts";
import { sendJson } from "./http.ts";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | Block[]; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type MessagesRequest = {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Array<{ role: "user" | "assistant"; content: string | Block[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown; type?: string }>;
  stream?: boolean;
};

function blocksText(content: string | Block[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? (b as { text: string }).text : `[${b.type} omitted]`)).join("\n");
}

/** Converts an Anthropic Messages request into the OpenAI-style messages the engine works with. */
export function toInternal(body: MessagesRequest): { messages: Message[]; tools: Tool[] } {
  const messages: Message[] = [];
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
  if (system) messages.push({ role: "system", content: system });

  const toolNames = new Map<string, string>();
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const calls = m.content
        .filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => {
          toolNames.set(b.id, b.name);
          return { id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } };
        });
      messages.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const r = b as Extract<Block, { type: "tool_result" }>;
        const text = blocksText(r.content);
        messages.push({ role: "tool", tool_call_id: r.tool_use_id, name: toolNames.get(r.tool_use_id), content: r.is_error ? `ERROR: ${text}` : text });
      }
    }
    const rest = m.content.filter((b) => b.type !== "tool_result");
    if (rest.length) messages.push({ role: "user", content: blocksText(rest) });
  }

  // Server tools (web_search etc.) carry a `type` and no schema; only client tools can be emulated.
  const tools: Tool[] = (body.tools ?? [])
    .filter((t) => t.input_schema)
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return { messages, tools };
}

/** POST /v1/messages */
export async function handleAnthropic(engine: Engine, body: MessagesRequest, res: ServerResponse, defaultModel: string) {
  const { messages, tools } = toInternal(body);
  const id = "msg_" + randomUUID().replace(/-/g, "");
  const model = body.model ?? defaultModel;
  const usage = { input_tokens: 0, output_tokens: 0 };

  if (!body.stream) {
    const { content, toolCalls } = await engine.complete(messages, tools, { idPrefix: "toolu_" });
    const blocks: object[] = content ? [{ type: "text", text: content }] : [];
    for (const c of toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") });
    return sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: blocks,
      stop_reason: toolCalls.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    });
  }

  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  event("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  const keepalive = setInterval(() => event("ping", {}), 10_000);

  let index = 0;
  let textOpen = false;
  try {
    const { toolCalls } = await engine.complete(messages, tools, {
      idPrefix: "toolu_",
      onText: (text) => {
        if (!textOpen) {
          event("content_block_start", { index, content_block: { type: "text", text: "" } });
          textOpen = true;
        }
        event("content_block_delta", { index, delta: { type: "text_delta", text } });
      },
    });
    if (textOpen) event("content_block_stop", { index: index++ });
    for (const c of toolCalls) {
      event("content_block_start", { index, content_block: { type: "tool_use", id: c.id, name: c.function.name, input: {} } });
      event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c.function.arguments } });
      event("content_block_stop", { index: index++ });
    }
    event("message_delta", { delta: { stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
    event("message_stop", {});
    res.end();
  } finally {
    clearInterval(keepalive);
  }
}

/** POST /v1/messages/count_tokens — a rough estimate; the web UI exposes no tokenizer. */
export function countTokens(body: MessagesRequest, res: ServerResponse) {
  const { messages, tools } = toInternal(body);
  const chars = JSON.stringify(messages).length + JSON.stringify(tools).length;
  sendJson(res, 200, { input_tokens: Math.ceil(chars / 4) });
}
