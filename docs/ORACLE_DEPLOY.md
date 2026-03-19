# ☁️ Oracle Cloud Deployment

Run your bot 24/7 for free on Oracle Cloud's Always Free tier.

---

## Why Oracle Cloud?

| | Oracle Free Tier | Raspberry Pi |
|---|---|---|
| Cost | Free forever | ~$50 upfront |
| RAM | 947MB | 512MB–8GB |
| Uptime | 99.9% datacenter | Depends on your power/internet |
| Maintenance | None | Updates, SD card failures |
| Location | Global | Home only |

---

## Prerequisites

- Oracle Cloud account ([signup](https://cloud.oracle.com/free)) — free, needs a credit card for verification but won't be charged
- Your bot files ready (follow [SETUP.md](SETUP.md) first)
- SSH key pair

---

## Part 1 — Create the VM

1. Log into [Oracle Cloud Console](https://cloud.oracle.com)
2. Go to **Compute → Instances → Create Instance**
3. Configure:
   - **Name:** `telegram-bot`
   - **Image:** Ubuntu 22.04 (Canonical)
   - **Shape:** `VM.Standard.E2.1.Micro` (Always Free)
   - **SSH keys:** Upload your public key (`~/.ssh/id_rsa.pub`)
4. Click **Create**
5. Wait ~2 minutes for it to be `RUNNING`
6. Copy the **Public IP address**

---

## Part 2 — SSH in

```bash
ssh ubuntu@<your-public-ip>
# First time: type 'yes' to accept fingerprint
```

---

## Part 3 — Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Verify
node -v    # v20.x.x
npm -v     # 10.x.x
```

---

## Part 4 — Fix Oracle's firewall (important!)

Oracle blocks all outbound traffic by default. The bot needs outbound to reach Telegram and your LLM API.

```bash
# Allow all outbound traffic
sudo iptables -P OUTPUT ACCEPT
sudo iptables -P FORWARD ACCEPT

# Persist across reboots
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

---

## Part 5 — Upload your bot

**Option A — SCP from your local machine:**
```bash
# Run this on your LOCAL machine, not the server
scp -r ./telegram-ai-bot ubuntu@<your-ip>:~/
```

**Option B — Git clone (if you pushed to GitHub):**
```bash
# On the server
git clone https://github.com/yourname/telegram-ai-bot.git
```

**Option C — Create files directly on server:**
```bash
mkdir ~/telegram-ai-bot && cd ~/telegram-ai-bot
nano index.js       # paste your code
nano package.json   # paste package.json
nano .env.example   # paste .env.example
```

---

## Part 6 — Configure & test

```bash
cd ~/telegram-ai-bot
npm install

cp .env.example .env
nano .env   # fill in your tokens

# Quick test — Ctrl+C to stop after confirming it works
node index.js
```

Send a message to your bot on Telegram to confirm it replies.

---

## Part 7 — Set up systemd (24/7 service)

```bash
sudo nano /etc/systemd/system/telegram-bot.service
```

Paste:
```ini
[Unit]
Description=Telegram AI Personal Assistant
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/ubuntu/telegram-ai-bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
User=ubuntu
EnvironmentFile=/home/ubuntu/telegram-ai-bot/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot

# Verify it's running
sudo systemctl status telegram-bot
```

You should see `Active: active (running)` in green.

---

## Daily Management Commands

```bash
# View live logs (Ctrl+C to exit)
journalctl -u telegram-bot -f

# Restart after updating code
sudo systemctl restart telegram-bot

# Stop the bot
sudo systemctl stop telegram-bot

# Check memory usage
free -m

# Check CPU usage
top
```

---

## Updating the bot

```bash
cd ~/telegram-ai-bot

# Edit your files
nano index.js

# Restart to apply changes
sudo systemctl restart telegram-bot

# Confirm it came back up
sudo systemctl status telegram-bot
```

---

## RAM usage on E2.1.Micro

```
Total RAM:         947 MB
OS + system:      ~200 MB
Node.js bot:       ~85 MB
Free headroom:    ~660 MB ✅
```

You have plenty of room to add more features later.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond after deploy | Run `journalctl -u telegram-bot -f` and check for errors |
| `ECONNREFUSED` or network errors | Re-run the iptables commands in Part 4 |
| Bot stopped after VM reboot | Check `sudo systemctl status telegram-bot` — re-enable if needed |
| `.env` changes not taking effect | Run `sudo systemctl restart telegram-bot` |
| Out of memory errors | Unlikely at 85MB — check for runaway processes with `top` |
