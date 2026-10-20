import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const BASE = "http://127.0.0.1:8798/v1";
const post = async (path: string, body: object) => {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
};
const ok = (name: string) => console.log("ok -", name);

// OpenAI: plain
const plain = await post("/chat/completions", { messages: [{ role: "user", content: "hello\nworld" }] });
if (!plain.choices) throw new Error(JSON.stringify(plain));
assert.match(plain.choices[0].message.content, /got 2 lines[\s\S]*```python\nprint\("hi"\)\n```/);
ok("openai plain");

// OpenAI: streaming never emits a half-rendered code block
const sse: string = await post("/chat/completions", { stream: true, messages: [{ role: "user", content: "hi" }] });
const streamed = sse.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "").join("");
assert.equal(streamed, plain.choices[0].message.content.replace("2 lines", "1 lines"));
ok("openai stream");

// OpenAI: emulated tool call, then the tool result continues the same chat
const tools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const msgs: any[] = [{ role: "system", content: "You are an agent" }, { role: "user", content: "open a.txt" }];
const t1 = await post("/chat/completions", { tools, messages: msgs });
assert.equal(t1.choices[0].finish_reason, "tool_calls");
const call = t1.choices[0].message.tool_calls[0];
assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.txt" });
msgs.push(t1.choices[0].message, { role: "tool", tool_call_id: call.id, content: "file body" });
const t2 = await post("/chat/completions", { tools, messages: msgs });
assert.match(t2.choices[0].message.content, /Turn \*\*2\*\*/); // second turn of the same browser chat
ok("openai tool call + continuation");

// Anthropic Messages: tool_use, streaming
const aTools = [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
const a1 = await post("/messages", { model: "x", max_tokens: 100, system: "agent", tools: aTools, messages: [{ role: "user", content: "open a.txt" }] });
assert.equal(a1.stop_reason, "tool_use");
const use = a1.content.find((b: any) => b.type === "tool_use");
assert.ok(use.id.startsWith("toolu_"));
const a2: string = await post("/messages", {
  model: "x", max_tokens: 100, stream: true, system: "agent", tools: aTools,
  messages: [{ role: "user", content: "open a.txt" }, { role: "assistant", content: a1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "body" }] }],
});
const events = a2.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
assert.deepEqual([events[0], events.at(-1)], ["message_start", "message_stop"]);
assert.ok(events.includes("content_block_delta"));
assert.match(a2, /Turn \*\*2\*\*/);
ok("anthropic tool_use + stream");

// ACP: the agent runs read_file locally (client has no fs capability) and finishes the turn
const dir = mkdtempSync(join(tmpdir(), "acp-"));
writeFileSync(join(dir, "a.txt"), "secret-content");
const acp = spawn("node", ["src/acp.ts"], { env: { ...process.env, CHATUI_URL: BASE } });
const lines: any[] = [];
let buf = "";
acp.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    lines.push(JSON.parse(buf.slice(0, i)));
    buf = buf.slice(i + 1);
  }
});
const rpc = (id: number, method: string, params: object) => acp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
const reply = async (id: number) => {
  for (let t = 0; t < 600 && !lines.find((l) => l.id === id); t++) await new Promise((r) => setTimeout(r, 100));
  return lines.find((l) => l.id === id);
};
rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
assert.equal((await reply(1)).result.protocolVersion, 1);
rpc(2, "session/new", { cwd: dir, mcpServers: [] });
const sessionId = (await reply(2)).result.sessionId;
rpc(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "what is in a.txt? use tool_call" }] });
assert.equal((await reply(3)).result.stopReason, "end_turn");
const updates = lines.filter((l) => l.method === "session/update").map((l) => l.params.update);
assert.ok(updates.some((u) => u.sessionUpdate === "tool_call" && u.title.includes("a.txt")));
assert.ok(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
acp.kill();
ok("acp agent loop");
