import { extractAdlText } from "./adl.js";
import { askThroughAgentBrowser } from "./agent-browser.js";
import { loadTemplate, normalizeTemplate } from "./request-template.js";

export const DEFAULT_TEMPLATE_PATH = `${process.env.HOME ?? ""}/.pi/agent/google-web-request.json`;

function looksLikeBotCheck(response) {
  return response.status === 429
    || /\/sorry\//i.test(response.url ?? "")
    || /unusual traffic|our systems have detected|recaptcha/i.test(response.body ?? "");
}

export class GoogleWebClient {
  constructor({ template, templatePath, transport = askThroughAgentBrowser, session, headed, timeoutMs } = {}) {
    this.template = template;
    this.templatePath = templatePath;
    this.transport = transport;
    this.session = session;
    this.headed = headed;
    this.timeoutMs = timeoutMs;
  }

  async resolvedTemplate() {
    if (this.template) return normalizeTemplate(this.template);
    return loadTemplate(this.templatePath || process.env.PI_GOOGLE_WEB_TEMPLATE || DEFAULT_TEMPLATE_PATH);
  }

  async ask(query, { signal, raw = false } = {}) {
    const template = this.template || this.templatePath ? await this.resolvedTemplate() : undefined;
    const response = await this.transport({
      template,
      query,
      session: this.session,
      headed: this.headed,
      signal,
      timeoutMs: this.timeoutMs,
    });

    if (looksLikeBotCheck(response)) {
      const error = new Error(
        "Google returned a bot-check response. Open the same agent-browser session headed, complete any Google check manually, then retry.",
      );
      error.code = "GOOGLE_BOT_CHECK";
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Google request failed with HTTP ${response.status} ${response.statusText ?? ""}`.trim());
      error.code = "GOOGLE_HTTP_ERROR";
      error.status = response.status;
      throw error;
    }

    const extracted = raw ? undefined : extractAdlText(response.body);
    return {
      ...response,
      text: extracted?.text,
      candidates: extracted?.candidates ?? [],
    };
  }
}
