import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { initDb, prepare, exec as dbExec, close as dbClose } from "./tools/db.js";
import {
  search,
  crawl,
  formatSearchResults,
  formatCrawlResult,
  detectSearchIntent,
  likelyNeedsSearch,
} from "./tools/search.js";
import { runCommand, formatResult, inferCommand } from "./tools/cli.js";
import { agentLoop, TOOL_DEFINITIONS } from "./tools/agent.js";
import {
  setupRemindersTable, addReminder, listPending, deleteReminder,
  parseReminder, formatFireAt, formatReminderList, startReminderLoop,
} from "./tools/reminders.js";
import { handleImage, isImageDocument } from "./tools/vision.js";
import {
  readMemory, appendMemory, forgetMemory, replaceMemory,
  detectMemoryIntent, extractFact, autoExtractAndSave,
  buildMemoryContext, initMemory, memoryExists,
} from "./tools/memory.js";
import {
  listEmails, readEmail, sendEmail, replyToEmail,
  modifyEmail, getUnreadCount, formatEmailList, formatEmailDetail,
  GMAIL_SCOPES,
} from "./tools/gmail.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

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
  OPENAI_BASE_URL = "",
} = process.env;

const AUTO_SEARCH = SEARCH_AUTO === "true" && !!process.env.BRAVE_API_KEY;
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false"; // default on

// Append tool definitions to system prompt if tools enabled
const FULL_SYSTEM_PROMPT = ENABLE_TOOLS
  ? SYSTEM_PROMPT + "\n\n" + TOOL_DEFINITIONS
  : SYSTEM_PROMPT;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const MAX_HIST = parseInt(MAX_HISTORY, 10);
const ALLOWED = ALLOWED_USER_IDS
  ? new Set(ALLOWED_USER_IDS.split(",").map((id) => id.trim()))
  : null; // null = allow everyone

// ─── Database (SQLite — stores conversation history) ───────────────────────

// DB is initialised async before bot starts (see bottom of file)
let insertMsg, getHistory;

