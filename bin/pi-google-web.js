#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { agentBrowserExecutable, persistentLaunchArgs, runAgentBrowser } from "../src/agent-browser.js";
import { GoogleWebClient, DEFAULT_TEMPLATE_PATH } from "../src/client.js";
import {
  describeTemplate,
  saveTemplate,
  templateFromFetchSnippet,
  templateFromHar,
} from "../src/request-template.js";

const VALUE_OPTIONS = new Set(["template", "session", "out", "har", "fetch", "timeout"]);
const BOOLEAN_OPTIONS = new Set(["headed", "raw", "help"]);

function usage() {
  return `pi-google-web - experimental Google AI Mode client for Pi

Usage:
  pi-google-web capture --out <capture.har> [--session <name>]
  pi-google-web template --har <capture.har> --out <request.json>
  pi-google-web template --fetch <copy-as-fetch.txt> --out <request.json>
  pi-google-web ask [options] <prompt...>
  pi-google-web probe [options]
  pi-google-web doctor [--template <request.json>]

Options:
  --template <path>  Optional captured-request template for diagnostics
  --session <name>   agent-browser session (default: pi-google-web)
  --headed           Launch agent-browser visibly
  --timeout <ms>     Request timeout (default: 120000)
  --raw              Print the raw Google response body

The request template contains short-lived Google session values. Keep it private.`;
}

function parseArgs(argv) {
  const result = { command: "help", positional: [], options: {} };
  const values = [...argv];
  if (values[0] && !values[0].startsWith("-")) result.command = values.shift();

  while (values.length > 0) {
    const token = values.shift();
    if (!token.startsWith("--")) {
      result.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      result.options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option --${name}`);
    const value = values.shift();
    if (value == null || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
    result.options[name] = value;
  }
  return result;
}

async function readStdin() {
  let value = "";
  for await (const chunk of input) value += chunk;
  return value.trim();
}

function clientOptions(options) {
  return {
    session: options.session || process.env.PI_GOOGLE_AGENT_BROWSER_SESSION || "pi-google-web",
    headed: Boolean(options.headed || process.env.PI_GOOGLE_AGENT_BROWSER_HEADED === "1"),
    timeoutMs: Number.parseInt(options.timeout || "120000", 10),
  };
}

async function capture(options) {
  const session = options.session || process.env.PI_GOOGLE_AGENT_BROWSER_SESSION || "pi-google-web";
  const destination = resolve(options.out || "google-ai-capture.har");
  const launch = await persistentLaunchArgs(session);
  launch.push("--headed", "open", "https://www.google.com/");
  await runAgentBrowser(launch);
  await runAgentBrowser(["--session", session, "network", "har", "start"]);

  const terminal = createInterface({ input, output });
  try {
    output.write(
      "In the opened browser, enter Google AI Mode and submit one short test query. "
      + "Wait for the answer, then return here.\n",
    );
    await terminal.question("Press Enter to finish the capture... ");
  } finally {
    terminal.close();
  }
  await runAgentBrowser(["--session", session, "network", "har", "stop", destination]);
  await chmod(destination, 0o600);
  output.write(`Saved HAR: ${destination}\n`);
  output.write(`Next: pi-google-web template --har ${JSON.stringify(destination)} --out ${JSON.stringify(DEFAULT_TEMPLATE_PATH)}\n`);
}

async function createTemplate(options) {
  const outPath = resolve(options.out || DEFAULT_TEMPLATE_PATH);
  let template;
  if (options.har) {
    template = templateFromHar(JSON.parse(await readFile(resolve(options.har), "utf8")));
  } else if (options.fetch) {
    template = templateFromFetchSnippet(await readFile(resolve(options.fetch), "utf8"));
  } else {
    throw new Error("template requires either --har <file> or --fetch <file>");
  }
  await saveTemplate(outPath, template);
  output.write(`${JSON.stringify({ saved: outPath, ...describeTemplate(template) }, null, 2)}\n`);
}

async function ask(positional, options) {
  const prompt = positional.join(" ").trim() || (!input.isTTY ? await readStdin() : "");
  if (!prompt) throw new Error("ask requires a prompt argument or stdin");
  const client = new GoogleWebClient(clientOptions(options));
  const response = await client.ask(prompt, { raw: Boolean(options.raw) });
  output.write(`${options.raw ? response.body : response.text}\n`);
}

async function probe(options) {
  const marker = `PI_PROVIDER_${randomBytes(6).toString("hex").toUpperCase()}`;
  const client = new GoogleWebClient(clientOptions(options));
  const response = await client.ask(`Respond with exactly ${marker}`);
  if (!response.text.includes(marker)) {
    throw new Error(`Probe failed: expected ${marker}, received ${response.text.slice(0, 300)}`);
  }
  output.write(`${marker}\n`);
}

async function doctor(options) {
  const agentBrowser = await runAgentBrowser(["--version"]);
  let piVersion = "not found";
  try {
    piVersion = (await new Promise((resolvePromise, rejectPromise) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("pi", ["--version"], (error, stdout) => error ? rejectPromise(error) : resolvePromise(stdout.trim()));
      });
    }));
  } catch {
    // Pi is optional for using the standalone CLI.
  }

  const report = {
    agentBrowserExecutable: agentBrowserExecutable(),
    agentBrowser: agentBrowser.stdout.trim() || agentBrowser.stderr.trim(),
    pi: piVersion,
  };
  if (options.template) {
    const template = JSON.parse(await readFile(resolve(options.template), "utf8"));
    report.template = describeTemplate(template);
  }
  output.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === "help") {
    output.write(`${usage()}\n`);
    return;
  }
  if (command === "capture") await capture(options);
  else if (command === "template") await createTemplate(options);
  else if (command === "ask") await ask(positional, options);
  else if (command === "probe") await probe(options);
  else if (command === "doctor") await doctor(options);
  else throw new Error(`Unknown command ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(`pi-google-web: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
