# 🧠 LLM Provider Guide

Choosing the right AI provider for your personal assistant.

---

## Quick Comparison

| Provider | Model | Cost | Speed | Quality | Free Tier |
|---|---|---|---|---|---|
| **Groq** | llama3-8b-8192 | Free | ⚡⚡⚡ Fastest | Good | ✅ Yes |
| **Groq** | llama-3.1-70b | Free | ⚡⚡ Fast | Very good | ✅ Yes |
| **OpenAI** | gpt-4o-mini | ~$0.01/100 msgs | ⚡⚡ Fast | Very good | ❌ |
| **OpenAI** | gpt-4o | ~$0.10/100 msgs | ⚡ Medium | Excellent | ❌ |
| **Anthropic** | claude-haiku | ~$0.01/100 msgs | ⚡⚡ Fast | Very good | ❌ |
| **Anthropic** | claude-sonnet | ~$0.05/100 msgs | ⚡ Medium | Excellent | ❌ |

---

## Groq — Best for Getting Started

Groq is **free** and extremely fast. Perfect for a personal bot.

```env
PROVIDER=groq
GROQ_API_KEY=gsk_your_key_here
MODEL=llama3-8b-8192
```

**Get a key:** [console.groq.com](https://console.groq.com)

**Rate limits (free tier):**
- 30 requests/minute
- 14,400 requests/day

For a personal bot (you typing normally), you'll never hit these.

**Available models:**
| Model | Best for |
|---|---|
| `llama3-8b-8192` | Fast everyday chat |
| `llama-3.1-70b-versatile` | Complex reasoning, coding |
| `mixtral-8x7b-32768` | Long documents, summaries |
| `gemma2-9b-it` | Lightweight, efficient |

---

## OpenAI — Best All-Round

Most reliable, widest capability, slight cost.

```env
PROVIDER=openai
OPENAI_API_KEY=sk-your_key_here
MODEL=gpt-4o-mini
```

**Get a key:** [platform.openai.com](https://platform.openai.com)

**Cost estimate for personal use:**
- 100 messages/day × 30 days = ~3,000 messages/month
- gpt-4o-mini: ~**$0.30/month**
- gpt-4o: ~**$3.00/month**

**Available models:**
| Model | Best for |
|---|---|
| `gpt-4o-mini` | Daily use, best value |
| `gpt-4o` | Complex tasks, coding |

---

## Anthropic — Best for Long Conversations

Great at following instructions precisely, nuanced replies.

```env
PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your_key_here
MODEL=claude-haiku-4-5-20251001
```

**Get a key:** [console.anthropic.com](https://console.anthropic.com)

**Available models:**
| Model | Best for |
|---|---|
| `claude-haiku-4-5-20251001` | Fast, cheap daily use |
| `claude-sonnet-4-6` | Best quality, heavier tasks |

---

## Switching Providers

Just update your `.env` and restart:

```bash
nano .env
# Change PROVIDER, API key, and MODEL

sudo systemctl restart telegram-bot
# or: npm start (local)
```

No code changes needed — the bot auto-adapts.

---

## Recommendation by Use Case

| You want... | Use |
|---|---|
| Free, just testing | Groq + llama3-8b |
| Best daily assistant | OpenAI gpt-4o-mini |
| Help with coding | OpenAI gpt-4o or Groq llama-3.1-70b |
| Long document analysis | Anthropic claude-haiku (200K context) |
| Absolute best quality | Anthropic claude-sonnet |
