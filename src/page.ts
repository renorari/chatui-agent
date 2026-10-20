import { execFile } from "node:child_process";
import { chromium, type BrowserContext } from "playwright-core";

/** The few things ChatTab needs from a browser tab. All DOM work happens inside `evaluate`. */
export interface PageHandle {
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  /** Runs `fn(arg)` in the page. `fn` must be self-contained; it is sent as source text. */
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>;
}

export interface Backend {
  /** Opens a new tab (or window) dedicated to one chat thread. */
  newPage(url: string): Promise<PageHandle>;
}

export type BackendOptions = { kind: "playwright" | "chrome" | "safari"; profileDir: string; cdpUrl?: string };

export async function openBackend(opts: BackendOptions): Promise<Backend> {
  if (opts.kind === "chrome" || opts.kind === "safari") return new AppleScriptBackend(opts.kind);
  return PlaywrightBackend.open(opts);
}

// ---------- Playwright: a Chrome instance with its own profile (or any browser via CDP) ----------

class PlaywrightBackend implements Backend {
  private readonly context: BrowserContext;
  private firstUnused = true;

  private constructor(context: BrowserContext) {
    this.context = context;
  }

  static async open(opts: BackendOptions): Promise<PlaywrightBackend> {
    if (opts.cdpUrl) {
      const browser = await chromium.connectOverCDP(opts.cdpUrl);
      return new PlaywrightBackend(browser.contexts()[0] ?? (await browser.newContext()));
    }
    const context = await chromium.launchPersistentContext(opts.profileDir, {
      channel: "chrome",
      headless: process.env.HEADLESS === "1",
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    return new PlaywrightBackend(context);
  }

  async newPage(url: string): Promise<PageHandle> {
    const reuse = this.firstUnused ? this.context.pages()[0] : undefined;
    this.firstUnused = false;
    const page = reuse ?? (await this.context.newPage());
    const handle: PageHandle = {
      goto: async (u) => void (await page.goto(u, { waitUntil: "domcontentloaded" })),
      url: async () => page.url(),
      evaluate: (fn, arg) => page.evaluate(fn as any, arg) as any,
    };
    await handle.goto(url);
    return handle;
  }
}

// ---------- AppleScript: the user's everyday Chrome/Safari, already logged in ----------
// Needs "Allow JavaScript from Apple Events" (Chrome: View > Developer, Safari: Develop menu).

function osascript(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.replace(/\n$/, ""));
    });
  });
}

class AppleScriptBackend implements Backend {
  private readonly app: string;
  private readonly isSafari: boolean;

  constructor(kind: "chrome" | "safari") {
    this.isSafari = kind === "safari";
    this.app = this.isSafari ? "Safari" : "Google Chrome";
  }

  /** One window per chat thread, so the user's own tabs are never touched. */
  async newPage(url: string): Promise<PageHandle> {
    const open = this.isSafari
      ? `on run argv
          tell application "Safari"
            make new document with properties {URL:item 1 of argv}
            return id of front window
          end tell
        end run`
      : `on run argv
          tell application "Google Chrome"
            set w to make new window
            set URL of active tab of w to item 1 of argv
            return id of w
          end tell
        end run`;
    const windowId = await osascript(open, [url]);
    const tab = this.isSafari ? `current tab of window id ${windowId}` : `active tab of window id ${windowId}`;
    const run = this.isSafari ? "do JavaScript (item 1 of argv) in" : "execute";
    const runSuffix = this.isSafari ? "" : " javascript (item 1 of argv)";
    const app = this.app;

    return {
      goto: async (u) => void (await osascript(`on run argv\ntell application "${app}" to set URL of ${tab} to item 1 of argv\nend run`, [u])),
      url: () => osascript(`tell application "${app}" to return URL of ${tab}`, []),
      evaluate: async (fn, arg) => {
        // Only the last expression's value comes back (as text), so results travel as JSON.
        const js = `JSON.stringify({ v: (${fn.toString()})(${JSON.stringify(arg)}) })`;
        const out = await osascript(`on run argv\ntell application "${app}" to ${run} ${tab}${runSuffix}\nend run`, [js]);
        if (!out || out === "missing value") throw new Error(`no result from ${app} (page still loading?)`);
        return JSON.parse(out).v;
      },
    };
  }
}
