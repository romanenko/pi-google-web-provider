const XSSI_PREFIX = /^\s*\)\]\}'(?:\r?\n)?/;

export function stripXssiPrefix(value) {
  return String(value ?? "").replace(XSSI_PREFIX, "").trim();
}

function decodeHtml(value) {
  const entities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return entities[entity.toLowerCase()] ?? _;
  });
}

function htmlToText(value) {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function parseJsonFragments(source) {
  const text = stripXssiPrefix(source);
  const results = [];
  const seen = new Set();

  const add = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      const key = JSON.stringify(value);
      if (!seen.has(key)) {
        seen.add(key);
        results.push(value);
      }
    } catch {
      // Not a complete JSON value.
    }
  };

  add(text);
  for (const line of text.split(/\r?\n/)) add(line.trim());

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        add(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}

function collectStrings(value, path, output, depth = 0) {
  if (depth > 16 || value == null) return;
  if (typeof value === "string") {
    output.push({ value, path });
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 1_000_000) {
      try {
        collectStrings(JSON.parse(trimmed), `${path}.$json`, output, depth + 1);
      } catch {
        // Nested value is not JSON.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, output, depth + 1));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, path ? `${path}.${key}` : key, output, depth + 1);
    }
  }
}

function candidateScore(candidate) {
  const { text, path, original } = candidate;
  if (!text || text.length < 2) return -Infinity;
  if (/^https?:\/\/\S+$/i.test(text)) return -500;
  if (/^[A-Za-z0-9_=-]{80,}$/.test(text)) return -500;
  if (/\.(?:css|js|png|jpg|svg|woff2?)(?:\?|$)/i.test(text)) return -300;

  let score = Math.min(text.length, 4_000) / 20;
  if (/\bPI_PROVIDER_OK\b/.test(text)) score += 10_000;
  if (/(?:^|\.)(?:answer|response|text|content|output|result)(?:$|\.)/i.test(path)) score += 800;
  if (/\s/.test(text)) score += 40;
  if (/[.!?}\]]$/.test(text)) score += 20;
  if (/<(?:div|p|span|article|section)\b/i.test(original)) score += 30;
  if (/^(?:AF5t|AUtE|AeYw|Cmow)/.test(text)) score -= 500;
  return score;
}

export function extractAdlText(rawBody) {
  const fragments = parseJsonFragments(rawBody);
  const strings = [];
  fragments.forEach((fragment, index) => collectStrings(fragment, `$[${index}]`, strings));

  const candidates = strings
    .map(({ value, path }) => {
      const text = /<[^>]+>/.test(value) ? htmlToText(value) : value.trim();
      return { text, path, original: value };
    })
    .filter(({ text }) => Boolean(text))
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score);

  if (candidates.length > 0) {
    return {
      text: candidates[0].text,
      candidates: candidates.slice(0, 10).map(({ text, path, score }) => ({ text, path, score })),
      fragments,
    };
  }

  const fallback = htmlToText(stripXssiPrefix(rawBody));
  if (!fallback) throw new Error("Google returned an empty or unrecognized ADL response");
  return { text: fallback, candidates: [{ text: fallback, path: "$raw", score: 0 }], fragments };
}
