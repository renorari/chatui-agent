# chatui-agent

Turns a browser AI chat (ChatGPT, Claude.ai, Gemini, Microsoft 365 Copilot, and others) into the backend for a coding agent in VS Code, Xcode, Zed, and similar tools.

It types prompts into the chat UI, reads the replies from the DOM, and serves them through these APIs:

| Output format | Endpoint / entry point | Main clients |
| --- | --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` (streaming, tools) | Xcode (Locally Hosted), Continue, Cline, Roo Code, Copilot BYOK |
| Anthropic Messages | `POST /v1/messages` (streaming, tool_use) | Claude Code (`ANTHROPIC_BASE_URL`), Anthropic SDK |
| Ollama (minimal) | `GET /api/tags`, `POST /api/show` | VS Code Copilot's Ollama provider |
| ACP (Agent Client Protocol) | `node src/acp.ts` (stdio) | Zed, other ACP clients |

```
 VS Code / Xcode / Zed
        │  OpenAI / Anthropic / ACP
        ▼
 chatui-agent server ──(Playwright or AppleScript)──▶ Browser chat UI (logged in)
```

## How it works

- **Function calling emulation**: when a request includes `tools`, the tool definitions are added to the prompt, and the model is told to reply with a block like ` ```json {"tool_call": {...}} ``` `. The server parses that block back into `tool_calls` / `tool_use`.
- **Conversation reuse**: if a new request starts with the history of a chat already open in a tab, only the new messages are sent to that chat. Long agent loops therefore don't resend the whole conversation each time.
- **Markdown recovery**: the rendered reply DOM is converted back to Markdown, with code blocks kept verbatim.
- **Two browser backends**
  - `BROWSER=chrome` / `BROWSER=safari`: drives your everyday, already logged-in Chrome or Safari through AppleScript. Each chat gets its own window, so your own tabs are left alone.
  - `BROWSER=playwright` (default): starts Chrome with a dedicated profile (`./profile`). Log in once when it opens. `CDP_URL` lets it attach to an existing browser instead.

## Setup

Requirements: macOS (for the AppleScript backends), Node.js 23.6 or later (runs `.ts` files directly), Google Chrome.

```sh
git clone https://github.com/renorari/chatui-agent && cd chatui-agent
npm install
```

To use the AppleScript backends, turn on "Allow JavaScript from Apple Events":
- Chrome: menu bar → View → Developer → Allow JavaScript from Apple Events
- Safari: Settings → Advanced → Show features for web developers, then Develop menu → Allow JavaScript from Apple Events

## Starting the server

```sh
# M365 Copilot in your logged-in Chrome
BROWSER=chrome SITE=copilot npm start

# ChatGPT in a dedicated Chrome profile (log in once in the window that opens)
SITE=chatgpt npm start
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `SITE` | `chatgpt` | A key in `sites.json` (`chatgpt` / `claude` / `gemini` / `copilot`) |
| `BROWSER` | `playwright` | `playwright` / `chrome` / `safari` |
| `PORT` | `8787` | Listening port (127.0.0.1 only) |
| `MAX_TABS` | `2` | Number of chats used in parallel. Side requests such as title generation can use a separate tab. |
| `STABLE_MS` | `1500` | How long the reply must stay unchanged before it counts as finished |
| `TIMEOUT_MS` | `600000` | Timeout for one reply |
| `PROFILE_DIR` / `CDP_URL` | | For the Playwright backend |
| `SITES_FILE` | `sites.json` | Site definition file |

## Client configuration

### Xcode (26 and later)
Settings → Intelligence → Add a Model Provider → **Locally Hosted**, port `8787`. Pick `chatui-<site>` as the model.

### VS Code
- **Continue / Cline / Roo Code**: provider "OpenAI Compatible", Base URL `http://127.0.0.1:8787/v1`, any API key, model `chatui-copilot` and so on.
- **GitHub Copilot Chat**: Manage Models → Ollama, URL `http://127.0.0.1:8787`.

### Claude Code
```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=dummy claude
```
Claude Code's system prompt and tool definitions are very large, so this may hit the input length limit of some chat UIs.

### Zed (ACP)
Add this to `settings.json`:
```json
{
  "agent_servers": {
    "chatui-agent": {
      "command": "node",
      "args": ["/path/to/chatui-agent/src/acp.ts"],
      "env": { "CHATUI_URL": "http://127.0.0.1:8787/v1" }
    }
  }
}
```
The ACP agent runs its own agent loop with four tools: `read_file`, `write_file`, `edit_file`, `run_command`. When the client supports `fs/*` and `terminal/*`, it goes through them; otherwise it runs them locally. Writes and command runs ask the client for permission (`ACP_AUTO_APPROVE=1` skips that).

## Adding a site

Add CSS selectors to `sites.json`:

```jsonc
"mysite": {
  "url": "https://example.com/chat",
  "input": "textarea",                 // input field (textarea or contenteditable)
  "send": "button[type=submit]",       // send button (if omitted, Enter is used)
  "stop": "button[aria-label*=Stop]",  // visible while generating
  "assistant": ".assistant-message",   // assistant message (newest one is used)
  "ignore": ["button"],                // elements removed before converting to Markdown
  "codeBlock": {                       // only for code blocks that are not <pre>
    "selector": ".code-block", "lines": ".line", "lang": ".lang-label"
  }
}
```

Every site changes its UI often, so expect to update the selectors when something breaks.

## Tests

```sh
npm test   # E2E against a local mock chat page in headless Chrome (OpenAI / Anthropic / ACP)
```

## Known limitations and caveats

- Token counts (`usage`) are always 0, and `count_tokens` is a character-based estimate.
- Images and attachments are not supported (they are replaced with a placeholder).
- Long code blocks can be virtualized (only the visible part is rendered), and in that case they may come back incomplete.
- Automating a chat service can violate its terms of use. Check each service's terms, and your organization's policy for M365 Copilot.
- Do not connect this to other companies' customer-support chatbots. They exist to answer questions about that company's products, and routing a coding agent through them is unauthorized use outside their purpose. It also directly costs them money on inference.
