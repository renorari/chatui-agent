#!/usr/bin/env node
// ACP (Agent Client Protocol) agent over stdio. The model is the chatui-agent server's
// OpenAI endpoint; tools run through the ACP client (editor) when it supports them.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Message, Tool, ToolCall } from "./prompt.ts";

const API = process.env.CHATUI_URL ?? "http://127.0.0.1:8787/v1";
const AUTO_APPROVE = process.env.ACP_AUTO_APPROVE === "1";
const MAX_STEPS = Number(process.env.ACP_MAX_STEPS ?? 30);
const MAX_RESULT_CHARS = 30_000;

type Session = { cwd: string; messages: Message[]; abort?: AbortController; cancelled: boolean; alwaysAllow: Set<string> };
type ClientCaps = { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean };

const sessions = new Map<string, Session>();
let clientCaps: ClientCaps = {};

// ---------- JSON-RPC plumbing ----------

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(msg: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function request(method: string, params: object): Promise<any> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function update(sessionId: string, update: object): void {
  send({ method: "session/update", params: { sessionId, update } });
}

const log = (msg: string) => console.error(`[chatui-acp] ${msg}`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return log(`bad json: ${line}`);
  }
  if (msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  try {
    const result = await handle(msg.method, msg.params ?? {});
    if (msg.id !== undefined) send({ id: msg.id, result: result ?? null });
  } catch (err) {
    log(`${msg.method} failed: ${(err as Error).stack}`);
    if (msg.id !== undefined) send({ id: msg.id, error: { code: (err as any).code ?? -32603, message: String((err as Error).message) } });
  }
});

// ---------- ACP methods ----------

async function handle(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "initialize":
      clientCaps = params.clientCapabilities ?? {};
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
        authMethods: [],
        agentInfo: { name: "chatui-agent", version: "0.1.0" },
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = randomUUID();
      const cwd = params.cwd ?? process.cwd();
      sessions.set(sessionId, { cwd, messages: [{ role: "system", content: systemPrompt(cwd) }], cancelled: false, alwaysAllow: new Set() });
      return { sessionId };
    }
    case "session/prompt":
      return prompt(params.sessionId, params.prompt ?? []);
    case "session/cancel": {
      const s = sessions.get(params.sessionId);
      if (s) {
        s.cancelled = true;
        s.abort?.abort();
      }
      return;
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

function systemPrompt(cwd: string): string {
  return [
    "You are a coding agent working on the user's project. Working directory: " + cwd,
    "Use the tools to inspect and change files and to run commands (build, test, git, ls, grep...).",
    "Read files before editing them. Prefer edit_file for small changes. Relative paths are resolved from the working directory.",
    "Keep going until the task is done, then reply with a short summary of what you changed.",
  ].join("\n");
}

function promptText(blocks: any[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "resource_link") return `@${b.uri}`;
      if (b.type === "resource") return `<file uri="${b.resource?.uri}">\n${b.resource?.text ?? ""}\n</file>`;
      return `[${b.type} omitted]`;
    })
    .join("\n");
}

