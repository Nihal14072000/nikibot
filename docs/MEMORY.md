# 🧠 Memory System

Your bot remembers things about you across conversations — forever.
Stored in a plain `MEMORY.md` file you can read and edit directly.

---

## How It Works

```
You say something  →  bot detects memory intent  →  MEMORY.md updated
                                                         ↓
Every future message  ←  MEMORY.md injected into prompt silently
```

Three layers of memory:

| Layer | What it does |
|---|---|
| **Explicit** | You say "remember that..." — bot saves it immediately |
| **Commands** | `/remember`, `/forget`, `/memory` for direct control |
| **Auto-extract** | After every reply, bot silently checks if anything new is worth saving |

---

## Natural Language (no commands needed)

Just talk to it naturally:

```
remember that my name is Raj
note that I prefer short answers
don't forget my timezone is IST
keep in mind I'm a backend developer
save this: I wake up at 6am
memo: allergic to peanuts
```

To remove something:
```
forget that I prefer short answers
forget dark mode
```

To see what's stored:
```
what do you know about me
show my memory
list everything stored
```

---

## Commands

### `/memory`
Show the full contents of `MEMORY.md`.

---

### `/remember <fact>`
Explicitly store a fact. The AI categorises it automatically.

```
/remember my name is Raj
/remember I work at a fintech startup
/remember I prefer Python over JavaScript
/remember my wife's name is Priya
/remember I'm trying to lose 5kg
/remember standup meeting every day at 10am IST
```

---

### `/forget <query>`
Remove all memory lines containing the query.

```
/forget dark mode
/forget standup
/forget 6am
```

---

### `/memoryclear`
Wipe the entire memory file. Asks for no confirmation — use carefully.

---

## MEMORY.md Structure

The file is organised into sections:

```markdown
# 🧠 Assistant Memory

## Personal
- User's name is Raj  _(added 2025-01-15)_
- User lives in Mumbai  _(added 2025-01-15)_

## Preferences
- User prefers concise bullet-point answers  _(added 2025-01-16)_
- User uses dark mode  _(added 2025-01-16)_

## Work
- User is a backend developer  _(added 2025-01-15)_
- User works with Node.js and PostgreSQL  _(added 2025-01-17)_

## Health
- User wakes up at 6am  _(added 2025-01-18)_
- User is allergic to peanuts  _(added 2025-01-18)_

## Goals
- User wants to learn Rust in 2025  _(added 2025-01-19)_

## General
- Standup meeting every day at 10am IST  _(added 2025-01-20)_
```

Sections: **Personal, Preferences, Work, Health, Goals, General**

---

## Editing MEMORY.md Manually

Since it's plain Markdown, you can edit it directly on the server:

```bash
nano ~/telegram-ai-bot/MEMORY.md
```

Or view it:
```bash
cat ~/telegram-ai-bot/MEMORY.md
```

Or via the bot's CLI:
```
/run cat ./MEMORY.md
```

Changes take effect on the very next message — no restart needed.

---

## Auto-extraction

After every conversation turn, the bot silently checks if anything
new was revealed that's worth saving long-term.

Examples of what gets auto-saved:
- You mention your job title in passing
- You say "I usually do X" or "I always prefer Y"
- You share a preference while asking for help

Examples of what does NOT get auto-saved:
- One-off tasks ("remind me to call John")
- Temporary context ("today I'm feeling tired")
- Search results or factual lookups

Auto-extraction runs in the background and never blocks your reply.

---

## Privacy

- `MEMORY.md` lives only on your server — never sent anywhere
- Only your LLM provider sees it (as part of the system prompt)
- You can inspect, edit, or delete it at any time
- Add to `.gitignore` if you push your bot to GitHub:
  ```
  MEMORY.md
  ```

---

## Example Workflow

```
Day 1:
  You: remember that I prefer dark mode and short answers
  Bot: 🧠 Got it! Saved to memory under Preferences.

Day 2 (new session, bot remembers nothing from chat history):
  You: what font should I use for my app?
  Bot: [answers with short bullet points in dark-mode context]
       (because it read your preferences from MEMORY.md)

Day 15:
  You: forget dark mode
  Bot: 🗑️ Removed from memory: "dark mode"

Anytime:
  You: what do you know about me?
  Bot: [shows full MEMORY.md contents]
```
