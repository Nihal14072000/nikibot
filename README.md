# 🤖 Telegram AI Assistant
**Personal AI assistant on Telegram — under 120MB RAM**

Supports OpenAI, Groq (free), and Anthropic as LLM providers.
Stores conversation history in SQLite. Zero external services needed.

---

## Quick Start

```bash
git clone <this-repo>
cd telegram-ai-bot
npm install      # install dependencies
npm run setup    # interactive wizard — configures everything
npm start        # run the bot
```

That's it. The setup wizard asks for all API keys step by step and writes your `.env` automatically — no manual file editing needed.

Full setup guide → [docs/SETUP.md](docs/SETUP.md)

That's it. Message your bot on Telegram.

---

## Providers

| Provider | Key env var | Free tier? | Recommended model |
|---|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | No (cheap) | `gpt-4o-mini` |
| **Groq** | `GROQ_API_KEY` | ✅ Yes | `llama3-8b-8192` |
| **Anthropic** | `ANTHROPIC_API_KEY` | No (cheap) | `claude-haiku-4-5-20251001` |

> **Groq is free** and extremely fast — great for getting started.
> Get a key at https://console.groq.com

---

## Commands (in Telegram)
| Command | Action |
|---|---|
| `/start` | Welcome message |
| `/clear` | Wipe conversation history |
| `/model` | Show current provider + model |

---

## RAM Usage
| Component | RAM |
|---|---|
| Node.js process | ~60 MB |
| SQLite (better-sqlite3) | ~15 MB |
| Telegram polling | ~10 MB |
| LLM (API call) | ~0 MB (cloud) |
| **Total** | **~85 MB** |

---

## Security — restrict to yourself
In `.env`, add your Telegram user ID (get it from @userinfobot):
```
ALLOWED_USER_IDS=123456789
```
The bot will reject anyone else.

---

## Run as a background service (systemd)

```ini
# /etc/systemd/system/telegram-bot.service
[Unit]
Description=Telegram AI Assistant
After=network.target

[Service]
WorkingDirectory=/home/youruser/telegram-ai-bot
ExecStart=/usr/bin/node index.js
Restart=always
EnvironmentFile=/home/youruser/telegram-ai-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now telegram-bot
```

---

## Project structure
```
telegram-ai-bot/
├── index.js              # Main bot logic
├── package.json
├── .env.example          # Copy to .env and fill in
├── history.db            # Auto-created on first run
└── docs/
    ├── SETUP.md          # Step-by-step local setup
    ├── ORACLE_DEPLOY.md  # Oracle Cloud deployment
    ├── COMMANDS.md       # All bot commands reference
    ├── PROVIDERS.md      # LLM provider comparison
    └── CUSTOMIZATION.md  # Personalize your assistant
```
