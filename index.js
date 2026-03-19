import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import {
  search,
  crawl,
  formatSearchResults,
  formatCrawlResult,
  detectSearchIntent,
  likelyNeedsSearch,
} from "./tools/search.js";
import { runCommand, formatResult, inferCommand } from "./tools/cli.js";

// ─── Config ────────────────────────────────────────────────────────────────

const {
  TELEGRAM_BOT_TOKEN,
  PROVIDER = "openai",
  OPENAI_API_KEY,
  GROQ_API_KEY,
  ANTHROPIC_API_KEY,
  MODEL,
  SYSTEM_PROMPT = "You are a concise, helpful personal assistant.",
  MAX_HISTORY = "20",
  ALLOWED_USER_IDS = "",
  SEARCH_AUTO = "true",
} = process.env;

const AUTO_SEARCH = SEARCH_AUTO === "true" && !!process.env.BRAVE_API_KEY;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const MAX_HIST = parseInt(MAX_HISTORY, 10);
const ALLOWED = ALLOWED_USER_IDS
  ? new Set(ALLOWED_USER_IDS.split(",").map((id) => id.trim()))
  : null; // null = allow everyone

// ─── Database (SQLite — stores conversation history) ───────────────────────

const db = new Database("history.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   TEXT    NOT NULL,
    role      TEXT    NOT NULL,   -- 'user' | 'assistant'
    content   TEXT    NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_chat ON messages(chat_id, id);
`);

const insertMsg = db.prepare(
  "INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)"
);

const getHistory = db.prepare(`
  SELECT role, content FROM messages
  WHERE chat_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

function loadHistory(chatId) {
  // Returns oldest-first for the API
  return getHistory.all(String(chatId), MAX_HIST).reverse();
}

function saveMessage(chatId, role, content) {
  insertMsg.run(String(chatId), role, content);
}

// ─── LLM Clients ───────────────────────────────────────────────────────────

let openaiClient, anthropicClient;

if (PROVIDER === "anthropic") {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
} else {
  // openai or groq — both use OpenAI-compatible SDK
  const apiKey = PROVIDER === "groq" ? GROQ_API_KEY : OPENAI_API_KEY;
  const baseURL =
    PROVIDER === "groq" ? "https://api.groq.com/openai/v1" : undefined;

  if (!apiKey) throw new Error(`Missing API key for provider: ${PROVIDER}`);
  openaiClient = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

// Default models per provider
const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  groq: "llama3-8b-8192",
  anthropic: "claude-haiku-4-5-20251001",
};
const model = MODEL || DEFAULT_MODELS[PROVIDER];

// ─── Call the LLM ──────────────────────────────────────────────────────────

async function chat(history) {
  if (PROVIDER === "anthropic") {
    const res = await anthropicClient.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    return res.content[0].text;
  }

  // OpenAI / Groq
  const res = await openaiClient.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
  });
  return res.choices[0].message.content;
}

// ─── Retry with exponential backoff on rate limit (429) ────────────────────

const RETRY_DELAYS = [3000, 6000, 15000]; // 3s → 6s → 15s

async function chatWithRetry(history) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await chat(history);
    } catch (err) {
      const isRateLimit = err.status === 429 || err.message?.includes("rate limit");
      const isLast = attempt === RETRY_DELAYS.length;

      if (isRateLimit && !isLast) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(`⚠️  Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS.length})`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err; // non-rate-limit error or out of retries
      }
    }
  }
}

// ─── Global message queue (synchronous processing) ─────────────────────────
//
// Ensures only ONE message is sent to the LLM at a time.
// New messages wait in line instead of firing parallel API calls.
// This naturally prevents rate limit bursts.

let processingQueue = Promise.resolve();

function enqueue(fn) {
  // Chain onto the existing queue — each task waits for the previous to finish
  processingQueue = processingQueue.then(fn).catch(() => {});
  return processingQueue;
}

// ─── Search-augmented reply ────────────────────────────────────────────────

