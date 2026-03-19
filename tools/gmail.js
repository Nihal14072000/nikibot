/**
 * tools/gmail.js
 * Gmail integration via Google OAuth2 + Gmail REST API
 *
 * First-time setup:
 *   node tools/gmail-auth.js   ← run once to authorise
 *
 * Capabilities:
 *   - List / search emails
 *   - Read full email (decoded body)
 *   - Send new email
 *   - Reply to a thread
 *   - Archive / trash / mark read / mark unread / star
 *   - List labels
 */

import { google }  from "googleapis";
import fs          from "fs";
import path        from "path";

// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN_PATH       = path.resolve(process.env.GMAIL_TOKEN_PATH  || "gmail-token.json");
const CREDS_PATH       = path.resolve(process.env.GMAIL_CREDS_PATH  || "gmail-credentials.json");
const MAX_RESULTS      = parseInt(process.env.GMAIL_MAX_RESULTS || "10", 10);

// Gmail API scopes — covers read + send + modify
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

// ─── Auth ──────────────────────────────────────────────────────────────────

function loadCredentials() {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      `Gmail credentials not found at ${CREDS_PATH}.\n` +
      `Run: node tools/gmail-auth.js   to set up Gmail access.`
    );
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
}

function buildOAuth2Client() {
  const creds = loadCredentials();
  const { client_id, client_secret, redirect_uris } =
    creds.installed || creds.web;

  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
}

/**
 * Returns an authorised OAuth2 client.
 * Throws a descriptive error if the token is missing/expired.
 */
export function getAuthClient() {
  const auth = buildOAuth2Client();

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      "Gmail not authorised yet.\n" +
      "Run this on your server to connect Gmail:\n\n" +
      "  node tools/gmail-auth.js\n\n" +
      "Then follow the URL it prints."
    );
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  auth.setCredentials(token);

  // Auto-save refreshed tokens
  auth.on("tokens", (newTokens) => {
    if (newTokens.refresh_token) token.refresh_token = newTokens.refresh_token;
    token.access_token  = newTokens.access_token;
    token.expiry_date   = newTokens.expiry_date;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  });

  return auth;
}

export function getGmailClient() {
  return google.gmail({ version: "v1", auth: getAuthClient() });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Decode base64url encoded Gmail body */
function decodeBody(data) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8");
}

/** Recursively find text/plain or text/html part */
function extractBody(payload) {
  if (!payload) return "";

  // Direct body
  if (payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  // Multipart — prefer plain text
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    const html  = payload.parts.find((p) => p.mimeType === "text/html");
    const part  = plain || html;
    if (part) return extractBody(part);

    // Nested multipart
    for (const p of payload.parts) {
      const body = extractBody(p);
      if (body) return body;
    }
  }

  return "";
}

/** Get header value from message headers */
function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

/** Strip excessive whitespace / HTML tags for readable summaries */
function cleanText(text) {
  return text
    .replace(/<[^>]+>/g, " ")     // strip HTML tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}

// ─── Actions ───────────────────────────────────────────────────────────────

/**
 * List emails. query = Gmail search string (e.g. "is:unread", "from:boss@co.com")
 * Returns array of { id, threadId, subject, from, date, snippet, unread }
 */
export async function listEmails(query = "in:inbox", maxResults = MAX_RESULTS) {
  const gmail = getGmailClient();

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) return [];

  // Fetch headers for each message in parallel (metadata only — fast)
  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      })
    )
  );

  return details.map((res) => {
    const msg     = res.data;
    const headers = msg.payload?.headers ?? [];
    const unread  = (msg.labelIds ?? []).includes("UNREAD");

    return {
      id:       msg.id,
      threadId: msg.threadId,
      subject:  header(headers, "Subject") || "(no subject)",
      from:     header(headers, "From"),
      date:     header(headers, "Date"),
      snippet:  msg.snippet ?? "",
      unread,
    };
  });
}

/**
 * Read a full email by message ID.
 * Returns { id, threadId, subject, from, to, date, body }
 */
export async function readEmail(messageId) {
  const gmail = getGmailClient();

  const res = await gmail.users.messages.get({
    userId: "me",
    id:     messageId,
    format: "full",
  });

  const msg     = res.data;
  const headers = msg.payload?.headers ?? [];
  const body    = cleanText(extractBody(msg.payload));

  // Mark as read
  await gmail.users.messages.modify({
    userId: "me",
    id:     messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  }).catch(() => {}); // non-fatal

  return {
    id:       msg.id,
    threadId: msg.threadId,
    subject:  header(headers, "Subject") || "(no subject)",
    from:     header(headers, "From"),
    to:       header(headers, "To"),
    date:     header(headers, "Date"),
    body,
  };
}

/**
 * Send a new email.
 */
export async function sendEmail({ to, subject, body }) {
  const gmail = getGmailClient();

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\n");

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
}

/**
 * Reply to an existing thread.
 */
export async function replyToEmail(messageId, replyBody) {
  const gmail = getGmailClient();

  // Fetch original to get headers
  const original = await readEmail(messageId);

  const raw = [
    `To: ${original.from}`,
    `Subject: Re: ${original.subject.replace(/^Re:\s*/i, "")}`,
    `In-Reply-To: ${messageId}`,
    `References: ${messageId}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    replyBody,
    ``,
    `────────────────`,
    `On ${original.date}, ${original.from} wrote:`,
    original.body.split("\n").map((l) => `> ${l}`).join("\n"),
  ].join("\n");

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId: original.threadId },
  });
}

/**
 * Apply a label action to a message.
 * action: "archive" | "trash" | "read" | "unread" | "star" | "unstar"
 */
export async function modifyEmail(messageId, action) {
  const gmail = getGmailClient();

  const ACTIONS = {
    archive: { removeLabelIds: ["INBOX"] },
    trash:   { addLabelIds:    ["TRASH"], removeLabelIds: ["INBOX"] },
    read:    { removeLabelIds: ["UNREAD"] },
    unread:  { addLabelIds:    ["UNREAD"] },
    star:    { addLabelIds:    ["STARRED"] },
    unstar:  { removeLabelIds: ["STARRED"] },
  };

  if (!ACTIONS[action]) throw new Error(`Unknown action: ${action}`);

  await gmail.users.messages.modify({
    userId:      "me",
    id:          messageId,
    requestBody: ACTIONS[action],
  });
}

/**
 * Get unread count across inbox.
 */
export async function getUnreadCount() {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.list({
    userId:     "me",
    q:          "is:unread in:inbox",
    maxResults: 1,
  });
  // resultSizeEstimate gives approximate count
  return res.data.resultSizeEstimate ?? 0;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

export function formatEmailList(emails) {
  if (!emails.length) return "📭 No emails found.";

  return emails.map((e, i) => {
    const unread = e.unread ? "🔵 " : "   ";
    const from   = e.from.replace(/<[^>]+>/, "").trim();
    return `${unread}*${i + 1}.* ${e.subject}\n   _${from}_ · ${e.snippet.slice(0, 80)}`;
  }).join("\n\n");
}

export function formatEmailDetail(email) {
  return [
    `📧 *${email.subject}*`,
    `From: ${email.from}`,
    `Date: ${email.date}`,
    ``,
    email.body || "_(empty body)_",
  ].join("\n");
}