async function setupDb() {
  await initDb("history.db");
  insertMsg  = prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)");
  getHistory = prepare(`
    SELECT role, content FROM messages
    WHERE chat_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);
}

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
  // openai / groq / openrouter — all use OpenAI-compatible SDK
  const apiKey = PROVIDER === "groq" ? GROQ_API_KEY : OPENAI_API_KEY;

  // Base URL priority: env var > provider default
  const baseURL =
    OPENAI_BASE_URL ||
    (PROVIDER === "groq"        ? "https://api.groq.com/openai/v1"  :
     PROVIDER === "openrouter"  ? "https://openrouter.ai/api/v1"    : undefined);

  if (!apiKey) throw new Error(`Missing API key for provider: ${PROVIDER}`);

  openaiClient = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    // OpenRouter requires these headers for usage tracking (optional but recommended)
    defaultHeaders: PROVIDER === "openrouter" || OPENAI_BASE_URL.includes("openrouter") ? {
      "HTTP-Referer": "https://github.com/personal-telegram-bot",
      "X-Title": "Personal Telegram Assistant",
    } : {},
  });
}

// Default models per provider
const DEFAULT_MODELS = {
  openai:      "gpt-4o-mini",
  groq:        "llama3-8b-8192",
  anthropic:   "claude-haiku-4-5-20251001",
  openrouter:  "minimax/minimax-m2.5",
};
const model = MODEL || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.openai;

// ─── Call the LLM ──────────────────────────────────────────────────────────

async function chat(history) {
  if (PROVIDER === "anthropic") {
    const res = await anthropicClient.messages.create({
      model,
      max_tokens: 1024,
      system: FULL_SYSTEM_PROMPT,
      messages: history,
    });
    return res.content[0].text;
  }

  // OpenAI / Groq / OpenRouter
  const res = await openaiClient.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "system", content: FULL_SYSTEM_PROMPT }, ...history],
  });
  let reply = res.choices[0].message.content ?? "";
  // Strip any leaked tool call XML from agentic models
  reply = reply.replace(/<minimax:toolcall>[\s\S]*?<\/minimax:toolcall>/gi, "").trim();
  reply = reply.replace(/<invoke[\s\S]*?<\/invoke>/gi, "").trim();
  return reply || "I could not generate a response. Try rephrasing.";
}

/**
 * Streaming version — sends words as they arrive by editing a Telegram message.
 * Falls back to non-streaming if provider doesn't support it.
 */
async function chatStream(history, bot, chatId) {
  // Anthropic streaming
  if (PROVIDER === "anthropic") {
    const stream = await anthropicClient.messages.stream({
      model,
      max_tokens: 1024,
      system: FULL_SYSTEM_PROMPT,
      messages: history,
    });

    const sentMsg = await bot.sendMessage(chatId, "▌");
    let fullText  = "";
    let lastEdit  = Date.now();

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.text) {
        fullText += chunk.delta.text;
        // Edit message every 400ms to avoid hitting Telegram rate limits
        if (Date.now() - lastEdit > 400) {
          await bot.editMessageText(fullText + " ▌", {
            chat_id:    chatId,
            message_id: sentMsg.message_id,
          }).catch(() => {});
          lastEdit = Date.now();
        }
      }
    }

    // Final edit — remove cursor
    await bot.editMessageText(fullText || "Done.", {
      chat_id:    chatId,
      message_id: sentMsg.message_id,
      parse_mode: "Markdown",
    }).catch(() => {
      // If Markdown fails, send plain
      bot.editMessageText(fullText, { chat_id: chatId, message_id: sentMsg.message_id }).catch(() => {});
    });

    return fullText;
  }

  // OpenAI / OpenRouter streaming
  try {
    const stream  = await openaiClient.chat.completions.create({
      model,
      max_tokens: 1024,
      messages:   [{ role: "system", content: FULL_SYSTEM_PROMPT }, ...history],
      stream:     true,
    });

    const sentMsg = await bot.sendMessage(chatId, "▌");
    let fullText  = "";
    let lastEdit  = Date.now();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) {
        fullText += delta;
        if (Date.now() - lastEdit > 400) {
          await bot.editMessageText(fullText + " ▌", {
            chat_id:    chatId,
            message_id: sentMsg.message_id,
          }).catch(() => {});
          lastEdit = Date.now();
        }
      }
    }

    // Strip any leaked tool calls before final send
    fullText = fullText
      .replace(/<minimax:toolcall>[\s\S]*?<\/minimax:toolcall>/gi, "")
      .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
      .trim();

    await bot.editMessageText(fullText || "Done.", {
      chat_id:    chatId,
      message_id: sentMsg.message_id,
      parse_mode: "Markdown",
    }).catch(() => {
      bot.editMessageText(fullText, { chat_id: chatId, message_id: sentMsg.message_id }).catch(() => {});
    });

    return fullText;

  } catch (err) {
    // Streaming not supported — fall back to normal
    if (err.message?.includes("stream") || err.status === 400) {
      return await chat(history);
    }
    throw err;
  }
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

// initialise DB then start bot
await setupDb();
setupRemindersTable();

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log(`🤖  Bot started | provider=${PROVIDER} | model=${model}`);
initMemory(); // create MEMORY.md if it doesn't exist

// Start reminder background loop
startReminderLoop(async (reminder) => {
  try {
    await bot.sendMessage(reminder.chat_id,
      `⏰ *Reminder:* ${reminder.message}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Failed to fire reminder:", err.message);
  }
});
console.log("⏰  Reminder loop started (checks every 30s)");
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
    prepare("DELETE FROM messages WHERE chat_id = ?").run(String(chatId));
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


  // ── Reminder natural language detection ─────────────────────
  const reminderTriggers = [
    /^remind me/i, /^set (a )?reminder/i, /^reminder:/i,
    /^alert me/i,  /^notify me/i,
  ];
  if (reminderTriggers.some((r) => r.test(text))) {
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        // Strip trigger phrase to get the raw reminder text
        const cleaned = text
          .replace(/^remind me\s+(to\s+)?/i, "")
          .replace(/^set (a )?reminder (to\s+)?/i, "")
          .replace(/^reminder:\s*/i, "")
          .replace(/^alert me\s+(to\s+)?/i, "")
          .replace(/^notify me\s+(to\s+)?/i, "")
          .trim();

        const parsed = parseReminder(cleaned);
        if (!parsed) {
          await bot.sendMessage(chatId,
            "Could not parse that reminder time. Try:\n" +
            "• *remind me in 10 minutes to call John*\n" +
            "• *remind me at 6pm to take medicine*\n" +
            "• *remind me tomorrow at 9am for standup*\n" +
            "• *remind me every day at 8am to drink water*",
            { parse_mode: "Markdown" }
          );
          return;
        }

        addReminder(chatId, userId, parsed.message, parsed.fireAt, parsed.recurSecs);
        const recurText = parsed.recurSecs ? " 🔁 *(recurring)*" : "";
        await bot.sendMessage(chatId,
          `✅ Reminder set!\n⏰ *${formatFireAt(parsed.fireAt)}*${recurText}\n📝 ${parsed.message}`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        await bot.sendMessage(chatId, `Could not set reminder: ${err.message}`);
      }
    });
    return;
  }

  // ── /reminders — list pending reminders ───────────────────
  if (text === "/reminders") {
    enqueue(async () => {
      const pending = listPending(chatId);
      await bot.sendMessage(chatId, formatReminderList(pending), { parse_mode: "Markdown" });
      if (pending.length) {
        await bot.sendMessage(chatId, "_Use /cancelreminder <number> to remove one_", { parse_mode: "Markdown" });
      }
    });
    return;
  }

  // ── /cancelreminder <n> ───────────────────────────────────
  if (text.startsWith("/cancelreminder ")) {
    enqueue(async () => {
      const n       = parseInt(text.slice(16).trim(), 10);
      const pending = listPending(chatId);
      const target  = pending[n - 1];
      if (!target) {
        await bot.sendMessage(chatId, "Reminder not found. Use /reminders to see the list.");
        return;
      }
      deleteReminder(target.id, chatId);
      await bot.sendMessage(chatId, `🗑️ Cancelled: *${target.message}*`, { parse_mode: "Markdown" });
    });
    return;
  }

  // ── /memory — show current memory ───────────────────────────
  if (text === "/memory") {
    enqueue(async () => {
      const mem = readMemory();
      if (!mem) {
        bot.sendMessage(chatId, "Memory is empty. Say: remember that... to save something.");
      } else {
        const chunks = splitMessage(mem, 4000);
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
        }
      }
    });
    return;
  }

  // ── /remember <fact> — explicitly store a fact ────────────
  if (text.startsWith("/remember ")) {
    const fact = text.slice(10).trim();
    if (!fact) { bot.sendMessage(chatId, "Usage: /remember <fact>\nExample: /remember I am a backend developer"); return; }
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      const { fact: clean, section } = await extractFact(fact, (h) => chat(h));
      const line = appendMemory(clean, section);
      await bot.sendMessage(chatId, `🧠 Saved to memory under *${section}*:\n${line}`, { parse_mode: "Markdown" });
    });
    return;
  }

  // ── /forget <query> — remove matching lines ───────────────
  if (text.startsWith("/forget ")) {
    const query = text.slice(8).trim();
    if (!query) { bot.sendMessage(chatId, "Usage: /forget <what to forget>\nExample: /forget dark mode"); return; }
    enqueue(async () => {
      const removed = forgetMemory(query);
      if (removed) {
        await bot.sendMessage(chatId, `🗑️ Removed entries matching "*${query}*" from memory.`, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, `Nothing in memory matched "*${query}*".`, { parse_mode: "Markdown" });
      }
    });
    return;
  }

  // ── /memoryclear — wipe entire memory ────────────────────
  if (text === "/memoryclear") {
    enqueue(async () => {
      replaceMemory("");
      await bot.sendMessage(chatId, "🗑️ Memory cleared.");
    });
    return;
  }

  // ── /gmailauth — start Telegram-based OAuth flow ─────────
  if (text === "/gmailauth") {
    enqueue(async () => {
      try {
        const CREDS_PATH = path.resolve(process.env.GMAIL_CREDS_PATH || "gmail-credentials.json");
        const TOKEN_PATH = path.resolve(process.env.GMAIL_TOKEN_PATH || "gmail-token.json");

        if (!fs.existsSync(CREDS_PATH)) {
          await bot.sendMessage(chatId,
            "gmail-credentials.json not found on the server.\n\n" +
            "1. Create OAuth credentials in Google Cloud Console (Desktop app type)\n" +
            "2. Download the JSON file\n" +
            "3. Upload it to your bot folder:\n" +
            "   scp gmail-credentials.json ubuntu@<vm-ip>:~/telegram-ai-bot/\n\n" +
            "Then send /gmailauth again.\nFull guide: docs/GMAIL.md"
          );
          return;
        }

        if (fs.existsSync(TOKEN_PATH)) {
          await bot.sendMessage(chatId, "Gmail is already connected. Send /gmailauth_reset to reconnect with a different account.");
          return;
        }

        const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
        const { client_id, client_secret } = creds.installed || creds.web;
        const auth = new google.auth.OAuth2(
          client_id, client_secret,
          "urn:ietf:wg:oauth:2.0:oob"
        );

        const authUrl = auth.generateAuthUrl({
          access_type: "offline",
          scope: GMAIL_SCOPES,
          prompt: "consent",
        });

        // Store auth client for when user pastes code
        gmailAuthSessions.set(String(chatId), { auth, TOKEN_PATH });

        await bot.sendMessage(chatId,
          "Connect Gmail in 3 steps:\n\n" +
          "1. Open this URL in your browser (phone works too):\n" +
          authUrl + "\n\n" +
          "2. Sign in with your Gmail and approve access\n\n" +
          "3. You will see a code on screen (or in the URL bar after ?code=)\n\n" +
          "Paste the code here as: /gmailcode YOUR_CODE_HERE"
        );
      } catch (err) {
        await bot.sendMessage(chatId, "Gmail auth error: " + err.message);
      }
    });
    return;
  }

  // /gmailauth_reset — force re-authorisation
  if (text === "/gmailauth_reset") {
    enqueue(async () => {
      const TOKEN_PATH = path.resolve(process.env.GMAIL_TOKEN_PATH || "gmail-token.json");
      if (fs.existsSync(TOKEN_PATH)) {
        fs.unlinkSync(TOKEN_PATH);
        await bot.sendMessage(chatId, "Token cleared. Send /gmailauth to reconnect.");
      } else {
        await bot.sendMessage(chatId, "No token found. Send /gmailauth to connect.");
      }
    });
    return;
  }

  // /gmailcode <code> — complete OAuth flow
  if (text.startsWith("/gmailcode ")) {
    const code    = text.slice(11).trim();
    const session = gmailAuthSessions.get(String(chatId));

    if (!session) {
      bot.sendMessage(chatId, "No pending auth session. Send /gmailauth first.");
      return;
    }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const { auth, TOKEN_PATH } = session;

        // Accept raw code or full redirect URL
        let finalCode = code;
        if (code.includes("code=")) {
          try {
            finalCode = new URL(code).searchParams.get("code") || code;
          } catch {
            finalCode = code.split("code=")[1]?.split("&")[0] || code;
          }
        }

        const { tokens } = await auth.getToken(finalCode);
        auth.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

        // Verify connection
        const gmail   = google.gmail({ version: "v1", auth });
        const profile = await gmail.users.getProfile({ userId: "me" });

        gmailAuthSessions.delete(String(chatId));

        await bot.sendMessage(chatId,
          "Gmail connected successfully!\n" +
          "Account: " + profile.data.emailAddress + "\n\n" +
          "Try it: /inbox"
        );
      } catch (err) {
        await bot.sendMessage(chatId,
          "Code rejected: " + err.message + "\n\n" +
          "The code may have expired (they last ~10 minutes).\n" +
          "Send /gmailauth to get a fresh link."
        );
      }
    });
    return;
  }

  // ── Gmail commands ────────────────────────────────────────

  // /inbox — show recent unread emails
  if (text === "/inbox" || text.startsWith("/inbox ")) {
    const query = text.includes(" ") ? text.slice(7).trim() : "is:unread in:inbox";
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const emails = await listEmails(query);
        const count  = await getUnreadCount();
        const header = `📬 *Inbox* (${count} unread)\n\n`;
        const list   = formatEmailList(emails);
        await bot.sendMessage(chatId, header + list, { parse_mode: "Markdown" });
        if (emails.length) {
          await bot.sendMessage(chatId, `_Reply with /read <number> to open an email_`, { parse_mode: "Markdown" });
          // Cache email IDs for this chat session
          emailCache.set(String(chatId), emails);
        }
      } catch (err) {
        await bot.sendMessage(chatId, gmailError(err));
      }
    });
    return;
  }

  // /read <number|id> — read a full email
  if (text.startsWith("/read ")) {
    const arg = text.slice(6).trim();
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const messageId = resolveEmailId(chatId, arg);
        if (!messageId) {
          await bot.sendMessage(chatId, "⚠️ Use /inbox first, then /read <number> (e.g. /read 2)");
          return;
        }
        const email = await readEmail(messageId);
        const detail = formatEmailDetail(email);
        await bot.sendMessage(chatId, detail, { parse_mode: "Markdown" });
        await bot.sendMessage(
          chatId,
          `_Actions: /reply ${arg} <text>  |  /archive ${arg}  |  /trash ${arg}  |  /star ${arg}_`,
          { parse_mode: "Markdown" }
        );
        // Cache last-read for reply
        lastRead.set(String(chatId), { messageId, email });
      } catch (err) {
        await bot.sendMessage(chatId, gmailError(err));
      }
    });
    return;
  }

  // /reply <number|id> <message> — reply to an email
  if (text.startsWith("/reply ")) {
    const parts   = text.slice(7).trim().split(" ");
    const arg     = parts[0];
    const replyText = parts.slice(1).join(" ").trim();

    if (!replyText) {
      bot.sendMessage(chatId, "Usage: /reply <number> <your reply text>\nExample: /reply 1 Thanks, I\'ll get back to you tomorrow.");
      return;
    }

    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const messageId = resolveEmailId(chatId, arg);
        if (!messageId) {
          await bot.sendMessage(chatId, "⚠️ Use /inbox first, then /reply <number> <text>");
          return;
        }
        await replyToEmail(messageId, replyText);
        await bot.sendMessage(chatId, "✅ Reply sent!");
      } catch (err) {
        await bot.sendMessage(chatId, gmailError(err));
      }
    });
    return;
  }

  // /send — send a new email
  // Usage: /send to@email.com | Subject line | Body text
  if (text.startsWith("/send ")) {
    const parts = text.slice(6).split("|").map((s) => s.trim());
    if (parts.length < 3) {
      bot.sendMessage(
        chatId,
        "Usage: /send <to> | <subject> | <body>\n\nExample:\n/send john@example.com | Meeting tomorrow | Hi John, are you free at 3pm?"
      );
      return;
    }
    const [to, subject, body] = parts;
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        await sendEmail({ to, subject, body });
        await bot.sendMessage(chatId, `✅ Email sent to *${to}*`, { parse_mode: "Markdown" });
      } catch (err) {
        await bot.sendMessage(chatId, gmailError(err));
      }
    });
    return;
  }

  // /archive /trash /star /unstar /markread /markunread — email actions
  const actionMap = {
    "/archive":   "archive",
    "/trash":     "trash",
    "/star":      "star",
    "/unstar":    "unstar",
    "/markread":  "read",
    "/markunread":"unread",
  };

  for (const [cmd, action] of Object.entries(actionMap)) {
    if (text.startsWith(cmd + " ") || text === cmd) {
      const arg = text.slice(cmd.length).trim() || "1";
      enqueue(async () => {
        bot.sendChatAction(chatId, "typing");
        try {
          const messageId = resolveEmailId(chatId, arg);
          if (!messageId) {
            await bot.sendMessage(chatId, `⚠️ Use /inbox first, then ${cmd} <number>`);
            return;
          }
          await modifyEmail(messageId, action);
          const labels = { archive: "Archived", trash: "Moved to trash", star: "Starred ⭐", unstar: "Unstarred", read: "Marked as read", unread: "Marked as unread" };
          await bot.sendMessage(chatId, `✅ ${labels[action]}`);
        } catch (err) {
          await bot.sendMessage(chatId, gmailError(err));
        }
      });
      return;
    }
  }

  // /gmail — natural language Gmail action via LLM
  if (text.startsWith("/gmail ")) {
    const request = text.slice(7).trim();
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        const cached = emailCache.get(String(chatId)) ?? [];
        const emailSummary = cached.length
          ? cached.map((e, i) => `${i+1}. "${e.subject}" from ${e.from}`).join("\n")
          : "No emails cached — user hasn\'t run /inbox yet";

        const prompt = `You are controlling a Gmail bot. The user wants to: "${request}"

Current cached emails:
${emailSummary}

Based on the request, reply with ONLY a JSON object:
{
  "action": "list"|"read"|"reply"|"send"|"archive"|"trash"|"star"|"unread",
  "emailNumber": 1,
  "to": "",
  "subject": "",
  "body": ""
}

Rules:
- emailNumber = which email from the list (1-based)
- For send/reply, fill in to/subject/body
- If unclear, use action "list"
- No explanation, just JSON`;

        const raw    = await chat([{ role: "user", content: prompt }]);
        const clean  = raw.replace(/\`\`\`json|\`\`\`/g, "").trim();
        const intent = JSON.parse(clean);

        // Execute the intent
        if (intent.action === "list") {
          const emails = await listEmails("is:unread in:inbox");
          emailCache.set(String(chatId), emails);
          await bot.sendMessage(chatId, formatEmailList(emails), { parse_mode: "Markdown" });

        } else if (intent.action === "read") {
          const messageId = resolveEmailId(chatId, String(intent.emailNumber));
          if (!messageId) { await bot.sendMessage(chatId, "⚠️ Run /inbox first."); return; }
          const email = await readEmail(messageId);
          lastRead.set(String(chatId), { messageId, email });
          await bot.sendMessage(chatId, formatEmailDetail(email), { parse_mode: "Markdown" });

        } else if (intent.action === "reply") {
          const messageId = resolveEmailId(chatId, String(intent.emailNumber));
          if (!messageId) { await bot.sendMessage(chatId, "⚠️ Run /inbox first."); return; }
          await replyToEmail(messageId, intent.body);
          await bot.sendMessage(chatId, "✅ Reply sent!");

        } else if (intent.action === "send") {
          await sendEmail({ to: intent.to, subject: intent.subject, body: intent.body });
          await bot.sendMessage(chatId, `✅ Email sent to *${intent.to}*`, { parse_mode: "Markdown" });

        } else if (["archive","trash","star","unread","read"].includes(intent.action)) {
          const messageId = resolveEmailId(chatId, String(intent.emailNumber));
          if (!messageId) { await bot.sendMessage(chatId, "⚠️ Run /inbox first."); return; }
          await modifyEmail(messageId, intent.action);
          await bot.sendMessage(chatId, `✅ Done!`);
        }

      } catch (err) {
        await bot.sendMessage(chatId, gmailError(err));
      }
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

  // ── Photo handler — vision analysis ─────────────────────────
  if (msg.photo || (msg.document && isImageDocument(msg.document))) {
    enqueue(async () => {
      bot.sendChatAction(chatId, "typing");
      try {
        // Get the best quality photo
        const fileId = msg.photo
          ? msg.photo[msg.photo.length - 1].file_id   // largest size
          : msg.document.file_id;

        const caption = msg.caption?.trim() || "";

        await bot.sendMessage(chatId, "🖼️ Analysing image...");

        const answer = await handleImage({
          bot,
          openaiClient,
          fileId,
          caption,
          systemPrompt: FULL_SYSTEM_PROMPT,
        });

        // Save to history
        const userMsg = caption ? `[Image] ${caption}` : "[Image sent]";
        saveMessage(chatId, "user",      userMsg);
        saveMessage(chatId, "assistant", answer);

        await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
      } catch (err) {
        console.error("Vision error:", err.message);
        await bot.sendMessage(chatId,
          err.message.includes("VISION_MODEL") || err.message.includes("model")
            ? "Vision model not available. Check VISION_MODEL in .env"
            : `Could not analyse image: ${err.message}`
        );
      }
    });
    return;
  }

  // ── Normal message — auto-search + memory ────────────────
  enqueue(async () => {
    bot.sendChatAction(chatId, "typing");

    try {
      // ── Check for memory intent first ─────────────────────
      const memIntent = detectMemoryIntent(text);

      if (memIntent.type === "show") {
        const mem = readMemory();
        if (!mem) {
          await bot.sendMessage(chatId, "🧠 Memory is empty. Tell me something to remember!");
        } else {
          for (const chunk of splitMessage(mem, 4000)) {
            await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
          }
        }
        return;
      }

      if (memIntent.type === "remember") {
        const { fact, section } = await extractFact(text, (h) => chat(h));
        const line = appendMemory(fact, section);
        await bot.sendMessage(chatId, `🧠 Got it! Saved to memory:\n${line}`, { parse_mode: "Markdown" });
        return;
      }

      if (memIntent.type === "forget") {
        const query = text.replace(/^forget (that |this )?/i, "").trim();
        const removed = forgetMemory(query);
        await bot.sendMessage(chatId,
          removed
            ? `🗑️ Removed from memory: "${query}"`
            : `Nothing in memory matched: "${query}"`
        );
        return;
      }

      // ── Normal LLM reply ──────────────────────────────────
      saveMessage(chatId, "user", text);
      const history = loadHistory(chatId);
      let augmented = history;

      // Inject persistent memory into prompt context
      const memCtx = buildMemoryContext();
      if (memCtx) {
        augmented = [
          { role: "user",      content: memCtx },
          { role: "assistant", content: "Understood, I have your memory context loaded." },
          ...history,
        ];
      }

      // Auto web search: heuristic fast-path, then LLM confirm if ambiguous
      if (AUTO_SEARCH) {
        let needsSearch = likelyNeedsSearch(text);
        let searchQuery = text;

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
            augmented = injectContext(augmented, context);
          } catch (searchErr) {
            console.warn("Auto-search failed, answering without:", searchErr.message);
          }
        }
      }

      // Use agentic loop when tools are enabled (handles both tool-call and
      // plain responses). Fall back to streaming when tools are disabled.
      let reply;
      if (ENABLE_TOOLS) {
        // agentic path — gets the full LLM response first, then executes any
        // tool calls it contains before returning the final clean answer
        reply = await agentLoop((msgs) => chatWithRetry(msgs), augmented, userId);
        saveMessage(chatId, "assistant", reply);
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } else {
        // streaming path — words appear as they generate (no tool calls)
        reply = await chatStream(augmented, bot, chatId);
        saveMessage(chatId, "assistant", reply);
      }

      // Auto-extract facts in background (non-blocking, silent)
      autoExtractAndSave(text, reply, (h) => chat(h)).catch(() => {});

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

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Split a long string into Telegram-safe chunks */
function splitMessage(text, maxLen = 4000) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cut = remaining.lastIndexOf("\n", maxLen);
    const pos  = cut > 0 ? cut : maxLen;
    chunks.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  bot.stopPolling();
  dbClose();
  process.exit(0);
});