import { spawn } from "node:child_process";

const capabilityCache = new Map();

export function agentBrowserExecutable() {
  return process.env.PI_GOOGLE_AGENT_BROWSER_BIN || "agent-browser";
}

function commandError(args, code, stdout, stderr) {
  const detail = [stderr, stdout].map((value) => value.trim()).filter(Boolean).join("\n");
  const error = new Error(`agent-browser ${args.join(" ")} failed with exit code ${code}${detail ? `:\n${detail}` : ""}`);
  error.code = "AGENT_BROWSER_COMMAND_FAILED";
  error.exitCode = code;
  return error;
}

export function runAgentBrowser(args, { input, signal, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const executable = agentBrowserExecutable();
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      env: process.env,
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer;

    const signalChild = (childSignal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, childSignal);
        else child.kill(childSignal);
      } catch {
        // The process may already have exited.
      }
    };
    const terminateChild = () => {
      signalChild("SIGTERM");
      forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 2_000);
      forceKillTimer.unref?.();
    };

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      terminateChild();
      finish(() => reject(Object.assign(new Error("agent-browser request aborted"), { code: "ABORT_ERR" })));
    };
    const timer = setTimeout(() => {
      terminateChild();
      finish(() => reject(Object.assign(new Error(`agent-browser timed out after ${timeoutMs}ms`), { code: "TIMEOUT" })));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(forceKillTimer);
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      clearTimeout(forceKillTimer);
      finish(() => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(commandError(args, code, stdout, stderr));
      });
    });

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    if (input == null) child.stdin.end();
    else child.stdin.end(input);
  });
}

export function persistentLaunchArgsFromHelp(session, helpText) {
  if (/--restore(?:\s|\[)/.test(helpText)) {
    return ["--session", session, "--restore", "--restore-save", "auto"];
  }
  if (/--session-name\s/.test(helpText)) {
    return ["--session", session, "--session-name", session];
  }
  return ["--session", session];
}

export async function persistentLaunchArgs(session, options = {}) {
  const executable = agentBrowserExecutable();
  let capabilities = capabilityCache.get(executable);
  if (!capabilities) {
    capabilities = runAgentBrowser(["--help"], options).then(({ stdout, stderr }) => stdout || stderr);
    capabilityCache.set(executable, capabilities);
  }
  return persistentLaunchArgsFromHelp(session, await capabilities);
}

function parseAgentBrowserResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`agent-browser returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
  if (parsed?.success === false) {
    throw new Error(parsed.error?.message ?? parsed.message ?? "agent-browser evaluation failed");
  }
  return parsed?.data?.result ?? parsed?.result ?? parsed?.data ?? parsed;
}

export function buildFetchEvaluation({ template, query }) {
  const payload = Buffer.from(JSON.stringify({ template, query }), "utf8").toString("base64");
  return `
(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(payload)}), char => char.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  const url = new URL(payload.template.url);
  url.searchParams.set("q", payload.query);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: payload.template.headers || {},
    referrer: payload.template.referrer || "https://www.google.com/",
    credentials: "include",
    mode: "cors",
    redirect: "follow"
  });
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body
  };
})()
`.trim();
}

export function buildAiModeUrl(query, { maxUrlChars = 8_000 } = {}) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("udm", "50");
  url.searchParams.set("q", query);
  if (url.toString().length > maxUrlChars) {
    throw new Error(
      `Google AI Mode query URL is too large (${url.toString().length} characters; limit ${maxUrlChars}). `
      + "Reduce the prompt or PI_GOOGLE_WEB_MAX_ENCODED_QUERY_CHARS.",
    );
  }
  return url.toString();
}

export function buildAiModeAnswerEvaluation({ timeoutMs = 120_000 } = {}) {
  const browserTimeoutMs = Math.max(1_000, Number(timeoutMs) || 120_000);
  return `
