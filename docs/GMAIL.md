# 📧 Gmail Integration

Read, send, and manage your Gmail directly from Telegram.

---

## Setup (Headless Ubuntu VM — no browser needed)

### Step 1 — Create Google Cloud Credentials (do this on any browser)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. **Create a project** (or select existing) → any name
3. **APIs & Services → Enable APIs** → search **Gmail API** → Enable
4. **APIs & Services → OAuth consent screen**
   - Choose **External** → Create
   - Fill app name (anything), your email → Save and Continue through all steps
   - On **Test users** page → Add your Gmail address → Save
5. **APIs & Services → Credentials**
   - Create Credentials → **OAuth client ID**
   - Application type: **Desktop app** → Create
   - **Download JSON** → rename to `gmail-credentials.json`

### Step 2 — Upload credentials to your VM

```bash
# Run on your LOCAL machine:
scp gmail-credentials.json ubuntu@<your-vm-ip>:~/telegram-ai-bot/
```

### Step 3 — Authorise (pick one method)

---

#### Method 1 — Telegram (Easiest, recommended)

Just message your bot:
```
/gmailauth
```

The bot sends you a Google auth URL. Open it on your phone or laptop, approve access, Google shows you a code. Paste it back:
```
/gmailcode 4/0AX4XfWh...
```

Done. No SSH, no terminal, no laptop Node.js needed.

---

#### Method 2 — SSH tunnel (Auto-catches the redirect)

```bash
# On your LAPTOP — open a tunnel to the VM:
ssh -N -L 8765:localhost:8765 ubuntu@<your-vm-ip>

# On the VM — run the auth script:
node tools/gmail-auth.js
# Choose option B
```

The script prints a URL. Open it in your laptop browser. After you approve, the code is caught automatically.

---

#### Method 3 — Copy code from URL bar

```bash
node tools/gmail-auth.js
# Choose option C
```

Open the URL on your phone or laptop. After approving, you'll see "This site can't be reached" — that's normal. Look at the URL bar:
```
http://localhost:8765/oauth2callback?code=4/0AX4XfWh...&scope=...
```
Copy the value after `?code=` and paste it into the terminal.

---

#### Method 4 — Authorise on laptop, upload token

```bash
# On your LAPTOP (needs Node.js installed):
node tools/gmail-auth.js
# Choose option A
# Follow the prompts — saves gmail-token.json locally

# Then upload to VM:
scp gmail-token.json ubuntu@<your-vm-ip>:~/telegram-ai-bot/

# Restart bot on VM:
sudo systemctl restart telegram-bot
```

---

## Gmail Commands

### `/gmailauth`
Start the Gmail connection flow from Telegram. Sends you the Google auth URL.

### `/gmailcode <code>`
Complete the auth after pasting the code from Google.

### `/gmailauth_reset`
Disconnect Gmail and re-authorise a different account.

### `/inbox`
Show recent unread emails.
```
/inbox
/inbox from:boss@company.com
/inbox subject:invoice is:unread
/inbox is:starred
```

### `/read <number>`
Open a full email (use number from /inbox).
```
/read 1
/read 3
```

### `/reply <number> <text>`
Reply to an email.
```
/reply 1 Thanks, I'll get back to you tomorrow.
```

### `/send <to> | <subject> | <body>`
Send a new email.
```
/send john@example.com | Meeting | Hi, are you free at 3pm?
```

### Email Actions
```
/archive 2       Archive email 2
/trash 1         Move to trash
/star 3          Star email 3
/unstar 3        Remove star
/markread 1      Mark as read
/markunread 2    Mark as unread
```

### `/gmail <natural language>`
AI-powered — describe what you want:
```
/gmail show my unread emails from Alice
/gmail reply to the first email saying I am on leave
/gmail send an email to team@co.com about standup at 10am
/gmail archive all emails from newsletter
```

---

## Token Files

| File | Purpose | Keep private? |
|---|---|---|
| `gmail-credentials.json` | Google OAuth app credentials | Yes |
| `gmail-token.json` | Your access token (auto-refreshed) | Yes |

Add both to `.gitignore`:
```
gmail-credentials.json
gmail-token.json
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Gmail not set up yet" | Run `/gmailauth` in Telegram |
| "Token expired / invalid_grant" | Run `/gmailauth_reset` then `/gmailauth` |
| "Access blocked: app not verified" | Make sure your Gmail is added as a Test User in OAuth consent screen |
| Code expired | Codes last ~10 minutes — run `/gmailauth` again for a fresh link |
| "credentials not found" | SCP `gmail-credentials.json` to the bot folder first |
| Email body is garbled | HTML-only email — bot strips tags, may lose formatting |
