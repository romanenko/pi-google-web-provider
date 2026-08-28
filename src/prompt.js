import { randomUUID } from "node:crypto";
import { parseJsonFragments } from "./adl.js";

const ADAPTER_INSTRUCTIONS = `
You are being used through an experimental coding-agent adapter.
Return exactly one JSON object and no markdown fences.
For a normal response use: {"type":"text","text":"your response"}
To call a tool use: {"type":"tool_call","id":"optional-id","name":"tool-name","arguments":{}}
Call only tools listed below. After a tool result, either call another tool or return a text response.
`.trim();

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return block.text;
      if (block?.type === "image") return `[image:${block.mimeType ?? "unknown"}]`;
      if (block?.type === "thinking") return `[thinking omitted]`;
      if (block?.type === "toolCall") {
        return JSON.stringify({ toolCall: { id: block.id, name: block.name, arguments: block.arguments } });
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageToText(message) {
  if (message.role === "user") return `USER:\n${contentToText(message.content)}`;
  if (message.role === "assistant") return `ASSISTANT:\n${contentToText(message.content)}`;
  if (message.role === "toolResult") {
    return `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${Boolean(message.isError)}):\n${contentToText(message.content)}`;
  }
  return "";
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 18))}\n[text truncated]`;
}

function compactParameter(parameter) {
  if (!parameter || typeof parameter !== "object") return {};
  const result = {};
  if (typeof parameter.type === "string") result.type = parameter.type;
  if (Array.isArray(parameter.enum)) result.enum = parameter.enum.slice(0, 16);
  if (typeof parameter.description === "string") result.description = truncateText(parameter.description, 120);
  if (parameter.items && typeof parameter.items === "object") {
    result.items = {};
    if (typeof parameter.items.type === "string") result.items.type = parameter.items.type;
    if (Array.isArray(parameter.items.enum)) result.items.enum = parameter.items.enum.slice(0, 16);
  }
  if (Array.isArray(parameter.anyOf)) {
    result.anyOf = parameter.anyOf.slice(0, 8).map((option) => compactParameter(option));
  }
  return result;
}

function compactTool(tool) {
  const properties = Object.fromEntries(
    Object.entries(tool.parameters?.properties ?? {}).map(([name, parameter]) => [name, compactParameter(parameter)]),
  );
  const result = {
    name: tool.name,
    description: truncateText(tool.description, 220),
  };
  if (Object.keys(properties).length > 0 || Array.isArray(tool.parameters?.required)) {
    result.parameters = {
      type: "object",
      properties,
      ...(Array.isArray(tool.parameters?.required) ? { required: tool.parameters.required } : {}),
    };
  }
  return result;
}

export function encodedQueryLength(value) {
  return new URLSearchParams({ q: String(value ?? "") }).toString().length - 2;
}

function truncateToEncodedBudget(value, budget, { fromEnd = false, marker = "\n[content truncated]\n" } = {}) {
  const text = String(value ?? "");
  if (encodedQueryLength(text) <= budget) return text;
  if (encodedQueryLength(marker) >= budget) return "";

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = fromEnd ? `${marker}${text.slice(-middle)}` : `${text.slice(0, middle)}${marker}`;
    if (encodedQueryLength(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  return fromEnd ? `${marker}${text.slice(-low)}` : `${text.slice(0, low)}${marker}`;
}

function compactToolsWithinBudget(tools, budget) {
  if (tools.length === 0) return "TOOLS:\n[]";
  const compact = tools.map((tool) => ({ name: tool.name }));
  const render = () => `TOOLS:\n${JSON.stringify(compact)}`;

  for (let index = 0; index < tools.length; index += 1) {
    const previous = compact[index];
    compact[index] = compactTool(tools[index]);
    if (encodedQueryLength(render()) > budget) compact[index] = previous;
  }
  return truncateToEncodedBudget(render(), budget, { marker: "\n[tool list truncated]\n" });
}

function tailWithinBudget(sections, budget) {
  const selected = [];
  let remaining = budget;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section.length <= remaining) {
      selected.unshift(section);
      remaining -= section.length + 2;
    } else if (selected.length === 0 && remaining > 256) {
      selected.unshift(`[earlier content truncated]\n${section.slice(-(remaining - 28))}`);
      break;
    } else {
      break;
    }
  }
  return selected.join("\n\n");
}

export function contextToQuery(context, { maxChars = 12_000, maxEncodedChars = 7_600 } = {}) {
  const encodedBudget = Math.max(2_000, Math.min(maxChars, maxEncodedChars));
  const adapterBudget = Math.min(1_200, Math.floor(encodedBudget * 0.18));
  const systemBudget = Math.min(1_500, Math.floor(encodedBudget * 0.2));
  const toolsBudget = Math.min(2_700, Math.floor(encodedBudget * 0.36));
  const historyBudget = Math.max(600, encodedBudget - adapterBudget - systemBudget - toolsBudget - 80);

  const adapter = truncateToEncodedBudget(ADAPTER_INSTRUCTIONS, adapterBudget);
  const toolsText = compactToolsWithinBudget(context.tools ?? [], toolsBudget);
  const system = context.systemPrompt
    ? truncateToEncodedBudget(`SYSTEM:\n${context.systemPrompt}`, systemBudget)
    : "";
  const messages = context.messages.map(messageToText).filter(Boolean);
  const history = truncateToEncodedBudget(
    tailWithinBudget(messages, Math.max(1_024, maxChars)),
    historyBudget,
    { fromEnd: true, marker: "[earlier conversation truncated]\n" },
  );

  const query = [adapter, system, toolsText, history].filter(Boolean).join("\n\n");
  if (encodedQueryLength(query) > encodedBudget) {
    throw new Error(`Could not fit Pi context into Google's ${encodedBudget}-character encoded query budget`);
  }
  return query;
}

function findEnvelope(text) {
  const direct = parseJsonFragments(text);
  const queue = [...direct];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (value.type === "text" || value.type === "tool_call" || value.type === "toolCall") return value;
      queue.push(...Object.values(value));
    } else if (Array.isArray(value)) {
      queue.push(...value);
    }
  }
  return undefined;
}

export function parseModelEnvelope(text, toolNames = []) {
  const envelope = findEnvelope(text);
  if (!envelope) return { type: "text", text };

  if (envelope.type === "text") {
    return { type: "text", text: String(envelope.text ?? "") };
  }

  const name = String(envelope.name ?? "");
  if (!name) throw new Error("Google returned a tool call without a tool name");
  if (toolNames.length > 0 && !toolNames.includes(name)) {
    throw new Error(`Google requested unknown tool ${name}`);
  }
  const args = envelope.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Google returned invalid arguments for tool ${name}`);
  }
  return {
    type: "tool_call",
    id: String(envelope.id || `google-web-${randomUUID()}`),
    name,
    arguments: args,
  };
}

export { ADAPTER_INSTRUCTIONS };
