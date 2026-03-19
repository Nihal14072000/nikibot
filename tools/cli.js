/**
 * tools/cli.js
 * Safe shell command execution for the personal assistant bot.
 *
 * Security model:
 *  - Commands only run if they match the ALLOWED_COMMANDS allowlist OR
 *    if ALLOW_ANY_COMMAND=true in .env (opt-in, personal use only)
 *  - Hard timeout per command (default 15s)
 *  - Output truncated to avoid flooding Telegram
 *  - Full audit log written to cli.log
 */

import { exec }   from "child_process";
import { promisify } from "util";
import fs            from "fs";
import path          from "path";

const execAsync = promisify(exec);

// ─── Config ────────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS  = parseInt(process.env.CLI_TIMEOUT_MS  || "15000", 10);
const MAX_OUTPUT_CHARS= parseInt(process.env.CLI_MAX_OUTPUT  || "3000",  10);
const ALLOW_ANY       = process.env.ALLOW_ANY_COMMAND === "true";
const LOG_PATH        = path.resolve("cli.log");

// ─── Allowlist ─────────────────────────────────────────────────────────────
//
// Each entry is a RegExp tested against the full command string.
// Extend this list to allow more commands.
// Only used when ALLOW_ANY_COMMAND=false (the default).

export const ALLOWED_PATTERNS = [
  // System info
  /^(uptime|date|whoami|hostname|uname( -[a-z]+)?)$/,
  /^(df|df -h|df -hT)$/,
  /^free( -[a-z]+)?$/,
  /^top -bn1$/,
  /^ps aux$/,
  /^(ifconfig|ip addr|ip route)$/,

  // Systemd service management
  /^sudo systemctl (status|start|stop|restart|enable|disable) [\w\-.]+$/,
  /^systemctl (status|is-active|is-enabled) [\w\-.]+$/,
  /^journalctl -u [\w\-.]+ ?(-n \d+)?( --no-pager)?$/,

  // Node / npm
  /^node -v$/,
  /^npm (list|outdated|audit)( --depth=\d+)?$/,

  // File listing (no sensitive dirs)
  /^ls( -[a-zA-Z]+)? (\/home\/\w+[\w\/]*|\.\/[\w\/]*)$/,
  /^cat (\.\/[\w\/.]+)$/,
  /^pwd$/,

  // Network
  /^ping -c \d+ [\w.\-]+$/,
  /^curl -Is? https?:\/\/[\w.\-\/?=&]+$/,

  // Git (read-only)
  /^git (status|log --oneline( -\d+)?|diff|branch)$/,

  // Disk / process
  /^du -sh [\w\/.\-]+$/,
  /^(kill|pkill) -\d+ \d+$/,
];

// ─── Dangerous pattern blocklist ───────────────────────────────────────────
// These are ALWAYS blocked, even if ALLOW_ANY_COMMAND=true