/**
 * Build a context-injected history when web data is available.
 * Prepends search/crawl results as a system-style user message.
 */
function injectContext(history, contextText) {
  return [
    {
      role: "user",
      content: `[Web context — use this to answer the next question]

${contextText}`,
    },
    { role: "assistant", content: "Understood. I'll use that context to answer." },
    ...history,
  ];
}

// ─── Telegram Bot ──────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log(`🤖  Bot started | provider=${PROVIDER} | model=${model}`);
console.log(`🔍  Web search: ${AUTO_SEARCH ? "AUTO (Brave)" : process.env.BRAVE_API_KEY ? "manual only (/search)" : "disabled (no BRAVE_API_KEY)"}`);
if (ALLOWED) console.log(`🔒  Restricted to user IDs: ${[...ALLOWED].join(", ")}`);

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id ?? "");
  const text = msg.text?.trim();

  // ── Auth check ────────────────────────────────────────────
  if (ALLOWED && !ALLOWED.has(userId)) {
    bot.sendMessage(chatId, "⛔ You are not authorised to use this bot.");
    return;
  }

  if (!text) return;

  // ── Commands bypass the queue (instant response) ──────────
  if (text === "/start") {
    const searchStatus = process.env.BRAVE_API_KEY
      ? `🔍 Web search: enabled`
      : `🔍 Web search: disabled (add BRAVE_API_KEY to .env)`;
    bot.sendMessage(
      chatId,
      `👋 Hi! I'm your personal AI assistant.\n\nI remember the last ${MAX_HIST} messages of our conversation.\n${searchStatus}\n\nCommands:\n/clear — wipe conversation history\n/model — show current model\n/search <query> — force a web search\n/crawl <url> — read a webpage\n/queue — check processing status`
    );
    return;
  }

  if (text === "/clear") {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(String(chatId));
    bot.sendMessage(chatId, "🗑️ Conversation history cleared.");
    return;
  }

  if (text === "/model") {
    bot.sendMessage(chatId, `🧠 Provider: ${PROVIDER}\n📦 Model: ${model}`);
    return;
  }

  if (text === "/queue") {
    bot.sendMessage(chatId, `📬 Messages are processed one at a time.\nIf the bot seems slow, a previous message is still being answered.`);
    return;
  }

  // ── /run <command> — execute a shell command ─────────────
  if (text.startsWith("/run ")) {
    const cmd = text.slice(5).trim();
    if (!cmd) { bot.sendMessage(chatId, "Usage: /run <shell command>\nExample: /run df -h"); return; }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const result = await runCommand(cmd, userId);
        const reply  = formatResult(cmd, result);
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Failed to run command: ${err.message}`);
      }
    });
    return;
  }

  // ── /shell — natural language → shell command ──────────────
  if (text.startsWith("/shell ")) {
    const request = text.slice(7).trim();
    if (!request) { bot.sendMessage(chatId, "Usage: /shell <what you want to do>\nExample: /shell show disk usage"); return; }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const cmd = await inferCommand(request, (h) => chat(h));
        if (!cmd) {
          await bot.sendMessage(chatId, "⚠️ Could not determine a safe command for that request. Try /run with an explicit command.");
          return;
        }
        // Show the command it's about to run, then execute
        await bot.sendMessage(chatId, `🔧 Running: \`${cmd}\``, { parse_mode: "Markdown" });
        const result = await runCommand(cmd, userId);
        const reply  = formatResult(cmd, result);
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Shell error: ${err.message}`);
      }
    });
    return;
  }

  // ── /sysinfo — quick server health snapshot ────────────────
  if (text === "/sysinfo") {
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      const commands = [
        { label: "Uptime",  cmd: "uptime" },
        { label: "Memory",  cmd: "free -h" },
        { label: "Disk",    cmd: "df -h" },
        { label: "CPU",     cmd: "top -bn1 | head -5" },
      ];

      const lines = ["📊 *System Info*\n"];
      for (const { label, cmd } of commands) {
        try {
          const res = await runCommand(cmd, userId);
          lines.push(`*${label}*\n\`\`\`\n${res.stdout || res.stderr}\n\`\`\``);
        } catch {
          lines.push(`*${label}*: error`);
        }
      }

      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
    });
    return;
  }

  // ── /search <query> — explicit web search ─────────────────
  if (text.startsWith("/search ")) {
    const query = text.slice(8).trim();
    if (!query) { bot.sendMessage(chatId, "Usage: /search <your query>"); return; }
    if (!process.env.BRAVE_API_KEY) {
      bot.sendMessage(chatId, "⚠️ BRAVE_API_KEY not set. Add it to .env to enable search.");
      return;
    }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        bot.sendMessage(chatId, `🔍 Searching: *${query}*`, { parse_mode: "Markdown" });
        const results = await search(query);
        const context = formatSearchResults(results, query);

        saveMessage(chatId, "user", text);
        const history = loadHistory(chatId);
        const augmented = injectContext(history, context);
        const reply = await chatWithRetry(augmented);
        saveMessage(chatId, "assistant", reply);

        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch (err) {
        console.error("Search error:", err.message);
        await bot.sendMessage(chatId, `⚠️ Search failed: ${err.message}`);
      }
    });
    return;
  }

  // ── /crawl <url> — fetch and read a webpage ───────────────
  if (text.startsWith("/crawl ")) {
    const url = text.slice(7).trim();
    if (!url) { bot.sendMessage(chatId, "Usage: /crawl <url>"); return; }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        bot.sendMessage(chatId, `🕷️ Crawling: ${url}`, { parse_mode: "Markdown" });
        const result = await crawl(url);
        const context = formatCrawlResult(result);

        saveMessage(chatId, "user", `Summarise and answer questions about this page: ${url}`);
        const history = loadHistory(chatId);
        const augmented = injectContext(history, context);
        const reply = await chatWithRetry(augmented);
        saveMessage(chatId, "assistant", reply);

        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch (err) {
        console.error("Crawl error:", err.message);
        await bot.sendMessage(chatId, `⚠️ Could not crawl that page: ${err.message}`);
      }
    });
    return;
  }

  // ── Normal message — auto-search if enabled ────────────────
  enqueue(async () => {
    bot.sendChatAction(chatId, "typing");

    try {
      saveMessage(chatId, "user", text);
      const history = loadHistory(chatId);
      let augmented = history;

      // Auto web search: heuristic fast-path, then LLM confirm if ambiguous
      if (AUTO_SEARCH) {
        let needsSearch = likelyNeedsSearch(text);
        let searchQuery = text;

        // If heuristic isn't confident, ask LLM (costs one small API call)
        if (!needsSearch) {
          const intent = await detectSearchIntent(text, (h) => chat(h));
          needsSearch  = intent.needed;
          searchQuery  = intent.query || text;
        }

        if (needsSearch) {
          console.log(`🔍 Auto-searching: "${searchQuery}"`);
          bot.sendChatAction(chatId, "typing");
          try {
            const results = await search(searchQuery);
            const context = formatSearchResults(results, searchQuery);
            augmented = injectContext(history, context);
          } catch (searchErr) {
            console.warn("Auto-search failed, answering without:", searchErr.message);
          }
        }
      }

      const reply = await chatWithRetry(augmented);
      saveMessage(chatId, "assistant", reply);
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });

    } catch (err) {
      console.error("LLM error:", err.message);
      const isRateLimit = err.status === 429 || err.message?.includes("rate limit");
      await bot.sendMessage(
        chatId,
        isRateLimit
          ? "⏳ The AI provider is rate limiting us. Please wait a moment and try again."
          : "⚠️ Something went wrong. Try again in a moment."
      );
    }
  });
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  bot.stopPolling();
  db.close();
  process.exit(0);
});
