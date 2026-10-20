import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { Message, Tool } from "./prompt.ts";
import { sendJson } from "./http.ts";

type ChatRequest = { messages?: Message[]; tools?: Tool[]; stream?: boolean; model?: string };

/** POST /v1/chat/completions */
export async function handleOpenAI(engine: Engine, body: ChatRequest, res: ServerResponse, defaultModel: string) {
  const tools = (body.tools ?? []).filter((t) => t.type === "function");
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? defaultModel;

  if (!body.stream) {
    const { content, toolCalls } = await engine.complete(body.messages ?? [], tools);
    const message = { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  const chunk = (delta: object, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  chunk({ role: "assistant", content: "" });
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 10_000);
  try {
    const { toolCalls } = await engine.complete(body.messages ?? [], tools, { onText: (t) => chunk({ content: t }) });
    if (toolCalls.length) chunk({ tool_calls: toolCalls.map((c, index) => ({ index, ...c })) });
    chunk({}, toolCalls.length ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  } finally {
    clearInterval(keepalive);
  }
}
