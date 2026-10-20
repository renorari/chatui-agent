import type { PageHandle } from "./page.ts";

export type SiteConfig = {
  url: string;
  newChatUrl?: string;
  /** Selector of the prompt input (textarea or contenteditable). */
  input: string;
  /** Send button. When missing or not clickable, Enter is dispatched instead. */
  send?: string;
  /** Visible while a reply is still being generated. */
  stop?: string;
  /** Each assistant message bubble. The newest one is treated as the reply. */
  assistant: string;
  /** Elements removed from the reply before converting it to Markdown. */
  ignore?: string[];
  /** Code blocks that are not plain <pre>: one element per line, with a separate language label. */
  codeBlock?: { selector: string; lines: string; lang?: string };
  /** How text is put into a contenteditable input. Defaults to "paste". */
  inputMethod?: "paste" | "insertText";
};

export type DriverOptions = {
  /** How long the reply must stay unchanged before it counts as finished. */
  stableMs: number;
  timeoutMs: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One browser tab bound to one chat thread on the site. */
export class ChatTab {
  readonly page: PageHandle;
  readonly site: SiteConfig;
  readonly opts: DriverOptions;

  constructor(page: PageHandle, site: SiteConfig, opts: DriverOptions) {
    this.page = page;
    this.site = site;
    this.opts = opts;
  }

  async newChat(): Promise<void> {
    await this.page.goto(this.site.newChatUrl ?? this.site.url);
    await sleep(1000);
    await this.waitForInput();
  }

  /** Waits for the input to appear. Blocks indefinitely so the user can log in by hand. */
  async waitForInput(): Promise<void> {
    const started = Date.now();
    let warned = false;
    while (!(await this.page.evaluate(isVisible, this.site.input).catch(() => false))) {
      if (!warned && Date.now() - started > 15_000) {
        console.error(`[chatui-agent] 入力欄が見つかりません。ブラウザでログインしてください: ${await this.page.url().catch(() => "?")}`);
        warned = true;
      }
      await sleep(500);
    }
  }

  /** Sends a prompt and resolves with the finished reply as Markdown. */
  async ask(prompt: string, onProgress?: (text: string) => void): Promise<string> {
    const { site, page } = this;
    await this.waitForInput();
    // Replies already on screen are marked so the new one can be told apart even in virtualized lists.
    await page.evaluate(markSeen, site.assistant);
    await page.evaluate(typePrompt, { selector: site.input, text: prompt, method: site.inputMethod ?? "paste" });
    await this.submit();

    const deadline = Date.now() + this.opts.timeoutMs;
    const read = { assistant: site.assistant, ignore: site.ignore ?? [], codeBlock: site.codeBlock };
    let text: string | null = null;
    let changedAt = Date.now();
    while (true) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the reply");
      await sleep(300);
      const next = await page.evaluate(readReply, read).catch((err) => {
        console.error(`[chatui-agent] reading the reply failed: ${err.message}`);
        return text;
      });
      if (next === null) continue; // not started yet
      if (next !== text) {
        text = next;
        changedAt = Date.now();
        onProgress?.(text);
        continue;
      }
      const generating = site.stop ? await page.evaluate(isVisible, site.stop).catch(() => false) : false;
      if (!generating && text.length > 0 && Date.now() - changedAt >= this.opts.stableMs) return text;
    }
  }

  private async submit(): Promise<void> {
    const { page, site } = this;
    const deadline = Date.now() + 10_000;
    while (site.send && Date.now() < deadline) {
      if (await page.evaluate(clickIfReady, site.send)) return;
      await sleep(200);
    }
    await page.evaluate(pressEnter, site.input);
  }
}

// ---------- functions below run inside the page; they must not reference anything outside ----------

function isVisible(selector: string): boolean {
  return Array.from(document.querySelectorAll(selector)).some((e) => (e as HTMLElement).getClientRects().length > 0);
}

function markSeen(selector: string): void {
  document.querySelectorAll(selector).forEach((e) => e.setAttribute("data-chatui-seen", ""));
}

function typePrompt(a: { selector: string; text: string; method: string }): void {
  const el = document.querySelector(a.selector) as HTMLElement;
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    // Use the native setter so React-controlled inputs notice the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, a.text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (a.method === "insertText") {
    document.execCommand("insertText", false, a.text);
  } else {
    // A synthetic paste keeps newlines intact in ProseMirror/Lexical/Quill editors.
    const data = new DataTransfer();
    data.setData("text/plain", a.text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }
}

