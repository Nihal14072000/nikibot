#!/usr/bin/env node
/**
 * setup.js — Interactive first-time setup wizard
 * Asks all config questions in the terminal and writes .env
 *
 * Usage:  node setup.js
 */

import fs   from "fs";
import path from "path";
import readline from "readline";

// ─── Colours ───────────────────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  white:  "\x1b[37m",
  bg:     "\x1b[44m",
};

const fmt = {
  bold:    (s) => `${c.bold}${s}${c.reset}`,
  dim:     (s) => `${c.dim}${s}${c.reset}`,
  green:   (s) => `${c.green}${s}${c.reset}`,
  yellow:  (s) => `${c.yellow}${s}${c.reset}`,
  cyan:    (s) => `${c.cyan}${s}${c.reset}`,
  red:     (s) => `${c.red}${s}${c.reset}`,
  blue:    (s) => `${c.blue}${s}${c.reset}`,
  header:  (s) => `\n${c.bold}${c.cyan}${s}${c.reset}`,
  step:    (n, s) => `${c.bold}${c.blue}[${n}]${c.reset} ${c.bold}${s}${c.reset}`,
  ok:      (s) => `  ${c.green}✔${c.reset}  ${s}`,
  skip:    (s) => `  ${c.dim}–  ${s}${c.reset}`,
  warn:    (s) => `  ${c.yellow}⚠${c.reset}  ${s}`,
  section: (s) => `\n${c.bold}${c.white}── ${s} ${"─".repeat(Math.max(0, 48 - s.length))}${c.reset}`,
};

// ─── Readline helpers ──────────────────────────────────────────────────────

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal = "") {
  const hint = defaultVal ? fmt.dim(` [${defaultVal}]`) : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${hint}: `, (ans) => {
      resolve(ans.trim() || defaultVal);
    });
  });
}

function askSecret(question) {
  // Hide input for API keys
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}: `);
    const stdin = process.stdin;
    let value = "";

    // Only hide if we're in a real TTY
    if (process.stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      const onData = (ch) => {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
        } else if (ch === "\u0003") {
          // Ctrl+C
          process.stdout.write("\n");
          process.exit();
        } else if (ch === "\u007f") {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      };
      stdin.on("data", onData);
    } else {
      // Non-TTY (piped input) — just read normally
      rl.question("", (ans) => resolve(ans.trim()));
    }
  });
}

async function choose(question, options) {
  console.log(`\n  ${fmt.bold(question)}`);
  options.forEach((opt, i) => {
    console.log(`  ${fmt.cyan(`${i + 1})`)} ${opt.label}  ${fmt.dim(opt.hint || "")}`);
  });
  while (true) {
    const ans = await ask(`  Choice`, "1");
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx].value;
    console.log(fmt.warn("Please enter a number from the list above."));
  }
}

async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const ans = await ask(`${question} ${fmt.dim(`(${hint})`)}`, defaultYes ? "y" : "n");
  return ans.toLowerCase().startsWith("y");
}

function separator() {
  console.log(fmt.dim(`\n  ${"─".repeat(52)}`));
}

// ─── Banner ────────────────────────────────────────────────────────────────

function banner() {
  console.clear();
  console.log(`
${c.cyan}${c.bold}  ╔══════════════════════════════════════════════════╗
  ║        Personal AI Assistant — Setup Wizard       ║
  ╚══════════════════════════════════════════════════╝${c.reset}

  Welcome! This wizard will create your ${fmt.bold(".env")} file.
  It takes about ${fmt.cyan("2 minutes")} to complete.

  ${fmt.dim("Press Ctrl+C at any time to cancel.")}
`);
}

// ─── Validators ────────────────────────────────────────────────────────────

function validateTelegramToken(t) {
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(t);
}

