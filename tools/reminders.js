/**
 * tools/reminders.js
 * Natural language reminders stored in SQLite.
 * A background interval checks every 30s and fires due reminders.
 *
 * Supports:
 *   "in 10 minutes call John"
 *   "at 6pm take medicine"
 *   "tomorrow at 9am standup meeting"
 *   "every day at 8am drink water"   (recurring)
 */

import { prepare, exec as dbExec } from "./db.js";

// ─── DB setup ──────────────────────────────────────────────────────────────

export function setupRemindersTable() {
  dbExec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      fire_at    INTEGER NOT NULL,   -- unix timestamp
      recur_secs INTEGER DEFAULT 0, -- 0 = one-shot, >0 = repeat interval
      fired      INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fire_at, fired);
  `);
}

// ─── Prepared statements (lazy init) ──────────────────────────────────────

let _insert, _getDue, _markFired, _reschedule, _listPending, _delete;

function stmts() {
  if (!_insert) {
    _insert     = prepare("INSERT INTO reminders (chat_id, user_id, message, fire_at, recur_secs) VALUES (?, ?, ?, ?, ?)");
    _getDue     = prepare("SELECT * FROM reminders WHERE fire_at <= ? AND fired = 0");
    _markFired  = prepare("UPDATE reminders SET fired = 1 WHERE id = ?");
    _reschedule = prepare("UPDATE reminders SET fire_at = fire_at + recur_secs WHERE id = ?");
    _listPending= prepare("SELECT * FROM reminders WHERE chat_id = ? AND fired = 0 ORDER BY fire_at ASC");
    _delete     = prepare("DELETE FROM reminders WHERE id = ? AND chat_id = ?");
  }
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export function addReminder(chatId, userId, message, fireAt, recurSecs = 0) {
  stmts();
  _insert.run(String(chatId), String(userId), message, fireAt, recurSecs);
}

export function getDueReminders() {
  stmts();
  return _getDue.all(Math.floor(Date.now() / 1000));
}

export function markFired(id) {
  stmts();
  _markFired.run(id);
}

export function rescheduleRecurring(id) {
  stmts();
  _reschedule.run(id);
}

export function listPending(chatId) {
  stmts();
  return _listPending.all(String(chatId));
}

export function deleteReminder(id, chatId) {
  stmts();
  _delete.run(id, String(chatId));
}

// ─── Natural language parser ───────────────────────────────────────────────

/**
 * Parse a natural language reminder string.
 * Returns { message, fireAt (unix), recurSecs } or null if unparseable.
 *
 * Examples:
 *   "in 10 minutes call John"         → 10 mins from now
 *   "in 2 hours check the oven"       → 2 hours from now
 *   "at 6pm take medicine"            → today at 6pm (or tomorrow if past)
 *   "at 6:30pm meeting"               → today at 6:30pm
 *   "tomorrow at 9am standup"         → tomorrow at 9am
 *   "every day at 8am drink water"    → daily recurring
 *   "every 2 hours check email"       → every 2 hours
 */
export function parseReminder(text) {
  const now     = Date.now();
  const nowSecs = Math.floor(now / 1000);
  let fireAt    = null;
  let recurSecs = 0;
  let message   = text.trim();

  // ── Recurring: "every day at X" ──
  const everyDayAt = text.match(/every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (everyDayAt) {
    recurSecs = 86400;
    fireAt    = nextOccurrence(parseInt(everyDayAt[1]), parseInt(everyDayAt[2] || "0"), everyDayAt[3]);
    message   = text.replace(/every\s+day\s+at\s+[\d:apm]+\s*/i, "").trim();
    return { message: message || text, fireAt, recurSecs };
  }

  // ── Recurring: "every N hours/minutes" ──
  const everyN = text.match(/every\s+(\d+)\s+(minute|min|hour|hr)s?/i);
  if (everyN) {
    const n    = parseInt(everyN[1]);
    const unit = everyN[2].toLowerCase();
    recurSecs  = unit.startsWith("h") ? n * 3600 : n * 60;
    fireAt     = nowSecs + recurSecs;
    message    = text.replace(/every\s+\d+\s+\w+\s*/i, "").trim();
    return { message: message || text, fireAt, recurSecs };
  }

  // ── Relative: "in N minutes/hours/days" ──
  const inN = text.match(/in\s+(\d+)\s+(second|sec|minute|min|hour|hr|day)s?/i);
  if (inN) {
    const n    = parseInt(inN[1]);
    const unit = inN[2].toLowerCase();
    const secs = unit.startsWith("s") ? n
               : unit.startsWith("m") ? n * 60
               : unit.startsWith("h") ? n * 3600
               : n * 86400;
    fireAt  = nowSecs + secs;
    message = text.replace(/in\s+\d+\s+\w+\s*/i, "").trim();
    return { message: message || text, fireAt, recurSecs };
  }

  // ── Tomorrow at X ──
  const tomorrowAt = text.match(/tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (tomorrowAt) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(to24h(parseInt(tomorrowAt[1]), tomorrowAt[3]), parseInt(tomorrowAt[2] || "0"), 0, 0);
    fireAt  = Math.floor(d.getTime() / 1000);
    message = text.replace(/tomorrow\s+at\s+[\d:apm]+\s*/i, "").trim();
    return { message: message || text, fireAt, recurSecs };
  }

  // ── At X (today or tomorrow if past) ──
  const atTime = text.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atTime) {
    fireAt  = nextOccurrence(parseInt(atTime[1]), parseInt(atTime[2] || "0"), atTime[3]);
    message = text.replace(/at\s+[\d:apm]+\s*/i, "").trim();
    return { message: message || text, fireAt, recurSecs };
  }

  return null; // couldn't parse
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function to24h(hour, meridiem) {
  if (!meridiem) return hour; // assume 24h
  const m = meridiem.toLowerCase();
  if (m === "am") return hour === 12 ? 0 : hour;
  if (m === "pm") return hour === 12 ? 12 : hour + 12;
  return hour;
}

function nextOccurrence(hour, minute, meridiem) {
  const h   = to24h(hour, meridiem);
  const now = new Date();
  const t   = new Date();
  t.setHours(h, minute, 0, 0);
  // If time already passed today, schedule for tomorrow
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.floor(t.getTime() / 1000);
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatFireAt(fireAt) {
  return new Date(fireAt * 1000).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.TIMEZONE || "Asia/Kolkata",
  });
}

export function formatReminderList(reminders) {
  if (!reminders.length) return "📭 No pending reminders.";
  return reminders
    .map((r, i) =>
      `*${i + 1}.* ${r.message}\n   ⏰ ${formatFireAt(r.fire_at)}${r.recur_secs ? "  🔁 recurring" : ""}`
    )
    .join("\n\n");
}

// ─── Background checker ────────────────────────────────────────────────────

/**
 * Start the reminder background loop.
 * Calls onFire(reminder) for each due reminder.
 */
export function startReminderLoop(onFire, intervalMs = 30_000) {
  const check = async () => {
    try {
      const due = getDueReminders();
      for (const reminder of due) {
        try {
          await onFire(reminder);
        } catch (err) {
          console.error("Reminder fire error:", err.message);
        }
        if (reminder.recur_secs > 0) {
          rescheduleRecurring(reminder.id);
        } else {
          markFired(reminder.id);
        }
      }
    } catch (err) {
      console.error("Reminder loop error:", err.message);
    }
  };

  // Run immediately once, then on interval
  check();
  return setInterval(check, intervalMs);
}