function clickIfReady(selector: string): boolean {
  const btn = Array.from(document.querySelectorAll(selector)).find(
    (e) => (e as HTMLElement).getClientRects().length > 0,
  ) as HTMLButtonElement | undefined;
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
  btn.click();
  return true;
}

function pressEnter(selector: string): void {
  const el = document.querySelector(selector) as HTMLElement;
  el.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
}

/** Converts the newest unseen reply back into Markdown, keeping code blocks verbatim. null = no reply yet. */
function readReply(a: { assistant: string; ignore: string[]; codeBlock?: SiteConfig["codeBlock"] }): string | null {
  const fresh = document.querySelectorAll(`:is(${a.assistant}):not([data-chatui-seen])`);
  if (fresh.length === 0) return null;
  const el = fresh[fresh.length - 1].cloneNode(true) as Element;

  // Code blocks are read before stripping, since their header/copy buttons live inside them.
  const fence = (lang: string, body: string) => {
    const f = document.createElement("x-fence");
    f.textContent = "```" + lang + "\n" + body.replace(/\n$/, "") + "\n```";
    return f;
  };
  if (a.codeBlock) {
    for (const block of Array.from(el.querySelectorAll(a.codeBlock.selector))) {
      const lang = (a.codeBlock.lang ? block.querySelector(a.codeBlock.lang)?.textContent ?? "" : "").trim().toLowerCase();
      // Some editors interleave empty spacer rows; keep only rows shaped like the ones holding text.
      const rows = Array.from(block.querySelectorAll(a.codeBlock.lines));
      const lineClass = rows.find((r) => r.textContent)?.className;
      const lines = rows
        .filter((r) => lineClass === undefined || r.className === lineClass)
        .map((l) => (l.textContent ?? "").replace(/^\n|\n$/g, ""));
      block.replaceWith(fence(lang, lines.join("\n")));
    }
  }
  for (const pre of Array.from(el.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = /language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
    pre.replaceWith(fence(lang, (code ?? pre).textContent ?? ""));
  }
  for (const sel of a.ignore) el.querySelectorAll(sel).forEach((n) => n.remove());

  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? "";
    if (n.nodeType !== Node.ELEMENT_NODE) return "";
    const e = n as Element;
    const tag = e.tagName.toLowerCase();
    const kids = () => Array.from(e.childNodes).map(walk).join("");
    switch (tag) {
      case "x-fence":
        return "\n\n" + e.textContent + "\n\n";
      case "script":
      case "style":
      case "svg":
        return "";
      case "br":
        return "\n";
      case "p":
        return "\n\n" + kids() + "\n\n";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "\n\n" + "#".repeat(Number(tag[1])) + " " + kids().trim() + "\n\n";
      case "strong":
      case "b":
        return "**" + kids() + "**";
      case "em":
      case "i":
        return "*" + kids() + "*";
      case "code":
        return "`" + e.textContent + "`";
      case "a":
        return `[${kids()}](${e.getAttribute("href") ?? ""})`;
      case "ul":
      case "ol":
        return "\n\n" + kids() + "\n\n";
      case "li": {
        const parent = e.parentElement;
        const marker =
          parent?.tagName.toLowerCase() === "ol" ? `${Array.from(parent.children).indexOf(e) + 1}. ` : "- ";
        return marker + kids().trim().replace(/\n/g, "\n   ") + "\n";
      }
      case "blockquote":
        return "\n\n" + kids().trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      case "hr":
        return "\n\n---\n\n";
      case "table": {
        const rows = Array.from(e.querySelectorAll("tr")).map(
          (tr) => "| " + Array.from(tr.children).map((c) => walk(c).trim().replace(/\|/g, "\\|")).join(" | ") + " |",
        );
        if (rows.length === 0) return "";
        const cols = e.querySelector("tr")?.children.length ?? 1;
        rows.splice(1, 0, "|" + " --- |".repeat(cols));
        return "\n\n" + rows.join("\n") + "\n\n";
      }
      default:
        return kids();
    }
  };
  return walk(el).replace(/\n{3,}/g, "\n\n").trim();
}
