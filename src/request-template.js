import { chmod, readFile, writeFile } from "node:fs/promises";

const GOOGLE_HOSTS = new Set(["google.com", "www.google.com"]);
const GOOGLE_AI_ENDPOINTS = new Set(["/async/folif", "/async/folwr"]);
const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function assertEndpoint(url) {
  if (!GOOGLE_HOSTS.has(url.hostname) || !GOOGLE_AI_ENDPOINTS.has(url.pathname)) {
    throw new Error(`Expected a Google AI Mode endpoint, received ${url.origin}${url.pathname}`);
  }
}

export function sanitizeHeaders(headers = {}) {
  const result = {};
  const entries = Array.isArray(headers)
    ? headers.map((header) => [header.name, header.value])
    : Object.entries(headers);

  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (!name || FORBIDDEN_HEADER_NAMES.has(name) || name.startsWith("sec-") || name.startsWith("x-browser-")) {
      continue;
    }
    if (rawValue == null) continue;
    result[name] = String(rawValue);
  }
  return result;
}

export function normalizeTemplate(value) {
  if (!value || typeof value !== "object") throw new Error("Request template must be an object");
  const url = new URL(String(value.url));
  assertEndpoint(url);
  if (!url.searchParams.has("q")) throw new Error("Request template URL must contain the q parameter");

  return {
    version: 1,
    url: url.toString(),
    method: "GET",
    headers: sanitizeHeaders(value.headers),
    referrer: value.referrer ? String(value.referrer) : "https://www.google.com/",
    capturedAt: value.capturedAt ?? new Date().toISOString(),
  };
}

export function templateFromHar(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Invalid HAR: log.entries is missing");

  const entry = [...entries]
    .reverse()
    .find((candidate) => {
      try {
        const url = new URL(candidate?.request?.url);
        return GOOGLE_HOSTS.has(url.hostname)
          && GOOGLE_AI_ENDPOINTS.has(url.pathname)
          && url.searchParams.has("q");
      } catch {
        return false;
      }
    });

  if (!entry) throw new Error("No supported Google AI Mode request with a q parameter was found in the HAR");
  const referrer = entry.request.headers?.find((header) => header.name.toLowerCase() === "referer")?.value;

  return normalizeTemplate({
    url: entry.request.url,
    headers: entry.request.headers,
    referrer,
    capturedAt: entry.startedDateTime,
  });
}

function readQuotedString(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") throw new Error("Expected a quoted fetch URL");
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      const literal = source.slice(start, index + 1);
      if (quote === '"') return { value: JSON.parse(literal), end: index + 1 };
      const inner = literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      return { value: inner, end: index + 1 };
    }
  }
  throw new Error("Unterminated fetch URL string");
}

function readJsonObjectAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return {};
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return {};

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }
  throw new Error(`Unterminated JSON object after ${marker}`);
}

function unwrapMarkdownLink(value) {
  const markdown = value.match(/^\[[^\]]*\]\((https?:\/\/.*)\)$/s);
  return (markdown?.[1] ?? value).replace(/\\&/g, "&");
}

export function templateFromFetchSnippet(source) {
  const fetchIndex = source.indexOf("fetch(");
  if (fetchIndex < 0) throw new Error("No fetch(...) call was found");
  let cursor = fetchIndex + "fetch(".length;
  while (/\s/.test(source[cursor])) cursor += 1;
  const { value: rawUrl } = readQuotedString(source, cursor);
  const headers = readJsonObjectAfter(source, '"headers"');
  const referrerMatch = source.match(/"referrer"\s*:\s*("(?:\\.|[^"\\])*")/);
  const referrer = referrerMatch ? JSON.parse(referrerMatch[1]) : undefined;
  return normalizeTemplate({ url: unwrapMarkdownLink(rawUrl), headers, referrer });
}

export function buildRequestUrl(template, query) {
  const normalized = normalizeTemplate(template);
  const url = new URL(normalized.url);
  url.searchParams.set("q", query);
  return url.toString();
}

export async function loadTemplate(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return normalizeTemplate(parsed);
}

export async function saveTemplate(path, template) {
  await writeFile(path, `${JSON.stringify(normalizeTemplate(template), null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function describeTemplate(template) {
  const normalized = normalizeTemplate(template);
  const url = new URL(normalized.url);
  return {
    endpoint: `${url.origin}${url.pathname}`,
    queryParameters: [...url.searchParams.keys()],
    headerNames: Object.keys(normalized.headers),
    capturedAt: normalized.capturedAt,
  };
}
