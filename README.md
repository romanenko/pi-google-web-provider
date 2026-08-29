# Pi Google AI Mode Provider

Use Google AI Mode as an experimental model provider for the [Pi coding agent](https://pi.dev/).

This project connects Pi's provider extension interface to Google AI Mode through a persistent local browser session. Pi supplies the system prompt, conversation history, and tool definitions; the adapter compacts them into a browser-safe prompt, submits it through Google AI Mode, reads the rendered response, and converts it back into Pi text or tool-call events.

> **Experimental:** this is browser automation around a consumer web product, not an official Google API or a production-ready inference service.

## Origin

I built the first version as a participant in [Punk Software Hack Night at Imbue](https://docs.google.com/presentation/d/1geFFFoCdy7v1aXJeA_QTM0l12sEqg6rY1HUkd563v9Q/mobilepresent?pli=1&slide=id.g3f88e86679e_0_111), at Imbue's San Francisco office on August 27, 2026.

The original question was simple: **could Google's AI Mode power a real coding agent, even though it is exposed as a web experience rather than a conventional model API?**

Pi was a natural harness for the experiment because its provider extension system makes the model boundary replaceable. The result is a small adapter rather than a fork of the coding agent:

```text
Pi turn
  → compact system/history/tool prompt
  → persistent agent-browser session
  → Google AI Mode web UI
  → rendered answer extraction
  → Pi text or tool-call event
```

The project shares some of the playful reverse-engineering spirit of [Chipotlai Max](https://github.com/cyberpapiii/chipotlai-max): both ask whether a conversational web surface can be repurposed as the model behind a coding agent. The architecture here is different. This repository is a provider extension for Pi, uses a browser session controlled by its owner, does not pool anonymous sessions, and does not expose an OpenAI-compatible proxy.

## How it works

The active runtime follows the rendered UI rather than replaying a captured private endpoint:

1. Pi calls the `google-web/google-ai-mode` provider with its current context.
2. The adapter serializes the system prompt, recent messages, and compact tool schemas into a bounded prompt.
3. `agent-browser` opens Google AI Mode in the persistent `pi-google-web` session.
4. The adapter waits for the answer to finish and extracts the response from the page.
5. A strict JSON response contract maps the result into a Pi text response or prompted tool call.

An earlier version attempted to replay Google's private `/async/folif` and `/async/folwr` requests. Testing showed that captured request tokens could be tied to transient state or a previous answer. HAR extraction remains in the repository as a diagnostic and research artifact, but it is not the provider's runtime transport.

To prevent Google HTTP 400 responses, the adapter compacts large Pi tool schemas and enforces both raw and URL-encoded query budgets. It also detects bot-check pages and asks the user to complete them manually in the same headed browser session.

## What is included

- Pi provider: `google-web/google-ai-mode`
- Standalone `pi-google-web` CLI
- Persistent `agent-browser` session support across older and newer CLI generations
- Prompted text and tool-call response envelopes
- Context and encoded-URL size limits
- Abort, timeout, and subprocess cleanup handling
- Randomized live probes that cannot pass from a cached answer
- Optional private-request HAR/template diagnostics
- Tests for prompt compaction, parsing, transport compatibility, and provider behavior

The provider does not receive token usage from Google and does not provide true token streaming. It emits the completed answer as one Pi delta and reports zero usage and cost.

## Requirements

- Node.js 22.19 or newer
- Pi 0.84.2 or newer
- `agent-browser` 0.26 or newer
- Access to Google AI Mode in your region/browser session

Install `agent-browser` if needed:

```bash
npm install -g agent-browser
agent-browser install
```

## Quick start

```bash
git clone https://github.com/romanenko/pi-google-web-provider.git
cd pi-google-web-provider
npm install
npm test
npm link
```

Check the installation and run a fresh browser-backed probe:

```bash
pi-google-web doctor
pi-google-web probe --headed
```

The first headed run may show a Google sign-in or bot-check page. Complete it manually in that browser, then retry the command. The adapter does not automate or bypass those checks.

## CLI

```bash
pi-google-web ask --headed "Explain why this test is failing"
```

Available commands:

| Command | Purpose |
| --- | --- |
| `ask` | Submit one prompt through Google AI Mode and print the answer |
| `probe` | Send a randomized marker and verify that a fresh answer returns |
| `doctor` | Report Pi, `agent-browser`, and optional template configuration |
| `capture` | Record an interactive HAR for endpoint diagnostics |
| `template` | Extract a sanitized diagnostic request template from HAR or “Copy as fetch” input |

The default browser session is `pi-google-web`. Set `--session <name>` to use another one.

## Use with Pi

Run the extension directly:

```bash
export PI_GOOGLE_AGENT_BROWSER_SESSION="pi-google-web"
export PI_GOOGLE_AGENT_BROWSER_HEADED=1

pi \
  -e ./src/index.js \
  --provider google-web \
  --model google-ai-mode
```

For a persistent Pi installation, run `pi install .` from this directory and select `google-web/google-ai-mode` inside Pi.

### Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `PI_GOOGLE_AGENT_BROWSER_SESSION` | Persistent browser session | `pi-google-web` |
| `PI_GOOGLE_AGENT_BROWSER_BIN` | Explicit `agent-browser` executable | resolved from `PATH` |
| `PI_GOOGLE_AGENT_BROWSER_HEADED` | Set to `1` to show the browser | off |
| `PI_GOOGLE_WEB_MAX_QUERY_CHARS` | Raw serialized Pi-context ceiling | `12000` |
| `PI_GOOGLE_WEB_MAX_ENCODED_QUERY_CHARS` | Encoded Google query ceiling | `7600` |

## Optional HAR diagnostics

The original endpoint exploration is retained for inspection and parser research:

```bash
pi-google-web capture --out ./google-ai-capture.har
pi-google-web template \
  --har ./google-ai-capture.har \
  --out ~/.pi/agent/google-web-request.json
```

The extractor recognizes the observed `/async/folif` and `/async/folwr` variants, removes cookie and browser-only headers, and writes templates with mode `0600`.

HAR files and templates can contain live session values. They are ignored by this repository, should remain private, and should be removed when no longer needed.

## Limitations

- Google can change AI Mode's markup, behavior, availability, or request limits at any time.
- Google may require sign-in or return HTTP 429 and `/sorry/` bot-check pages.
- Pi context must be compacted to fit a web query, so long history, system prompts, and tool descriptions are truncated.
- Tool use is prompted JSON rather than a native Google tool-calling protocol.
- Images, reasoning traces, exact token counts, and multipart streaming are not supported.
- A single persistent browser session is not designed for concurrent high-volume requests.
- The adapter can break without a release from either Pi or Google.

## Research, legal, and responsible-use notice

This repository was created as a research and educational proof of concept. It demonstrates browser automation, provider adaptation, prompt serialization, and the practical limits of using a consumer AI web interface as a coding-agent backend.

- This project is not affiliated with, authorized by, endorsed by, or sponsored by Google, Imbue, or the Pi project.
- Google AI Mode is not presented here as a public or supported API. Automated use may be restricted by Google's terms, policies, product rules, or applicable law. You are responsible for evaluating and complying with them.
- Use only accounts, browser profiles, and sessions you control and are authorized to use.
- Do not use this project to bypass authentication, CAPTCHAs, access controls, quotas, geographic restrictions, or rate limits.
- Do not use it for production workloads, high-volume automation, resale, or activity that shifts unauthorized costs to another party.
- Browser state and diagnostic captures can contain sensitive session data. Keep them local and private.

The software is provided as-is, without guarantees of availability, correctness, legality for a particular use, or fitness for production. If you need a reliable coding model, use an official provider API with documented authorization and billing.

## Acknowledgements

- [Pi](https://pi.dev/) for the provider extension surface and coding-agent harness
- `agent-browser` for local browser automation
- [Imbue](https://imbue.com/) and the Punk Software Hack Night community for the setting and inspiration
- [Chipotlai Max](https://github.com/cyberpapiii/chipotlai-max) for a memorable example of connecting an unconventional conversational backend to a coding agent—and for being candid about the experimental and legal risks

Built under the `#punksoftware` banner in San Francisco.
