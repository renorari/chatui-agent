import { ChatTab, type DriverOptions, type SiteConfig } from "./browser.ts";
import type { Backend } from "./page.ts";
import { buildDeltaPrompt, buildFullPrompt, messageKey, parseReply, type Message, type Tool, type ToolCall } from "./prompt.ts";

/** A tab plus the messages its chat thread already contains. */
type Session = { tab: ChatTab; history: string[]; busy: boolean; lastUsed: number };

export type Completion = { content: string; toolCalls: ToolCall[] };

export type CompleteOptions = {
  /** Receives reply text as it arrives. With tools, the text arrives in one piece at the end. */
  onText?: (delta: string) => void;
  idPrefix?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(msg: string): void {
  // stderr, so the ACP agent's stdout stays pure JSON-RPC when sharing this module.
  console.error(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/** Text that is safe to stream: complete lines, never inside a code block that may still be growing. */
function stablePrefix(text: string): string {
  let end = text.lastIndexOf("\n") + 1;
  const fences = [...text.matchAll(/^```.*$/gm)];
  if (fences.length % 2 === 1) {
    // Unclosed block: hold back from its opening fence.
    end = Math.min(end, fences.at(-1)!.index);
  } else if (fences.length > 0) {
    // The reply ends with a block that may still be growing; hold it back too.
    const close = fences.at(-1)!;
    if (text.slice(close.index + close[0].length).trim() === "") end = Math.min(end, fences.at(-2)!.index);
  }
  return text.slice(0, end);
}

export class Engine {
  private readonly sessions: Session[] = [];
  private readonly backend: Backend;
  private readonly site: SiteConfig;
  private readonly opts: DriverOptions;
  private readonly maxTabs: number;

  private constructor(backend: Backend, site: SiteConfig, opts: DriverOptions, maxTabs: number) {
    this.backend = backend;
    this.site = site;
    this.opts = opts;
    this.maxTabs = maxTabs;
  }

  static async create(backend: Backend, site: SiteConfig, opts: DriverOptions, maxTabs: number): Promise<Engine> {
    const engine = new Engine(backend, site, opts, maxTabs);
    const tab = await engine.openTab();
    await tab.waitForInput();
    engine.sessions.push({ tab, history: [], busy: false, lastUsed: 1 });
    return engine;
  }

  private async openTab(): Promise<ChatTab> {
    return new ChatTab(await this.backend.newPage(this.site.newChatUrl ?? this.site.url), this.site, this.opts);
  }

  get tabCount(): number {
    return this.sessions.length;
  }

  /** Picks a tab whose chat is a prefix of `keys` (continue it), or a free tab for a new chat. */
  private async acquire(keys: string[]): Promise<{ session: Session; resumeAt: number }> {
    while (true) {
      const free = this.sessions.filter((s) => !s.busy);
      const cont = free.find(
        (s) => s.history.length > 0 && s.history.length < keys.length && s.history.every((k, i) => k === keys[i]),
      );
      if (cont) {
        cont.busy = true;
        return { session: cont, resumeAt: cont.history.length };
      }

      let fresh: Session | undefined;
      if (free.length > 0) {
        fresh = free.sort((a, b) => a.lastUsed - b.lastUsed)[0];
        fresh.busy = true;
      } else if (this.sessions.length < this.maxTabs) {
        fresh = { tab: undefined as unknown as ChatTab, history: [], busy: true, lastUsed: 0 };
        this.sessions.push(fresh);
        fresh.tab = await this.openTab();
        fresh.lastUsed = 1; // just opened on a new chat
      }
      if (fresh) {
        if (fresh.history.length > 0 || fresh.lastUsed === 0) await fresh.tab.newChat();
        fresh.history = [];
        return { session: fresh, resumeAt: 0 };
      }
      await sleep(200);
    }
  }

  async complete(messages: Message[], tools: Tool[], opts: CompleteOptions = {}): Promise<Completion> {
    const keys = messages.map(messageKey);
    const { session, resumeAt } = await this.acquire(keys);
    const prompt = resumeAt > 0 ? buildDeltaPrompt(messages.slice(resumeAt), tools) : buildFullPrompt(messages, tools);
    const tabNo = this.sessions.indexOf(session);
    log(`→ tab#${tabNo} ${resumeAt > 0 ? `continue (+${messages.length - resumeAt} msgs)` : "new chat"}, ${prompt.length} chars`);

    let sent = "";
    const emit = (text: string) => {
      if (text.length > sent.length && text.startsWith(sent)) {
        opts.onText?.(text.slice(sent.length));
        sent = text;
      }
    };
    // With tools the whole reply is needed to tell tool calls from text, so nothing streams early.
    const onProgress = opts.onText && tools.length === 0 ? (text: string) => emit(stablePrefix(text)) : undefined;

    let reply: string;
    try {
      reply = await session.tab.ask(prompt, onProgress);
      session.history = keys;
    } catch (err) {
      session.history = [];
      throw err;
    } finally {
      session.busy = false;
      session.lastUsed = Date.now();
    }

    const result = parseReply(reply, tools, opts.idPrefix);
    if (!result.content.startsWith(sent)) log("warning: reply changed after streaming; streamed text may differ");
    emit(result.content);
    session.history.push(messageKey({ role: "assistant", content: result.content, tool_calls: result.toolCalls }));
    log(`← tab#${tabNo} ${reply.length} chars${result.toolCalls.length ? `, tools: ${result.toolCalls.map((c) => c.function.name).join(", ")}` : ""}`);
    return result;
  }
}