function validateOpenAIKey(k) { return k.startsWith("sk-"); }
function validateGroqKey(k)   { return k.startsWith("gsk_"); }
function validateAnthropicKey(k) { return k.startsWith("sk-ant-"); }
function validateBraveKey(k)  { return k.startsWith("BSA"); }

// ─── Main wizard ───────────────────────────────────────────────────────────

async function run() {
  banner();

  // Check if .env already exists
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    console.log(fmt.warn(".env file already exists."));
    const overwrite = await confirm("  Overwrite it?", false);
    if (!overwrite) {
      console.log(fmt.dim("\n  Setup cancelled. Your existing .env was not changed.\n"));
      process.exit(0);
    }
    console.log();
  }

  const config = {};

  // ── STEP 1: Telegram ──────────────────────────────────────
  console.log(fmt.step(1, "Telegram Bot Token"));
  console.log(fmt.dim(`
  To create a bot:
  1. Open Telegram → search @BotFather
  2. Send /newbot and follow the prompts
  3. Copy the token it gives you
`));

  while (true) {
    config.TELEGRAM_BOT_TOKEN = await askSecret("Paste your bot token");
    if (!config.TELEGRAM_BOT_TOKEN) {
      console.log(fmt.warn("Token cannot be empty."));
    } else if (!validateTelegramToken(config.TELEGRAM_BOT_TOKEN)) {
      console.log(fmt.warn("That doesn't look like a valid token (format: 123456:ABC-DEF...). Try again."));
    } else {
      console.log(fmt.ok("Token accepted."));
      break;
    }
  }

  separator();

  // ── STEP 2: Your Telegram user ID ─────────────────────────
  console.log(fmt.step(2, "Your Telegram User ID") + fmt.dim("  (to restrict bot to yourself)"));
  console.log(fmt.dim(`
  To find your ID:
  → Message @userinfobot on Telegram → it replies with your numeric ID
`));

  const userId = await ask("Your Telegram user ID (leave blank to allow everyone)");
  config.ALLOWED_USER_IDS = userId;
  if (userId) {
    console.log(fmt.ok(`Bot restricted to user ID: ${userId}`));
  } else {
    console.log(fmt.warn("No restriction set — anyone can use your bot."));
  }

  separator();

  // ── STEP 3: LLM Provider ──────────────────────────────────
  console.log(fmt.step(3, "AI Provider"));
  console.log(fmt.dim(`
  Choose where the AI responses come from.
  Groq is free and fastest — recommended if you're just starting out.
`));

  const provider = await choose("Which provider?", [
    { value: "openrouter", label: "OpenRouter",  hint: "Access 100+ models with one key — openrouter.ai" },
    { value: "groq",       label: "Groq",        hint: "Free tier, very fast — console.groq.com" },
    { value: "openai",     label: "OpenAI",      hint: "gpt-4o-mini ~$0.01/100 messages" },
    { value: "anthropic",  label: "Anthropic",   hint: "Claude Haiku ~$0.01/100 messages" },
  ]);
  config.PROVIDER = provider;

  console.log();

  if (provider === "openrouter") {
    console.log(fmt.dim("  Get a key at: https://openrouter.ai/keys\n"));
    console.log(fmt.dim("  OpenRouter gives access to 100+ models with one API key.\n"));

    const models = [
      { value: "minimax/minimax-m2.5",            label: "MiniMax M2.5",         hint: "Powerful, great for tasks" },
      { value: "meta-llama/llama-3.1-8b-instruct",label: "Llama 3.1 8B",         hint: "Fast, free tier available" },
      { value: "google/gemini-flash-1.5",          label: "Gemini Flash 1.5",     hint: "Fast and cheap" },
      { value: "openai/gpt-4o-mini",               label: "GPT-4o Mini",          hint: "Reliable, low cost" },
    ];

    while (true) {
      config.OPENAI_API_KEY = await askSecret("OpenRouter API key (sk-or-...)");
      if (!config.OPENAI_API_KEY) { console.log(fmt.warn("Key cannot be empty.")); continue; }
      if (!config.OPENAI_API_KEY.startsWith("sk-or-")) {
        console.log(fmt.warn("OpenRouter keys start with sk-or- — double-check your key."));
        const proceed = await confirm("  Use it anyway?", false);
        if (!proceed) continue;
      }
      console.log(fmt.ok("Key accepted."));
      break;
    }

    config.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    const modelChoice = await choose("Which model?", models);
    config.MODEL = modelChoice;
    console.log(fmt.dim(`  You can change this anytime in .env → MODEL=any/model-name`));

  } else if (provider === "groq") {
    console.log(fmt.dim("  Get a free key at: https://console.groq.com → API Keys\n"));

    const models = [
      { value: "llama3-8b-8192",          label: "llama3-8b-8192",          hint: "Default — fast and capable" },
      { value: "llama-3.1-70b-versatile", label: "llama-3.1-70b-versatile", hint: "Smarter, slightly slower" },
      { value: "mixtral-8x7b-32768",      label: "mixtral-8x7b-32768",      hint: "Great for long documents" },
      { value: "gemma2-9b-it",            label: "gemma2-9b-it",            hint: "Lightweight" },
    ];

    while (true) {
      config.GROQ_API_KEY = await askSecret("Groq API key");
      if (!config.GROQ_API_KEY) { console.log(fmt.warn("Key cannot be empty.")); continue; }
      if (!validateGroqKey(config.GROQ_API_KEY)) {
        console.log(fmt.warn("Groq keys start with gsk_ — double-check your key."));
        const proceed = await confirm("  Use it anyway?", false);
        if (!proceed) continue;
      }
      console.log(fmt.ok("Key accepted."));
      break;
    }

    config.MODEL = await choose("Which Groq model?", models);
    config.OPENAI_BASE_URL = "";

  } else if (provider === "openai") {
    console.log(fmt.dim("  Get a key at: https://platform.openai.com → API Keys\n"));

    const models = [
      { value: "gpt-4o-mini", label: "gpt-4o-mini", hint: "Best value — recommended" },
      { value: "gpt-4o",      label: "gpt-4o",      hint: "Most capable, higher cost" },
    ];

    while (true) {
      config.OPENAI_API_KEY = await askSecret("OpenAI API key");
      if (!config.OPENAI_API_KEY) { console.log(fmt.warn("Key cannot be empty.")); continue; }
      if (!validateOpenAIKey(config.OPENAI_API_KEY)) {
        console.log(fmt.warn("OpenAI keys start with sk- — double-check your key."));
        const proceed = await confirm("  Use it anyway?", false);
        if (!proceed) continue;
      }
      console.log(fmt.ok("Key accepted."));
      break;
    }

    config.MODEL = await choose("Which OpenAI model?", models);
    config.OPENAI_BASE_URL = "";

  } else if (provider === "anthropic") {
    console.log(fmt.dim("  Get a key at: https://console.anthropic.com → API Keys\n"));

    const models = [
      { value: "claude-haiku-4-5-20251001", label: "claude-haiku",  hint: "Fast, cheap — recommended" },
      { value: "claude-sonnet-4-6",         label: "claude-sonnet", hint: "More capable, higher cost" },
    ];

    while (true) {
      config.ANTHROPIC_API_KEY = await askSecret("Anthropic API key");
      if (!config.ANTHROPIC_API_KEY) { console.log(fmt.warn("Key cannot be empty.")); continue; }
      if (!validateAnthropicKey(config.ANTHROPIC_API_KEY)) {
        console.log(fmt.warn("Anthropic keys start with sk-ant- — double-check your key."));
        const proceed = await confirm("  Use it anyway?", false);
        if (!proceed) continue;
      }
      console.log(fmt.ok("Key accepted."));
      break;
    }

    config.MODEL = await choose("Which Anthropic model?", models);
    config.OPENAI_BASE_URL = "";
  }

  separator();

  // ── STEP 4: Web Search ────────────────────────────────────
  console.log(fmt.step(4, "Web Search") + fmt.dim("  (optional — lets bot search the internet)"));
  console.log(fmt.dim(`
  Uses Brave Search API — free tier: 2,000 searches/month.
  Get a key at: https://brave.com/search/api/
`));

  const wantsSearch = await confirm("Enable web search?");

  if (wantsSearch) {
    while (true) {
      config.BRAVE_API_KEY = await askSecret("Brave Search API key");
      if (!config.BRAVE_API_KEY) { console.log(fmt.warn("Key cannot be empty.")); continue; }
      if (!validateBraveKey(config.BRAVE_API_KEY)) {
        console.log(fmt.warn("Brave keys usually start with BSA — double-check your key."));
        const proceed = await confirm("  Use it anyway?", false);
        if (!proceed) continue;
      }
      console.log(fmt.ok("Key accepted."));
      break;
    }
    config.SEARCH_AUTO = "true";
    console.log(fmt.ok("Auto-search enabled — bot will search automatically when relevant."));
  } else {
    config.BRAVE_API_KEY = "";
    config.SEARCH_AUTO   = "false";
    console.log(fmt.skip("Web search skipped. You can add it later in .env."));
  }

  separator();

  // ── STEP 5: Personality ───────────────────────────────────
  console.log(fmt.step(5, "Assistant Personality"));
  console.log(fmt.dim(`
  This is the system prompt — it defines how the bot behaves.
  Press Enter to use the default.
`));

  const personality = await choose("Pick a personality template:", [
    { value: "default",   label: "Default",          hint: "Concise, helpful, direct" },
    { value: "developer", label: "Developer",         hint: "Code-focused, prefers examples" },
    { value: "custom",    label: "Custom",            hint: "Type your own" },
  ]);

  const prompts = {
    default:   "You are a concise, helpful personal assistant. Be direct and clear. No filler phrases.",
    developer: "You are a senior software engineer assistant. Default to Node.js and Python. Show code examples. Keep explanations short.",
  };

  if (personality === "custom") {
    config.SYSTEM_PROMPT = await ask("Enter your system prompt");
    if (!config.SYSTEM_PROMPT) config.SYSTEM_PROMPT = prompts.default;
  } else {
    config.SYSTEM_PROMPT = prompts[personality];
  }
  console.log(fmt.ok(`Personality set.`));

  separator();

  // ── STEP 6: Advanced (optional) ───────────────────────────
  console.log(fmt.step(6, "Advanced Settings") + fmt.dim("  (press Enter to keep defaults)"));
  console.log();

  const maxHistory = await ask("Max conversation history (messages to remember)", "20");
  config.MAX_HISTORY    = maxHistory || "20";
  config.CRAWL_MAX_CHARS = "4000";
  config.SEARCH_RESULTS  = "5";

  // ── STEP 7: CLI access ───────────────────────────────────
  console.log(fmt.step(7, "CLI Access") + fmt.dim("  (optional — run shell commands from Telegram)"));
  console.log(fmt.dim(`
  Lets you run commands on your server via /run, /shell, /sysinfo.
  By default only safe commands are allowed (allowlist mode).
`));

  const wantsCli = await confirm("Enable CLI command execution?");
  if (wantsCli) {
    const allowAny = await confirm("  Allow ANY command? " + fmt.yellow("(⚠️  only for personal single-user bots)"), false);
    config.ALLOW_ANY_COMMAND = allowAny ? "true" : "false";
    if (allowAny) {
      console.log(fmt.warn("Any command mode enabled. Make sure ALLOWED_USER_IDS is set."));
    } else {
      console.log(fmt.ok("Allowlist mode — only pre-approved commands will run."));
    }
  } else {
    config.ALLOW_ANY_COMMAND = "false";
    console.log(fmt.skip("CLI access disabled. You can enable it later in .env."));
  }
  config.CLI_TIMEOUT_MS = "15000";
  config.CLI_MAX_OUTPUT = "3000";

  separator();

  // ── Write .env ────────────────────────────────────────────
  separator();

  const envContent = buildEnv(config);
  fs.writeFileSync(envPath, envContent, "utf8");

  // ── Summary ───────────────────────────────────────────────
  console.log(`
${c.green}${c.bold}  ╔══════════════════════════════════════════════════╗
  ║              ✔  Setup Complete!                   ║
  ╚══════════════════════════════════════════════════╝${c.reset}

  ${fmt.bold(".env created with:")}

  ${fmt.ok(`Telegram bot:  configured`)}
  ${config.ALLOWED_USER_IDS
    ? fmt.ok(`Access:        restricted to user ${config.ALLOWED_USER_IDS}`)
    : fmt.warn(`Access:        open to everyone`)}
  ${fmt.ok(`Provider:      ${config.PROVIDER} (${config.MODEL})`)}
  ${config.OPENAI_BASE_URL ? fmt.ok(`Base URL:      ${config.OPENAI_BASE_URL}`) : ''}
  ${config.BRAVE_API_KEY
    ? fmt.ok(`Web search:    enabled (Brave)`)
    : fmt.skip(`Web search:    disabled`)}
  ${fmt.ok(`Memory:        last ${config.MAX_HISTORY} messages`)}

  ${fmt.bold("Next steps:")}

  ${fmt.cyan("1.")} ${fmt.bold("npm install")}          Install dependencies
  ${fmt.cyan("2.")} ${fmt.bold("npm start")}            Start the bot
  ${fmt.cyan("3.")} Open Telegram → find your bot → send ${fmt.bold("/start")}

  ${fmt.dim(`Your .env is at: ${envPath}`)}
  ${fmt.dim("Keep it private — it contains your API keys.")}
`);

  rl.close();
}

