# 🎨 Customization Guide

Make the assistant truly yours.

---

## 1. Personality & Tone

The most impactful change you can make. Edit `SYSTEM_PROMPT` in `.env`:

```env
# Concise and direct
SYSTEM_PROMPT=You are a sharp, direct personal assistant. Keep all replies under 5 sentences. No filler words, no "Certainly!", no "Great question!". Just answer.

# Developer assistant
SYSTEM_PROMPT=You are a senior software engineer. Default to Node.js and Python. Always show code examples. Point out edge cases and potential bugs.

# Friendly and warm
SYSTEM_PROMPT=You are a warm, supportive personal assistant named Aria. You remember context well and give thoughtful, personalized responses.

# Brutally honest
SYSTEM_PROMPT=You are a personal assistant who is always honest, even when uncomfortable. Never sugarcoat. Give your real opinion when asked.

# Language tutor
SYSTEM_PROMPT=You are a Hindi language tutor. Respond in both English and Hindi. Gently correct grammar mistakes. Explain idioms and cultural context.
```

---

## 2. Response Language

Want replies in your language? Add it to the system prompt:

```env
SYSTEM_PROMPT=You are a helpful personal assistant. Always reply in Hindi unless the user writes in English, then reply in English.
```

---

## 3. Memory Length

Control how much conversation history the bot remembers:

```env
# Default — good balance of memory vs token cost
MAX_HISTORY=20

# Longer memory (costs more tokens per API call)
MAX_HISTORY=50

# Shorter memory (cheaper, faster for simple Q&A)
MAX_HISTORY=10
```

---

## 4. Restricting Access

Only allow specific Telegram users:

```env
# Single user (just you)
ALLOWED_USER_IDS=123456789

# You + family member
ALLOWED_USER_IDS=123456789,987654321
```

Get any Telegram user's ID by sending a message to **@userinfobot**.

Leave blank to allow everyone (not recommended for a personal bot):
```env
ALLOWED_USER_IDS=
```

---

## 5. Model Tuning

Different models have different personalities. Mix and match:

```env
# Fastest responses (Groq free)
PROVIDER=groq
MODEL=llama3-8b-8192

# Most capable (for coding, analysis)
PROVIDER=openai
MODEL=gpt-4o

# Best instruction following
PROVIDER=anthropic
MODEL=claude-haiku-4-5-20251001
```

---

## 6. Useful System Prompt Templates

### Daily Personal Assistant
```
You are my personal assistant. Be concise and practical.
I am a software developer. I prefer code examples over explanations.
My timezone is IST (UTC+5:30). When I ask about time or dates, use IST.
Format code in markdown code blocks. Keep non-code replies brief.
```

### Research & Summarization
```
You are a research assistant. When I share articles or text, summarize the key points in bullet form.
Always cite the most important insight first. Flag anything that seems incorrect or outdated.
Ask clarifying questions before giving long answers.
```

### Writing & Editing
```
You are a writing assistant and editor. When I share text, improve clarity, fix grammar, and tighten the prose.
Match the original tone. Explain your changes briefly. Suggest alternatives rather than just replacing.
```

### Health & Fitness Tracker
```
You are a fitness and wellness assistant. Help me track workouts, meals, and habits.
Give data-driven advice. Be motivating but realistic. Keep a positive tone.
```

---

## 7. Applying Changes

After editing `.env`:

```bash
# On Oracle Cloud
sudo systemctl restart telegram-bot

# Locally
# Stop with Ctrl+C, then:
npm start
```

---

## 8. Multiple Bots

Want separate bots for different purposes (e.g. work vs personal)?

1. Create a new bot with **@BotFather** → `/newbot`
2. Copy the project to a new folder: `cp -r telegram-ai-bot work-bot`
3. Create a separate `.env` with different `SYSTEM_PROMPT` and `TELEGRAM_BOT_TOKEN`
4. Create a second systemd service: `telegram-work-bot.service`

Each bot runs independently, uses ~85MB RAM, and can have a completely different personality.

---

## 9. Conversation Starters

Train yourself to use the bot effectively with these prompts:

```
"Summarize: [paste text]"
"ELI5: [complex topic]"
"Review this code: [paste code]"
"Draft an email to [person] about [topic]"
"Pros and cons of [decision]"
"Translate to [language]: [text]"
"Debug this error: [paste error]"
"Write a regex that matches [description]"
"What's the difference between [A] and [B]?"
"Give me 5 alternatives to [thing]"
```
