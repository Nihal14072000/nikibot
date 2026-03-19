#!/usr/bin/env node
/**
 * tools/gmail-auth.js
 * Headless-friendly OAuth2 authorisation for Gmail.
 *
 * Works 3 ways — pick what suits your setup:
 *
 *  Method A (Recommended for headless VM):
 *    Run on your LOCAL laptop, upload token to server
 *
 *  Method B (SSH tunnel — no local Node needed):
 *    Port-forward VM:8765 → laptop:8765 via SSH, catch redirect automatically
 *
 *  Method C (Telegram — most seamless):
 *    Use /gmailauth command in your Telegram bot
 *    Bot sends you the URL, you open it, paste code back
 *
 * Usage:  node tools/gmail-auth.js
 */

import { google }    from "googleapis";
import readline      from "readline";
import http          from "http";
import fs            from "fs";
import path          from "path";
import { GMAIL_SCOPES } from "./gmail.js";

const CREDS_PATH  = path.resolve(process.env.GMAIL_CREDS_PATH || "gmail-credentials.json");
const TOKEN_PATH  = path.resolve(process.env.GMAIL_TOKEN_PATH || "gmail-token.json");
const LOCAL_PORT  = parseInt(process.env.GMAIL_AUTH_PORT || "8765", 10);

// ─── Colours ───────────────────────────────────────────────────────────────

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow= (s) => `\x1b[33m${s}\x1b[0m`;

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildAuth(redirectUri) {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      `gmail-credentials.json not found.\nSee docs/GMAIL.md for setup steps.`
    );
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  const { client_id, client_secret } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

async function saveAndVerify(auth, tokens) {
  auth.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  const gmail   = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });

  console.log(`\n  ${green("✔")}  Token saved → ${bold(TOKEN_PATH)}`);
  console.log(green(`  ✔  Connected as: ${profile.data.emailAddress}`));
  console.log(dim(`     Messages: ${profile.data.messagesTotal}`));
  console.log(`\n  ${bold("Restart your bot:")}  ${cyan("sudo systemctl restart telegram-bot")}\n`);
}

// ─── Method A — Copy-paste code (works on any machine) ─────────────────────

async function methodA() {
  console.log(`
  ${bold("Method A — Copy-paste code")}
  ${dim("Run this on your LOCAL laptop (not the VM).")}
  ${dim("Then SCP the token file to the server.")}
  `);

  const auth    = buildAuth("urn:ietf:wg:oauth:2.0:oob");
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    scope:       GMAIL_SCOPES,
    prompt:      "consent",
  });

  console.log(`  ${bold("1.")} Open this URL in your browser:\n`);
  console.log(`  ${cyan(authUrl)}\n`);
  console.log(`  ${bold("2.")} Sign in → Approve → Copy the code shown on screen\n`);

  const code = await ask("  Paste the code here: ");
  const { tokens } = await auth.getToken(code.trim());
  await saveAndVerify(auth, tokens);

  console.log(`  ${bold("3.")} Upload token to your VM:\n`);
  console.log(`  ${cyan(`scp gmail-token.json ubuntu@<your-vm-ip>:~/telegram-ai-bot/`)}\n`);
}

// ─── Method B — Local redirect server (auto-catches code) ──────────────────

