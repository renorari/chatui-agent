import { randomUUID } from "node:crypto";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type Message = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }> | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export function textOf(content: Message["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text ?? "" : `[${p.type} omitted]`))
    .join("\n");
}

/** Identity of a message, used to detect that a request continues a chat already open in a tab. */
export function messageKey(m: Message): string {
  const calls = (m.tool_calls ?? []).map((c) => c.function.name).join(",");
  return `${m.role}|${textOf(m.content).replace(/\s+/g, " ").trim()}|${calls}|${m.tool_call_id ?? ""}`;
}

function toolCallBlock(name: string, args: unknown): string {
  return "```json\n" + JSON.stringify({ tool_call: { name, arguments: args } }) + "\n```";
}

/** Plausible arguments for the first tool, built from its schema, for the few-shot example. */
function exampleArgs(tool: Tool): Record<string, unknown> {
  const props = (tool.function.parameters as { properties?: Record<string, { type?: string }> })?.properties ?? {};
  const required = (tool.function.parameters as { required?: string[] })?.required ?? Object.keys(props).slice(0, 1);
  return Object.fromEntries(
    required.map((k) => [k, props[k]?.type === "integer" || props[k]?.type === "number" ? 1 : /path|file/i.test(k) ? "config.yml" : "..."]),
  );
}

function toolInstructions(tools: Tool[]): string {
  const list = tools
    .map((t) => {
      const f = t.function;
      return `### ${f.name}\n${f.description ?? ""}\nParameters (JSON Schema): ${JSON.stringify(f.parameters ?? {})}`;
    })
    .join("\n\n");
  return [
    "# Tools",
    "You are the reasoning engine of a coding agent. The user's files and shell are on THEIR machine, which you cannot reach directly.",
    "The ONLY way to read files, edit files or run commands there is to call the tools below; the harness executes them and sends back the results.",
    "Never use your own built-in tools (code interpreter / Python sandbox, web search, canvas, pages, artifacts): they run somewhere else and cannot see the user's files.",
    "Never say you cannot access a path: call a tool instead. If the task needs information from the user's machine, your reply must be a tool call.",
    "",
    list,
    "",
    "## How to call a tool",
    "Reply with one or more fenced blocks exactly in this format (one block per call), then stop and wait for the results:",
    toolCallBlock("tool_name", { arg: "value" }),
    "`arguments` must be a JSON object matching the tool's schema. Results come back as TOOL RESULT messages.",
    "When no tool is needed, answer normally in Markdown without such blocks.",
    "",
    "## Example",
    "USER: What does config.yml say?",
    "ASSISTANT:",
    toolCallBlock(tools[0].function.name, exampleArgs(tools[0])),
    "(The harness runs it and replies with `### TOOL RESULT`; then you continue.)",
    "Do not execute code yourself and do not look in /mnt/data or any sandbox: just emit the block.",
  ].join("\n");
}

const TOOL_REMINDER =
  '(Reminder: use only the listed tools, never your built-in sandbox. To call one, reply with ```json {"tool_call": {"name": ..., "arguments": {...}}}``` blocks.)';

function renderMessage(m: Message): string {
  const text = textOf(m.content);
  switch (m.role) {
    case "user":
      return `### USER\n${text}`;
    case "assistant": {
      const calls = (m.tool_calls ?? []).map((c) => toolCallBlock(c.function.name, safeJson(c.function.arguments)));
      return `### ASSISTANT\n${[text, ...calls].filter(Boolean).join("\n\n")}`;
    }
    case "tool":
      return `### TOOL RESULT (${m.name ?? ""} ${m.tool_call_id ?? ""})\n${text}`;
    default:
      return `### SYSTEM\n${text}`;
  }
}

/** Builds the first prompt of a fresh chat from the whole transcript. */
export function buildFullPrompt(messages: Message[], tools: Tool[]): string {
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content));
  const turns = messages.filter((m) => m.role !== "system" && m.role !== "developer");

  // Plain chat with a single question: send it as-is.
  if (system.length === 0 && tools.length === 0 && turns.length === 1 && turns[0].role === "user") {
    return textOf(turns[0].content);
  }

  const parts: string[] = [];
  if (system.length) parts.push("# Instructions\n" + system.join("\n\n"));
  if (tools.length) parts.push(toolInstructions(tools));
  parts.push("# Conversation\n" + turns.map(renderMessage).join("\n\n"));
  parts.push("Reply as ASSISTANT to the last message. Output only the reply itself.");
  return parts.join("\n\n---\n\n");
}

/** Builds a follow-up prompt for a chat that already contains the earlier messages. */
export function buildDeltaPrompt(delta: Message[], tools: Tool[]): string {
  const body =
    delta.length === 1 && delta[0].role === "user" ? textOf(delta[0].content) : delta.map(renderMessage).join("\n\n");
  return tools.length ? `${body}\n\n${TOOL_REMINDER}` : body;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const FENCE = /```[\w-]*\s*\n([\s\S]*?)\n?```/g;

/** Splits a reply into plain text and emulated tool calls. */
export function parseReply(reply: string, tools: Tool[], idPrefix = "call_"): { content: string; toolCalls: ToolCall[] } {
  if (tools.length === 0) return { content: reply, toolCalls: [] };
  const known = new Set(tools.map((t) => t.function.name));
  const toolCalls: ToolCall[] = [];

  const content = reply.replace(FENCE, (block, body: string) => {
    const parsed = safeJson(body.trim()) as { tool_call?: { name?: string; arguments?: unknown } } | null;
    const call = parsed && typeof parsed === "object" ? parsed.tool_call : undefined;
    if (!call?.name || !known.has(call.name)) return block;
    const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    toolCalls.push({ id: idPrefix + randomUUID().replace(/-/g, "").slice(0, 24), type: "function", function: { name: call.name, arguments: args } });
    return "";
  });

  return { content: content.trim(), toolCalls };
}