(async () => {
  const timeoutMs = ${JSON.stringify(browserTimeoutMs)};
  const startedAt = Date.now();
  let lastAnswer = "";
  let lastChangedAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    const body = document.body;
    const bodyText = body?.innerText || "";
    const allText = body?.textContent || bodyText;
    const roots = [...document.querySelectorAll('[data-subtree="aimfl"]')];
    const answer = (roots[roots.length - 1]?.innerText || "").trim();
    const botCheck = /\\/sorry\\//i.test(location.pathname)
      || /unusual traffic|our systems have detected|recaptcha/i.test(bodyText);

    if (botCheck) {
      return { ok: false, botCheck: true, url: location.href, answer, bodyText };
    }
    if (answer !== lastAnswer) {
      lastAnswer = answer;
      lastChangedAt = Date.now();
    }

    const announcedReady = /AI Mode response is ready/i.test(allText);
    const stableFallback = answer && Date.now() - lastChangedAt >= 4_000;
    if (answer && (announcedReady || stableFallback)) {
      return { ok: true, complete: true, url: location.href, answer };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return {
    ok: false,
    complete: false,
    timedOut: true,
    url: location.href,
    answer: lastAnswer,
    bodyText: document.body?.innerText || ""
  };
})()
`.trim();
}

export async function askThroughAgentBrowser({
  query,
  session = process.env.PI_GOOGLE_AGENT_BROWSER_SESSION || "pi-google-web",
  headed = process.env.PI_GOOGLE_AGENT_BROWSER_HEADED === "1",
  signal,
  timeoutMs = 120_000,
}) {
  const launchArgs = await persistentLaunchArgs(session, { signal, timeoutMs });
  if (headed) launchArgs.push("--headed");
  launchArgs.push("open", buildAiModeUrl(query));
  await runAgentBrowser(launchArgs, { signal, timeoutMs });

  const evaluation = buildAiModeAnswerEvaluation({ timeoutMs });
  const { stdout } = await runAgentBrowser(
    ["--session", session, "--json", "eval", "--stdin"],
    { input: evaluation, signal, timeoutMs: timeoutMs + 5_000 },
  );
  const result = parseAgentBrowserResult(stdout);
  if (!result || typeof result !== "object") {
    throw new Error("agent-browser did not return a Google AI Mode result");
  }
  if (result.botCheck) {
    return {
      ok: false,
      status: 429,
      statusText: "Google bot check",
      url: result.url,
      headers: {},
      body: result.bodyText || "Google bot check",
    };
  }
  if (!result.ok || !result.complete || typeof result.answer !== "string" || !result.answer.trim()) {
    const partial = typeof result.answer === "string" ? result.answer.trim() : "";
    const detail = partial ? ` Partial answer: ${partial.slice(0, 300)}` : "";
    throw new Error(`Timed out waiting for Google AI Mode to finish.${detail}`);
  }

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: result.url,
    headers: {},
    body: result.answer.trim(),
  };
}

export async function fetchThroughAgentBrowser({
  template,
  query,
  session = process.env.PI_GOOGLE_AGENT_BROWSER_SESSION || "pi-google-web",
  headed = process.env.PI_GOOGLE_AGENT_BROWSER_HEADED === "1",
  signal,
  timeoutMs,
}) {
  const launchArgs = await persistentLaunchArgs(session, { signal, timeoutMs });
  if (headed) launchArgs.push("--headed");
  launchArgs.push("open", "https://www.google.com/");
  await runAgentBrowser(launchArgs, { signal, timeoutMs });

  const evaluation = buildFetchEvaluation({ template, query });
  const { stdout } = await runAgentBrowser(
    ["--session", session, "--json", "eval", "--stdin"],
    { input: evaluation, signal, timeoutMs },
  );
  const result = parseAgentBrowserResult(stdout);
  if (!result || typeof result !== "object" || typeof result.body !== "string") {
    throw new Error("agent-browser did not return a fetch response body");
  }
  return result;
}
