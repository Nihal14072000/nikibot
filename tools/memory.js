/**
 * tools/memory.js
 * Persistent memory stored as a human-readable MEMORY.md file.
 *
 * How it works:
 *  - MEMORY.md is read on every message and injected into the system prompt
 *  - When the user says "remember...", "note that...", "forget..." etc.
 *    the bot extracts and writes the fact automatically
 *  - Users can also use /remember and /forget commands explicitly
 *  - The file is plain Markdown — you can edit it manually on the server too
 */

import fs   from "fs";
import path from "path";

const MEMORY_PATH = path.resolve(process.env.MEMORY_PATH || "MEMORY.md");

// ─── Trigger phrases — auto-detect memory intent ───────────────────────────

const REMEMBER_TRIGGERS = [
  /^remember (that |this )?/i,
  /^note (that |this )?/i,
  /^keep in mind (that )?/i,
  /^don'?t forget (that )?/i,
  /^save (this|that|the fact that) ?/i,
  /^store (this|that|the fact that) ?/i,
  /^add to (my )?memory:?/i,
  /^memo:?/i,
  /\bremember this\b/i,
  /\bsave this\b/i,
  /\bnote this down\b/i,
];

const FORGET_TRIGGERS = [
  /^forget (that |this )?/i,
  /^remove from (my )?memory:?/i,
  /^delete (from )?(my )?memory:?/i,
  /^clear (the )?memory (about|for|on) /i,
];

const SHOW_TRIGGERS = [
  /^(show|list|what('?s| is) in) (my )?memory/i,
  /^what do you (know|remember) about me/i,
  /^(recall|show) (everything|all) (you know|stored)/i,
];

// ─── File I/O ──────────────────────────────────────────────────────────────

export function memoryExists() {
  return fs.existsSync(MEMORY_PATH);
}

export function readMemory() {
  if (!fs.existsSync(MEMORY_PATH)) return "";
  return fs.readFileSync(MEMORY_PATH, "utf8").trim();
}

export function writeMemory(content) {
  fs.writeFileSync(MEMORY_PATH, content.trim() + "\n", "utf8");
}

/**
 * Append a new entry under a section heading.
 * Creates the section if it doesn't exist.
 */
export function appendMemory(entry, section = "General") {
  let content = readMemory();

  // Create file from template if empty
  if (!content) {
    content = buildTemplate();
  }

  const sectionHeader = `## ${section}`;
  const timestamp     = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const line          = `- ${entry}  _(added ${timestamp})_`;

  if (content.includes(sectionHeader)) {
    // Insert after the section header
    content = content.replace(
      sectionHeader,
      `${sectionHeader}\n${line}`
    );
  } else {
    // Add new section at the bottom
    content = content.trimEnd() + `\n\n${sectionHeader}\n${line}`;
  }

  writeMemory(content);
  return line;
}

/**
 * Remove a line containing the given text from MEMORY.md
 * Returns true if something was removed.
 */
export function forgetMemory(query) {
  if (!fs.existsSync(MEMORY_PATH)) return false;

  const lines    = readMemory().split("\n");
  const lower    = query.toLowerCase();
  const filtered = lines.filter((l) => !l.toLowerCase().includes(lower));

  if (filtered.length === lines.length) return false; // nothing matched

  writeMemory(filtered.join("\n"));
  return true;
}

/**
 * Replace entire memory content (used by LLM-based update)
 */
export function replaceMemory(newContent) {
  writeMemory(newContent);
}

// ─── Intent detection ──────────────────────────────────────────────────────

export function detectMemoryIntent(text) {
  const t = text.trim();

  if (SHOW_TRIGGERS.some((r) => r.test(t)))   return { type: "show" };
  if (FORGET_TRIGGERS.some((r) => r.test(t))) return { type: "forget", text: t };
  if (REMEMBER_TRIGGERS.some((r) => r.test(t))) return { type: "remember", text: t };

  return { type: "none" };
}

/**
 * Ask the LLM to extract a clean fact from a raw "remember..." message.
 * Returns { fact, section } or null.
 */
export async function extractFact(userMessage, llmFn) {
  const prompt = `Extract the key fact the user wants to remember from this message.

User message: "${userMessage}"

Reply with ONLY a JSON object:
{"fact": "the clean fact to store", "section": "one of: Personal, Preferences, Work, Health, Goals, General"}

Rules:
- fact: concise, third-person if personal ("User's name is Raj", "User prefers dark mode")
- section: pick the most relevant category
- No explanation, just the JSON`;

  try {
    const raw   = await llmFn([{ role: "user", content: prompt }]);
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // Fallback: store the raw text under General
    return { fact: userMessage.replace(/^remember (that )?/i, "").trim(), section: "General" };
  }
}

/**
 * Ask the LLM to update MEMORY.md based on a conversation,
 * extracting any new facts automatically.
 */
export async function autoExtractAndSave(userMessage, assistantReply, llmFn) {
  const currentMemory = readMemory();

  const prompt = `You are a memory manager for a personal AI assistant.

Current memory file:
${currentMemory || "(empty)"}

New conversation:
User: ${userMessage}
Assistant: ${assistantReply}

If this conversation reveals any NEW personal facts worth remembering long-term
(name, location, job, preferences, habits, goals, important dates, etc.),
return the updated MEMORY.md content with the new facts added.

If nothing new is worth saving, reply with exactly: NO_UPDATE

Rules:
- Keep ALL existing content unchanged
- Only add genuinely useful long-term personal facts
- Do not add trivial, temporary, or task-specific info
- Format new entries as: - fact  _(added YYYY-MM-DD)_
- Reply with the full updated file content OR "NO_UPDATE"`;

  try {
    const result = await llmFn([{ role: "user", content: prompt }]);
    if (result.trim() === "NO_UPDATE") return false;
    writeMemory(result);
    return true;
  } catch {
    return false;
  }
}

// ─── Prompt injection ──────────────────────────────────────────────────────

/**
 * Build a system context string from MEMORY.md to prepend to every chat.
 */
export function buildMemoryContext() {
  const content = readMemory();
  if (!content) return "";

  return `[Persistent memory about the user — always keep this in mind]\n\n${content}\n\n[End of memory]`;
}

// ─── Template ──────────────────────────────────────────────────────────────

function buildTemplate() {
  const today = new Date().toISOString().split("T")[0];
  return `# 🧠 Assistant Memory

This file is automatically updated by your Telegram assistant.
You can also edit it manually — changes take effect on next message.

_Last updated: ${today}_

---

## Personal


## Preferences


## Work


## Health


## Goals


## General

`;
}

/**
 * Initialise MEMORY.md with empty template if it doesn't exist.
 */
export function initMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    writeMemory(buildTemplate());
    console.log(`📝  Memory file created at ${MEMORY_PATH}`);
  }
}
