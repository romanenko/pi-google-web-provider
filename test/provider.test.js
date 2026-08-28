import assert from "node:assert/strict";
import test from "node:test";
import { extractAdlText, parseJsonFragments } from "../src/adl.js";
import { buildAiModeAnswerEvaluation, buildAiModeUrl, persistentLaunchArgsFromHelp } from "../src/agent-browser.js";
import { GoogleWebClient } from "../src/client.js";
import { contextToQuery, encodedQueryLength, parseModelEnvelope } from "../src/prompt.js";
import { buildRequestUrl, templateFromFetchSnippet, templateFromHar } from "../src/request-template.js";

const TEMPLATE = {
  url: "https://www.google.com/async/folif?yv=3&q=old&async=_fmt%3Aadl",
  headers: { accept: "*/*" },
};

test("selects persistence flags supported by the installed agent-browser generation", () => {
  assert.deepEqual(
    persistentLaunchArgsFromHelp("google", "--restore [name]\n--restore-save <policy>\n--session <name>"),
    ["--session", "google", "--restore", "--restore-save", "auto"],
  );
  assert.deepEqual(
    persistentLaunchArgsFromHelp("google", "--session-name <name>\n--session <name>"),
    ["--session", "google", "--session-name", "google"],
  );
});

test("replaces only the q parameter in a captured request", () => {
  const url = new URL(buildRequestUrl(TEMPLATE, "new instructions\n\nquestion"));
  assert.equal(url.searchParams.get("q"), "new instructions\n\nquestion");
  assert.equal(url.searchParams.get("yv"), "3");
  assert.equal(url.searchParams.get("async"), "_fmt:adl");
});

test("builds an AI Mode browser URL and a bounded response waiter", () => {
  const url = new URL(buildAiModeUrl("fresh marker & instructions"));
  assert.equal(url.origin + url.pathname, "https://www.google.com/search");
  assert.equal(url.searchParams.get("udm"), "50");
  assert.equal(url.searchParams.get("q"), "fresh marker & instructions");
  assert.match(buildAiModeAnswerEvaluation({ timeoutMs: 12_345 }), /const timeoutMs = 12345/);
  assert.match(buildAiModeAnswerEvaluation(), /data-subtree="aimfl"/);
  assert.throws(() => buildAiModeUrl("&".repeat(5_000)), /query URL is too large/);
});

test("extracts an answer from an XSSI-prefixed ADL-shaped response", () => {
  const body = `)]}'\n[["metadata", {"response": {"text": "PI_PROVIDER_OK"}}]]`;
  assert.equal(extractAdlText(body).text, "PI_PROVIDER_OK");
  assert.equal(parseJsonFragments(body).length, 1);
});

test("extracts a request template from HAR without cookies or browser headers", () => {
  const template = templateFromHar({
    log: {
      entries: [{
        startedDateTime: "2026-08-27T00:00:00.000Z",
        request: {
          url: TEMPLATE.url,
          headers: [
            { name: "Accept", value: "*/*" },
            { name: "Cookie", value: "secret" },
            { name: "Sec-Fetch-Site", value: "same-origin" },
            { name: "Referer", value: "https://www.google.com/" },
          ],
        },
      }],
    },
  });
  assert.deepEqual(template.headers, { accept: "*/*" });
  assert.equal(template.referrer, "https://www.google.com/");
});

test("accepts the newer Google AI Mode folwr endpoint", () => {
  const template = templateFromHar({
    log: {
      entries: [{
        startedDateTime: "2026-08-27T00:00:00.000Z",
        request: {
          url: "https://www.google.com/async/folwr?yv=3&q=marker&async=_fmt%3Aadl",
          headers: [{ name: "Accept", value: "*/*" }],
        },
      }],
    },
  });
  assert.equal(new URL(template.url).pathname, "/async/folwr");
});

test("extracts a template from a Chrome Copy as fetch snippet", () => {
  const template = templateFromFetchSnippet(`fetch("${TEMPLATE.url}", {
    "headers": {"accept": "*/*", "cookie": "secret"},
    "referrer": "https://www.google.com/",
    "method": "GET"
  });`);
  assert.equal(new URL(template.url).pathname, "/async/folif");
  assert.deepEqual(template.headers, { accept: "*/*" });
});

test("serializes Pi context and parses a prompted tool call", () => {
  const query = contextToQuery({
    systemPrompt: "You are a coding assistant.",
    messages: [{ role: "user", content: "Read package.json", timestamp: 1 }],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  });
  assert.match(query, /Read package\.json/);
  assert.match(query, /"name":"read"/);

  const envelope = parseModelEnvelope(
    '{"type":"tool_call","name":"read","arguments":{"path":"package.json"}}',
    ["read"],
  );
  assert.equal(envelope.type, "tool_call");
  assert.equal(envelope.name, "read");
  assert.deepEqual(envelope.arguments, { path: "package.json" });
});

test("bounds large Pi contexts by encoded URL size while preserving the latest user message", () => {
  const query = contextToQuery({
    systemPrompt: "system guidance ".repeat(2_000),
    messages: [
      { role: "user", content: "old context ".repeat(2_000), timestamp: 1 },
      { role: "user", content: "LATEST_MARKER", timestamp: 2 },
    ],
    tools: Array.from({ length: 20 }, (_, index) => ({
      name: `tool_${index}`,
      description: "very long tool description ".repeat(500),
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "long parameter description ".repeat(100) },
        },
      },
    })),
  });

  assert.ok(encodedQueryLength(query) <= 7_600);
  assert.match(query, /LATEST_MARKER/);
  assert.match(query, /"name":"tool_0"/);
  assert.match(query, /Return exactly one JSON object/);
});

test("client transport-to-parser path works without a browser", async () => {
  let receivedQuery;
  const client = new GoogleWebClient({
    template: TEMPLATE,
    transport: async ({ query }) => {
      receivedQuery = query;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: TEMPLATE.url,
        headers: { "content-type": "application/json" },
        body: `)]}'\n{"answer":{"text":"PI_PROVIDER_OK"}}`,
      };
    },
  });
  const response = await client.ask("Respond with exactly PI_PROVIDER_OK");
  assert.equal(receivedQuery, "Respond with exactly PI_PROVIDER_OK");
  assert.equal(response.text, "PI_PROVIDER_OK");
});
