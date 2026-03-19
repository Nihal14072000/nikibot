/**
 * tools/search.js
 * Web search (Brave API) + page crawling (node-fetch + cheerio)
 */

import * as cheerio from "cheerio";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const CRAWL_MAX_CHARS = parseInt(process.env.CRAWL_MAX_CHARS || "4000", 10);
const SEARCH_RESULTS  = parseInt(process.env.SEARCH_RESULTS  || "5",    10);

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * Search the web via Brave Search API.
 * Returns an array of { title, url, snippet }
 */
export async function search(query) {
  if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY not set in .env");

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_RESULTS}&safesearch=moderate`;

  const res = await fetch(url, {
    headers: {
      "Accept":               "application/json",
      "Accept-Encoding":      "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brave Search error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const results = data?.web?.results ?? [];

  return results.map((r) => ({
    title:   r.title   ?? "",
    url:     r.url     ?? "",
    snippet: r.description ?? "",
  }));
}

/**
 * Format search results as a compact string to inject into the LLM prompt.
 */
export function formatSearchResults(results, query) {
  if (!results.length) return `No web results found for: "${query}"`;

  const lines = results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
  );

  return `Web search results for "${query}":\n\n${lines.join("\n\n")}`;
}

// ─── Crawl ─────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract clean readable text (strips scripts, styles, nav etc.)
 * Returns { title, text, url }
 */
export async function crawl(url) {
  // Normalise — add https:// if missing
  if (!url.startsWith("http")) url = "https://" + url;

  const res = await fetch(url, {
    headers: {
      // Mimic a real browser so sites don't block us
      "User-Agent":
        "Mozilla/5.0 (compatible; PersonalBot/1.0; +https://github.com/personal-bot)",
      "Accept":          "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`Not an HTML page (content-type: ${contentType})`);
  }

  const html = await res.text();
  return extractText(html, url);
}

/**
 * Parse HTML and extract clean readable text using cheerio.
 */
function extractText(html, url) {
  const $ = cheerio.load(html);

  // Remove noise elements
  $(
    "script, style, noscript, nav, footer, header, aside, " +
    "iframe, form, button, input, select, textarea, " +
    "[aria-hidden='true'], .ad, .ads, .advertisement, " +
    ".cookie-banner, .popup, .modal, .sidebar"
  ).remove();

  // Get page title
  const title = $("title").first().text().trim() ||
                $("h1").first().text().trim() ||
                url;

  // Extract main content — prefer article/main tags, fall back to body
  const mainEl =
    $("article").first().text() ||
    $("main").first().text()    ||
    $("[role='main']").first().text() ||
    $("body").text();

  // Clean up whitespace
  const text = mainEl
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CRAWL_MAX_CHARS);

  const truncated = mainEl.length > CRAWL_MAX_CHARS;

  return {
    title,
    url,
    text,
    truncated,
    charCount: text.length,
  };
}

/**
 * Format crawl result as a prompt-friendly string.
 */
export function formatCrawlResult(result) {
  return [
    `Page: ${result.title}`,
    `URL: ${result.url}`,
    result.truncated ? `(showing first ${result.charCount} characters)\n` : "",
    result.text,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Intent detection ──────────────────────────────────────────────────────

// Keywords that strongly suggest the user wants current/live information
const SEARCH_TRIGGERS = [
  // Time-sensitive
  "latest", "recent", "today", "yesterday", "this week", "this month",
  "right now", "currently", "breaking", "news", "update", "2024", "2025",
  // Lookup intent
  "who is", "what is", "where is", "when is", "how much", "how many",
  "price of", "cost of", "stock", "weather", "score", "results",
  // Research
  "find", "search for", "look up", "tell me about", "information on",
];

/**
 * Heuristic check: does this message likely need a web search?
 * Fast — no API call needed.
 */
export function likelyNeedsSearch(text) {
  const lower = text.toLowerCase();

  // Explicit URL — use crawl instead
  if (/https?:\/\//.test(text) || /www\./.test(text)) return false;

  return SEARCH_TRIGGERS.some((trigger) => lower.includes(trigger));
}

/**
 * Ask the LLM whether the message needs a web search.
 * Used when heuristic is ambiguous.
 * Returns { needed: boolean, query: string }
 */
export async function detectSearchIntent(userMessage, llmFn) {
  const prompt = `Given this user message, decide if answering it well requires searching the web for current or factual information.

User message: "${userMessage}"

Reply with ONLY a JSON object like:
{"needed": true, "query": "search query to use"}
or
{"needed": false, "query": ""}

Rules:
- needed=true for current events, news, prices, real people, recent releases, factual lookups
- needed=false for creative writing, coding help, general knowledge, math, opinions
- If needed, write the best short search query (3-6 words) to answer the message
- No explanation, no markdown, just the JSON`;

  try {
    const raw = await llmFn([{ role: "user", content: prompt }]);
    // Strip any accidental markdown fences
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // If LLM or parse fails, fall back to heuristic
    return { needed: likelyNeedsSearch(userMessage), query: userMessage };
  }
}
