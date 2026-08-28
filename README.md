# Pi Google Web Provider

An experimental [Pi](https://pi.dev/) provider and CLI that drives Google AI Mode through a persistent `agent-browser` session.

The runtime uses the rendered Google UI: it opens a fresh AI Mode query, waits for the response to finish, and reads the answer from the page. It does not copy cookies into source code and does not depend on replaying Google's private `/async/*` request URLs.

This is a proof of concept, not a stable Google API. Google can change the page, require sign-in, or present bot checks without notice. Use only a browser session you control and follow Google's terms and rate limits.

## What is implemented

- `pi-google-web` CLI with `ask`, `probe`, `doctor`, `capture`, and `template` commands.
- Persistent agent-browser sessions with compatibility for agent-browser 0.26+ and newer releases.
- A Pi provider registered as `google-web/google-ai-mode`.
- Prompt-based Pi tool calls using a strict JSON envelope.
- Abort handling, timeout handling, randomized live probes, and explicit Google bot-check errors.
- Optional HAR and “Copy as fetch” extraction for diagnostics; these templates are not needed at runtime.

The provider does not have true token streaming or provider-reported usage. It emits the completed answer as one Pi text delta and reports zero usage/cost.

## Install and check

Requirements: Node 22.19+, Pi 0.84.2+, and `agent-browser` 0.26+.

```bash
npm install
npm test
node ./bin/pi-google-web.js doctor
```

To create a global `pi-google-web` command for this package:

```bash
npm link
pi-google-web doctor
```

## Validate and use the CLI

Use a headed browser for the initial run so you can complete any Google check:

```bash
pi-google-web probe --headed
pi-google-web ask --headed "Explain this stack trace"
```

The probe generates a new random marker on every run. This ensures the browser produced a fresh answer instead of returning a cached capture.

The default persistent browser session is `pi-google-web`. Override it with `--session` or `PI_GOOGLE_AGENT_BROWSER_SESSION`.

If multiple `agent-browser` installations exist, select one explicitly:

```bash
export PI_GOOGLE_AGENT_BROWSER_BIN="$(command -v agent-browser)"
```

## Use as a Pi provider

Run the extension directly:

```bash
export PI_GOOGLE_AGENT_BROWSER_SESSION="pi-google-web"
export PI_GOOGLE_AGENT_BROWSER_HEADED=1

pi \
  -e ./src/index.js \
  --provider google-web \
  --model google-ai-mode
```

For a persistent Pi installation, run `pi install .` from this directory and then select `google-web/google-ai-mode` in Pi.

Optional environment variables:

- `PI_GOOGLE_AGENT_BROWSER_SESSION`: persistent agent-browser session name.
- `PI_GOOGLE_AGENT_BROWSER_BIN`: explicit agent-browser executable path.
- `PI_GOOGLE_AGENT_BROWSER_HEADED=1`: show the browser window.
- `PI_GOOGLE_WEB_MAX_QUERY_CHARS`: raw serialized Pi-context ceiling; default `12000`.
- `PI_GOOGLE_WEB_MAX_ENCODED_QUERY_CHARS`: encoded Google query ceiling; default `7600` to avoid HTTP 400 responses.

## Optional HAR diagnostics

The original private-endpoint experiment is retained as a diagnostic tool:

```bash
pi-google-web capture --out ./google-ai-capture.har
pi-google-web template \
  --har ./google-ai-capture.har \
  --out ~/.pi/agent/google-web-request.json
```

The extractor recognizes the observed `/async/folif` and `/async/folwr` variants and writes templates with mode `0600`. Captured request tokens can be bound to one response, so a template is not treated as a reusable provider credential.

HAR files and templates can contain live session values. Keep them private and remove old captures when no longer needed.

## Important limitations

- Google may return HTTP 429 or `/sorry/`; complete the check manually in the same headed session, then retry.
- Pi's system prompt, history, and tool schemas are flattened into one Google query and truncated to the configured character limit.
- Tool calls are prompted JSON rather than native Google tool calls, so malformed output can stop a turn.
- Images, reasoning traces, exact token counts, and multipart streaming are not supported.
- Google UI or selector changes may require adapter updates.
