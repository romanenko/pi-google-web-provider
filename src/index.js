import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { GoogleWebClient } from "./client.js";
import { contextToQuery, parseModelEnvelope } from "./prompt.js";

const PROVIDER_ID = "google-web";
const API_ID = "google-web-browser";
const MODEL_ID = "google-ai-mode";

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function initialMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

export function streamGoogleWeb(model, context, options = {}) {
  const stream = createAssistantMessageEventStream();
  const output = initialMessage(model);

  (async () => {
    stream.push({ type: "start", partial: output });
    try {
      let payload = {
        query: contextToQuery(context, {
          maxChars: Number.parseInt(process.env.PI_GOOGLE_WEB_MAX_QUERY_CHARS || "12000", 10),
          maxEncodedChars: Number.parseInt(process.env.PI_GOOGLE_WEB_MAX_ENCODED_QUERY_CHARS || "7600", 10),
        }),
      };
      const replacement = await options.onPayload?.(payload, model);
      if (replacement !== undefined) payload = replacement;
      if (!payload || typeof payload !== "object" || typeof payload.query !== "string") {
        throw new Error("onPayload must preserve a string query field for google-web");
      }

      const client = new GoogleWebClient({
        session: process.env.PI_GOOGLE_AGENT_BROWSER_SESSION,
        headed: process.env.PI_GOOGLE_AGENT_BROWSER_HEADED === "1",
        timeoutMs: options.timeoutMs,
      });
      const response = await client.ask(payload.query, { signal: options.signal });
      await options.onResponse?.({ status: response.status, headers: response.headers ?? {} }, model);

      const toolNames = (context.tools ?? []).map((tool) => tool.name);
      const envelope = parseModelEnvelope(response.text, toolNames);
      if (envelope.type === "tool_call") {
        const toolCall = {
          type: "toolCall",
          id: envelope.id,
          name: envelope.name,
          arguments: envelope.arguments,
        };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(envelope.arguments),
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        output.stopReason = "toolUse";
      } else {
        const block = { type: "text", text: "" };
        output.content.push(block);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        block.text = envelope.text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: envelope.text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: envelope.text, partial: output });
        output.stopReason = "stop";
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function registerGoogleWebProvider(pi) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Google Web (experimental)",
    baseUrl: "https://www.google.com",
    apiKey: "agent-browser-session",
    api: API_ID,
    models: [
      {
        id: MODEL_ID,
        name: "Google AI Mode (web, experimental)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 8_192,
      },
    ],
    streamSimple: streamGoogleWeb,
  });
}

export { API_ID, MODEL_ID, PROVIDER_ID };
