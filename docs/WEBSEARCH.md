# 🔍 Web Search & Crawling

Your bot can search the web and read pages in real time.

---

## Setup — Get a Brave Search API Key

1. Go to [brave.com/search/api](https://brave.com/search/api/)
2. Click **Get Started for Free**
3. Sign up → create an app → copy your API key
4. Add to `.env`:
```env
BRAVE_API_KEY=BSA_your_key_here
SEARCH_AUTO=true
```
5. Restart: `sudo systemctl restart telegram-bot`

**Free tier:** 2,000 queries/month — more than enough for personal use.

---

## How It Works

### Auto Search (default)
The bot automatically decides when to search based on your message.

```
You: "What's the latest iPhone price?"
Bot: 🔍 searches web → answers with current data

You: "Write me a Python function to sort a list"
Bot: answers directly — no search needed
```

Auto-search uses a two-step detection:
1. **Fast keyword check** — looks for words like "latest", "today", "price", "news", "who is", etc.
2. **LLM intent check** — if unsure, asks the model "does this need a web search?"

### Manual Search
Force a search anytime with the `/search` command:

```
/search best budget laptops 2025
/search weather in Mumbai today
/search Node.js 22 release notes
```

### Page Crawling
Read and summarise any webpage:

```
/crawl https://example.com/article
/crawl https://docs.nodejs.org/en/latest
```
The bot fetches the page, strips ads/nav/scripts, and answers questions about the content.

---

## Commands

| Command | What it does |
|---|---|
| `/search <query>` | Force a web search and answer |
| `/crawl <url>` | Fetch a webpage and summarise it |

---

## Configuration

```env
# Required for search
BRAVE_API_KEY=BSA_your_key_here

# Auto-detect when to search (default: true)
# Set to false to only search via /search command
SEARCH_AUTO=true

# Number of search results to fetch per query (default: 5)
SEARCH_RESULTS=5

# Max characters extracted from a crawled page (default: 4000)
# Higher = more context but costs more tokens
CRAWL_MAX_CHARS=4000
```

---

## Usage Examples

### Current events
```
You: What happened in tech news today?
You: /search OpenAI latest announcement
```

### Research
```
You: /crawl https://some-article.com
Bot: [reads the article and summarises it]
You: What were the main conclusions?
Bot: [answers based on the crawled content]
```

### Price lookups
```
You: How much does a Hetzner VPS cost?
Bot: [auto-searches and answers with current pricing]
```

### Documentation
```
You: /crawl https://nodejs.org/en/docs/
You: How do I use the fs.watch API?
```

---

## RAM Impact

Adding web search costs essentially zero extra RAM:

| Component | RAM |
|---|---|
| Brave Search API call | ~0 MB (HTTP request) |
| cheerio HTML parser | ~15 MB (loaded on first crawl) |
| Crawled page text | ~1–2 MB temporary, freed after reply |
| **New total** | **~100 MB** |

Still well within the Oracle Cloud free tier.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `BRAVE_API_KEY not set` | Add your key to `.env` and restart |
| Search returns no results | Try a shorter, simpler query |
| Crawl fails with 403 | The site blocks bots — try a different URL |
| Crawl returns gibberish | JavaScript-heavy site — content is loaded dynamically and can't be crawled without a browser |
| Auto-search triggers too often | Set `SEARCH_AUTO=false` and use `/search` manually |
| Auto-search never triggers | Your queries might not match the keyword heuristic — use `/search` explicitly |

---

## Limitations

- **JavaScript-rendered pages** (React SPAs, Twitter, Instagram) can't be crawled — the bot only sees the raw HTML, not the rendered content
- **Paywalled content** can't be accessed
- **PDFs** are not supported for crawling (HTML only)
- **Rate limit:** 2,000 searches/month on Brave free tier (~67/day)