// ─── .env builder ──────────────────────────────────────────────────────────

function buildEnv(c) {
  const lines = [
    `# ── Generated by setup.js on ${new Date().toISOString()} ──`,
    ``,
    `# Telegram`,
    `TELEGRAM_BOT_TOKEN=${c.TELEGRAM_BOT_TOKEN}`,
    `ALLOWED_USER_IDS=${c.ALLOWED_USER_IDS || ""}`,
    ``,
    `# LLM Provider`,
    `PROVIDER=${c.PROVIDER}`,
    `MODEL=${c.MODEL}`,
  ];

  if (c.OPENAI_API_KEY)    lines.push(`OPENAI_API_KEY=${c.OPENAI_API_KEY}`);
  if (c.OPENAI_BASE_URL)   lines.push(`OPENAI_BASE_URL=${c.OPENAI_BASE_URL}`);
  if (c.GROQ_API_KEY)      lines.push(`GROQ_API_KEY=${c.GROQ_API_KEY}`);
  if (c.ANTHROPIC_API_KEY) lines.push(`ANTHROPIC_API_KEY=${c.ANTHROPIC_API_KEY}`);

  lines.push(
    ``,
    `# Assistant`,
    `SYSTEM_PROMPT=${c.SYSTEM_PROMPT}`,
    `MAX_HISTORY=${c.MAX_HISTORY}`,
    ``,
    `# Web Search`,
    `BRAVE_API_KEY=${c.BRAVE_API_KEY || ""}`,
    `SEARCH_AUTO=${c.SEARCH_AUTO}`,
    `CRAWL_MAX_CHARS=${c.CRAWL_MAX_CHARS}`,
    `SEARCH_RESULTS=${c.SEARCH_RESULTS}`,
  );

  return lines.join("\n") + "\n";
}

// ─── Run ───────────────────────────────────────────────────────────────────

run().catch((err) => {
  console.error(fmt.red(`\n  Error: ${err.message}\n`));
  rl.close();
  process.exit(1);
});
