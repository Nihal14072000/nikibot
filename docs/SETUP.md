# 🛠️ Setup Guide

Complete setup from zero to a running bot.

---

## Prerequisites

- [Node.js 20+](https://nodejs.org) installed
- A Telegram account
- One API key (Groq is free — recommended to start)

---

## Step 1 — Create your Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. `My Assistant`)
4. Choose a username (e.g. `myassistant_bot`) — must end in `bot`
5. Copy the token it gives you — looks like `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

> 💡 **Tip:** Also send `/setprivacy` → select your bot → `Disable` so it can read all messages in groups if needed later.

---

## Step 2 — Get your Telegram user ID

You'll need this to restrict the bot to only yourself.

1. Search for **@userinfobot** on Telegram
2. Send `/start`
3. Copy your numeric ID (e.g. `987654321`)

---

## Step 3 — Get an API key

### Option A — Groq (Free, fastest to start)
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up → API Keys → Create new key
3. Copy the key (starts with `gsk_`)

### Option B — OpenAI
1. Go to [platform.openai.com](https://platform.openai.com)
2. API Keys → Create new secret key
3. Add at least $5 credit (gpt-4o-mini is very cheap ~$0.01/100 messages)

### Option C — Anthropic
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create key
3. Add credit ($5 lasts a very long time with Haiku)

---

## Step 4 — Run the setup wizard

```bash
npm run setup
```

The wizard will ask for all keys interactively and write `.env` for you.
No manual file editing needed.

> 💡 If you prefer to configure manually: `cp .env.example .env` then edit it with a text editor.

---

## Step 5 — Install & run

```bash
npm install
npm start
```

You should see:
```
🤖  Bot started | provider=groq | model=llama3-8b-8192
🔒  Restricted to user IDs: 987654321
```

---

## Step 6 — Test it

1. Open Telegram
2. Find your bot by its username
3. Send `/start`
4. Send any message — it should reply!

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Missing TELEGRAM_BOT_TOKEN` | Check your `.env` file exists and has the token |
| `Missing API key for provider` | Make sure the right key is set for your chosen provider |
| Bot doesn't respond | Check `ALLOWED_USER_IDS` — make sure your ID is correct |
| `polling error` | Your token is wrong or already used by another instance |
| `Cannot find module` | Run `npm install` first |

---

## Next Steps

- 👉 [Deploy to Oracle Cloud 24/7](ORACLE_DEPLOY.md)
- 👉 [All available commands](COMMANDS.md)
- 👉 [Customize your assistant](CUSTOMIZATION.md)