const BLOCKED_PATTERNS = [
  /rm\s+-rf/,                    // recursive delete
  />\s*\/etc\//,                 // overwrite system files
  /chmod\s+777/,                 // world-writable
  /curl.*\|\s*(bash|sh)/,        // remote code execution
  /wget.*\|\s*(bash|sh)/,
  /:(){ :|:& };:/,               // fork bomb
  /dd\s+if=/,                    // disk wipe
  /mkfs/,                        // format disk
  />\s*\/dev\/(sd|hd|nvme)/,     // overwrite disk
  /passwd/,                      // change passwords
  /sudo\s+su/,                   // elevate to root shell
  /sudo\s+-i/,
  /sudo\s+bash/,
  /base64\s+-d.*\|\s*(bash|sh)/, // obfuscated execution
  /eval\s*\(/,
];

// ─── Audit log ─────────────────────────────────────────────────────────────

function logCommand(cmd, userId, outcome, durationMs) {
  const entry = JSON.stringify({
    ts:         new Date().toISOString(),
    userId,
    command:    cmd,
    outcome,    // "ok" | "blocked" | "error" | "timeout"
    durationMs,
  });
  try {
    fs.appendFileSync(LOG_PATH, entry + "\n");
  } catch {
    // Non-fatal — don't crash the bot if logging fails
  }
}

// ─── Core executor ─────────────────────────────────────────────────────────

/**
 * Run a shell command safely.
 * Returns { stdout, stderr, exitCode, blocked, reason, durationMs }
 */
export async function runCommand(command, userId = "unknown") {
  const cmd = command.trim();
  const start = Date.now();

  // ── Block dangerous patterns unconditionally ──
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      logCommand(cmd, userId, "blocked", 0);
      return {
        blocked: true,
        reason:  "Command matches a dangerous pattern and is permanently blocked.",
        stdout:  "",
        stderr:  "",
        exitCode: null,
        durationMs: 0,
      };
    }
  }

  // ── Allowlist check (unless ALLOW_ANY_COMMAND=true) ──
  if (!ALLOW_ANY) {
    const allowed = ALLOWED_PATTERNS.some((p) => p.test(cmd));
    if (!allowed) {
      logCommand(cmd, userId, "blocked", 0);
      return {
        blocked: true,
        reason:  `Command not in allowlist.\n\nTo allow it, either:\n• Add a pattern to ALLOWED_PATTERNS in tools/cli.js\n• Or set ALLOW_ANY_COMMAND=true in .env (⚠️ personal use only)`,
        stdout:  "",
        stderr:  "",
        exitCode: null,
        durationMs: 0,
      };
    }
  }

  // ── Execute ──
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: 1024 * 512, // 512KB max buffer
    });

    const duration = Date.now() - start;
    logCommand(cmd, userId, "ok", duration);

    return {
      blocked:    false,
      stdout:     truncate(stdout),
      stderr:     truncate(stderr),
      exitCode:   0,
      durationMs: duration,
    };

  } catch (err) {
    const duration = Date.now() - start;
    const timedOut = err.killed || err.signal === "SIGTERM";
    const outcome  = timedOut ? "timeout" : "error";

    logCommand(cmd, userId, outcome, duration);

    return {
      blocked:    false,
      stdout:     truncate(err.stdout || ""),
      stderr:     truncate(err.stderr || err.message || "Unknown error"),
      exitCode:   err.code ?? 1,
      durationMs: duration,
      timedOut,
    };
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

function truncate(str) {
  const s = str.trim();
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n… (truncated, ${s.length} chars total)`;
}

/**
 * Format a command result as a Telegram message.
 */
export function formatResult(cmd, result) {
  if (result.blocked) {
    return `🚫 *Blocked*\n\`${cmd}\`\n\n${result.reason}`;
  }

  const parts = [`⚙️ \`${cmd}\``];

  if (result.timedOut) {
    parts.push(`\n⏱ *Timed out* after ${CMD_TIMEOUT_MS / 1000}s`);
  }

  if (result.stdout) {
    parts.push(`\n\`\`\`\n${result.stdout}\n\`\`\``);
  }

  if (result.stderr) {
    parts.push(`\n⚠️ stderr:\n\`\`\`\n${result.stderr}\n\`\`\``);
  }

  if (!result.stdout && !result.stderr) {
    parts.push("\n_(no output)_");
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    parts.push(`\n_exit code: ${result.exitCode} | ${result.durationMs}ms_`);
  } else {
    parts.push(`\n_${result.durationMs}ms_`);
  }

  return parts.join("");
}

/**
 * Ask the LLM to suggest a shell command for a natural-language request.
 * Returns the raw command string or null.
 */
export async function inferCommand(userRequest, llmFn) {
  const prompt = `The user wants to run a shell command on their Linux server (Ubuntu).
Translate their request into a single safe shell command.

User request: "${userRequest}"

Rules:
- Reply with ONLY the shell command, nothing else
- No explanation, no markdown, no backticks
- If the request is ambiguous or unsafe, reply with exactly: UNSAFE
- Prefer simple, readable commands
- Do not use pipes unless necessary`;

  try {
    const raw = await llmFn([{ role: "user", content: prompt }]);
    const cmd = raw.trim().replace(/^`|`$/g, "");
    if (cmd === "UNSAFE" || cmd.length === 0) return null;
    return cmd;
  } catch {
    return null;
  }
}
