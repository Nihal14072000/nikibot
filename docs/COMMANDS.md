# 📋 Bot Commands Reference

All commands available in your Telegram bot.

---

## Commands

### `/start`
Shows the welcome message with a summary of available commands.

**When to use:** First time setup, or if you forgot what the bot can do.

---

### `/clear`
Wipes your entire conversation history for the current chat.

**When to use:**
- Starting a new topic and want a fresh context
- Bot seems confused from old conversation context
- Privacy — clearing sensitive past messages

> ⚠️ This is permanent. The conversation cannot be recovered after clearing.

---

### `/model`
Shows which AI provider and model is currently running.

**Example output:**
```
🧠 Provider: groq
📦 Model: llama3-8b-8192
```

**When to use:** To verify which model is answering you, especially after changing `.env`.

---

### `/queue`
Explains that messages are processed one at a time.

**When to use:** If the bot seems slow — a previous message might still be processing.

---

## Tips for Getting Better Responses

### Be specific
```
❌ "Summarize this"
✅ "Summarize this in 3 bullet points, focus on action items"
```

### Give context
```
❌ "Fix this code"
✅ "Fix this Node.js code — it throws 'cannot read property of undefined' on line 12"
```

### Ask for format
```
"Reply in plain text, no markdown"
"Give me a numbered list"
"Keep it under 3 sentences"
```

### Use it as a daily assistant
```
"Draft a reply to this email: [paste email]"
"Explain this error: [paste error]"
"Translate this to Hindi: [text]"
"What's wrong with this SQL query: [query]"
"Write a commit message for: added retry logic to API calls"
```

---

## Conversation Tips

- The bot remembers the **last 20 messages** — you can refer back to earlier things you said
- Use `/clear` when switching topics to avoid confusing the model with old context
- The bot processes messages **one at a time** — if it's slow, your previous message is still being answered
- If you get an error response, just **try again** — it's usually a temporary API blip

---

## Customizing the Assistant Personality

You can change how the bot behaves by editing `SYSTEM_PROMPT` in your `.env`:

```env
# Default
SYSTEM_PROMPT=You are a concise, helpful personal assistant.

# Examples:

# More personality
SYSTEM_PROMPT=You are a witty, direct assistant. Give short answers. Use dry humor occasionally.

# Developer focus
SYSTEM_PROMPT=You are a senior software engineer assistant. Prefer code examples over explanations. Use Node.js/Python by default.

# Strict brevity
SYSTEM_PROMPT=You are a personal assistant. Never use more than 3 sentences. No filler words.
```

Restart the bot after changing: `sudo systemctl restart telegram-bot`