async function prompt(sessionId: string, blocks: any[]): Promise<{ stopReason: string }> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown session ${sessionId}`);
  s.cancelled = false;
  s.messages.push({ role: "user", content: promptText(blocks) });

  for (let step = 0; step < MAX_STEPS; step++) {
    s.abort = new AbortController();
    let message: Message;
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "chatui", messages: s.messages, tools: TOOLS }),
        signal: s.abort.signal,
      });
      if (!res.ok) throw new Error(`model server ${res.status}: ${await res.text()}`);
      message = (await res.json()).choices[0].message;
    } catch (err) {
      if (s.cancelled) return { stopReason: "cancelled" };
      throw err;
    }

    s.messages.push(message);
    const text = typeof message.content === "string" ? message.content : "";
    if (text) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    if (!message.tool_calls?.length) return { stopReason: "end_turn" };

    for (const call of message.tool_calls) {
      if (s.cancelled) return { stopReason: "cancelled" };
      const result = await runTool(sessionId, s, call);
      s.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
    if (s.cancelled) return { stopReason: "cancelled" };
  }
  return { stopReason: "max_turn_requests" };
}

// ---------- tools ----------

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Optionally from a 1-based line, for `limit` lines.",
      parameters: { type: "object", properties: { path: { type: "string" }, line: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the full content.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact occurrence of old_string with new_string in a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the working directory and return its output and exit code.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

const KIND: Record<string, string> = { read_file: "read", write_file: "edit", edit_file: "edit", run_command: "execute" };

async function runTool(sessionId: string, s: Session, call: ToolCall): Promise<string> {
  const name = call.function.name;
  const toolCallId = call.id;
  let args: any;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "ERROR: arguments were not valid JSON";
  }
  const path = typeof args.path === "string" ? (isAbsolute(args.path) ? args.path : resolve(s.cwd, args.path)) : undefined;
  const title = name === "run_command" ? `$ ${args.command}` : `${name} ${args.path ?? ""}`;
  const toolCall = { toolCallId, title, kind: KIND[name] ?? "other", rawInput: args, ...(path ? { locations: [{ path }] } : {}) };
  update(sessionId, { sessionUpdate: "tool_call", status: "pending", ...toolCall });

  if (name !== "read_file" && !AUTO_APPROVE && !s.alwaysAllow.has(name)) {
    const res = await request("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    }).catch(() => ({ outcome: { outcome: "cancelled" } }));
    const choice = res?.outcome?.outcome === "selected" ? res.outcome.optionId : "reject";
    if (choice === "always") s.alwaysAllow.add(name);
    if (choice === "reject") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return "ERROR: the user rejected this tool call. Ask what they want instead.";
    }
  }

  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
  try {
    let output: string;
    let content: object[];
    switch (name) {
      case "read_file": {
        output = await readText(sessionId, path!, args.line, args.limit);
        content = [];
        break;
      }
      case "write_file": {
        const old = await readText(sessionId, path!).catch(() => null);
        await writeText(sessionId, path!, args.content);
        output = `wrote ${path}`;
        content = [{ type: "diff", path, oldText: old, newText: args.content }];
        break;
      }
      case "edit_file": {
        const old = await readText(sessionId, path!);
        const count = old.split(args.old_string).length - 1;
        if (count !== 1) throw new Error(`old_string must occur exactly once in ${path}, found ${count}`);
        const next = old.replace(args.old_string, () => args.new_string);
        await writeText(sessionId, path!, next);
        output = `edited ${path}`;
        content = [{ type: "diff", path, oldText: old, newText: next }];
        break;
      }
      case "run_command": {
        const r = await runCommand(sessionId, toolCallId, s.cwd, args.command);
        output = r;
        content = clientCaps.terminal ? [] : [{ type: "content", content: { type: "text", text: "```\n" + r + "\n```" } }];
        break;
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", ...(content.length ? { content } : {}) });
    return output.length > MAX_RESULT_CHARS ? output.slice(0, MAX_RESULT_CHARS) + "\n...[truncated]" : output;
  } catch (err) {
    const message = (err as Error).message;
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: message } }],
    });
    return `ERROR: ${message}`;
  }
}

async function readText(sessionId: string, path: string, line?: number, limit?: number): Promise<string> {
  if (clientCaps.fs?.readTextFile) {
    return (await request("fs/read_text_file", { sessionId, path, ...(line ? { line } : {}), ...(limit ? { limit } : {}) })).content;
  }
  const text = await readFile(path, "utf8");
  if (!line && !limit) return text;
  const start = (line ?? 1) - 1;
  return text.split("\n").slice(start, limit ? start + limit : undefined).join("\n");
}

async function writeText(sessionId: string, path: string, content: string): Promise<void> {
  if (clientCaps.fs?.writeTextFile) {
    await request("fs/write_text_file", { sessionId, path, content });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function runCommand(sessionId: string, toolCallId: string, cwd: string, command: string): Promise<string> {
  if (clientCaps.terminal) {
    const { terminalId } = await request("terminal/create", { sessionId, command: "sh", args: ["-c", command], cwd, outputByteLimit: 200_000 });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "terminal", terminalId }] });
    try {
      await request("terminal/wait_for_exit", { sessionId, terminalId });
      const out = await request("terminal/output", { sessionId, terminalId });
      return `${out.output}\n[exit code: ${out.exitStatus?.exitCode ?? "?"}]`;
    } finally {
      await request("terminal/release", { sessionId, terminalId }).catch(() => {});
    }
  }
  return new Promise((resolveOut) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, shell: "/bin/sh" }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code ?? 1) : 0;
      resolveOut(`${stdout}${stderr}\n[exit code: ${code}]`);
    });
  });
}