async function methodB() {
  console.log(`
  ${bold("Method B — SSH tunnel + auto redirect")}
  ${dim("Best if you don't have Node on your laptop.")}
  `);

  const redirectUri = `http://localhost:${LOCAL_PORT}/oauth2callback`;
  const auth        = buildAuth(redirectUri);
  const authUrl     = auth.generateAuthUrl({
    access_type: "offline",
    scope:       GMAIL_SCOPES,
    prompt:      "consent",
  });

  console.log(`  ${bold("Step 1")} — In a NEW terminal on your laptop, run:\n`);
  console.log(`  ${cyan(`ssh -N -L ${LOCAL_PORT}:localhost:${LOCAL_PORT} ubuntu@<your-vm-ip>`)}\n`);
  console.log(`  ${dim("(keep that terminal open — it's the tunnel)")}\n`);
  console.log(`  ${bold("Step 2")} — Open this URL in your laptop browser:\n`);
  console.log(`  ${cyan(authUrl)}\n`);
  console.log(`  ${bold("Step 3")} — Approve access. The code will be caught automatically...\n`);

  await ask("  Press Enter when the SSH tunnel is ready and the URL is open: ");

  // Start local HTTP server to catch the redirect
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OAuth redirect (2 minutes)"));
    }, 120_000);

    const server = http.createServer((req, res) => {
      const url    = new URL(req.url, `http://localhost:${LOCAL_PORT}`);
      const code   = url.searchParams.get("code");
      const errMsg = url.searchParams.get("error");

      if (errMsg) {
        res.end(`<h2>Error: ${errMsg}</h2><p>Close this tab and try again.</p>`);
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${errMsg}`));
        return;
      }

      if (code) {
        res.end(`
          <html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2 style="color:green">✔ Authorised!</h2>
            <p>You can close this tab and return to your terminal.</p>
          </body></html>
        `);
        clearTimeout(timeout);
        server.close();
        resolve(code);
      }
    });

    server.listen(LOCAL_PORT, "localhost", () => {
      console.log(`  ${green("✔")}  Waiting for redirect on port ${LOCAL_PORT}...`);
    });
  });

  const { tokens } = await auth.getToken(code);
  await saveAndVerify(auth, tokens);
}

// ─── Method C — Manual code from URL bar ───────────────────────────────────

async function methodC() {
  console.log(`
  ${bold("Method C — Copy code from URL bar")}
  ${dim("Use when redirect_uri mismatch or OOB is not supported.")}
  ${dim("Open the URL on your phone or any device with a browser.")}
  `);

  // Use localhost redirect — Google will show "site can't be reached"
  // but the code is visible in the URL bar
  const redirectUri = `http://localhost:${LOCAL_PORT}/oauth2callback`;
  const auth        = buildAuth(redirectUri);
  const authUrl     = auth.generateAuthUrl({
    access_type: "offline",
    scope:       GMAIL_SCOPES,
    prompt:      "consent",
  });

  console.log(`  ${bold("1.")} Open this URL in your browser ${yellow("(phone works too)")}:\n`);
  console.log(`  ${cyan(authUrl)}\n`);
  console.log(`  ${bold("2.")} Sign in and approve access.`);
  console.log(`  ${bold("3.")} You'll see "This site can't be reached" — that's normal.`);
  console.log(`  ${bold("4.")} Look at the browser URL bar. Copy the value after ${bold("?code=")}`);
  console.log(`  ${dim("     It looks like: 4/0AX4XfWh...")}\n`);
  console.log(`  ${yellow("Tip:")} On mobile, tap the address bar to see the full URL\n`);

  const rawInput = await ask("  Paste the code (or full URL): ");

  // Accept either the raw code or the full redirect URL
  let code = rawInput.trim();
  if (code.includes("code=")) {
    try {
      const parsed = new URL(code);
      code = parsed.searchParams.get("code") || code;
    } catch {
      code = code.split("code=")[1]?.split("&")[0] || code;
    }
  }

  const { tokens } = await auth.getToken(code);
  await saveAndVerify(auth, tokens);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log(`
${bold(cyan("  ╔══════════════════════════════════════════════════╗"))}
${bold(cyan("  ║       Gmail Authorisation — Headless Setup       ║"))}
${bold(cyan("  ╚══════════════════════════════════════════════════╝"))}

  ${dim("You're on a headless Ubuntu VM — no browser needed here.")}
  ${dim("Choose the method that suits you best.")}
`);

  // Check credentials
  if (!fs.existsSync(CREDS_PATH)) {
    console.log(red("  ✖  gmail-credentials.json not found!\n"));
    console.log(`  ${bold("Quick setup:")}`);
    console.log(`  1. Go to ${cyan("https://console.cloud.google.com/")}`);
    console.log(`  2. Create project → Enable Gmail API`);
    console.log(`  3. OAuth consent screen → External → add your Gmail as Test User`);
    console.log(`  4. Credentials → Create OAuth Client ID → ${bold("Desktop app")}`);
    console.log(`  5. Download JSON → rename to ${bold("gmail-credentials.json")}`);
    console.log(`  6. Upload: ${cyan("scp gmail-credentials.json ubuntu@<vm-ip>:~/telegram-ai-bot/")}`);
    console.log(`\n  Full guide: ${cyan("docs/GMAIL.md")}\n`);
    process.exit(1);
  }

  if (fs.existsSync(TOKEN_PATH)) {
    console.log(`  ${green("✔")}  Existing token found at ${TOKEN_PATH}`);
    const ans = await ask("  Re-authorise? (y/N): ");
    if (!ans.trim().toLowerCase().startsWith("y")) {
      console.log(dim("  Keeping existing token.\n"));
      rl.close();
      return;
    }
    console.log();
  }

  console.log(`  Which method do you want to use?\n`);
  console.log(`  ${cyan("A)")} Run on my ${bold("laptop")} + SCP token to VM  ${dim("(simplest)")}`);
  console.log(`  ${cyan("B)")} ${bold("SSH tunnel")} — auto-catch redirect          ${dim("(no local Node needed)")}`);
  console.log(`  ${cyan("C)")} Copy code from ${bold("URL bar / phone")}             ${dim("(most flexible)")}`);
  console.log(`  ${cyan("T)")} Use ${bold("Telegram bot")} /gmailauth command         ${dim("(run from Telegram)")}\n`);

  const choice = await ask("  Choice (A/B/C/T): ");

  console.log();

  try {
    switch (choice.trim().toUpperCase()) {
      case "A": await methodA(); break;
      case "B": await methodB(); break;
      case "C":
      case "T": await methodC(); break;
      default:
        console.log(yellow("  Defaulting to Method C (URL bar)..."));
        await methodC();
    }
  } catch (err) {
    console.log(red(`\n  ✖  Failed: ${err.message}\n`));
    process.exit(1);
  }

  rl.close();
}

main().catch((err) => {
  console.error(red(`\nFatal: ${err.message}\n`));
  rl.close();
  process.exit(1);
});
