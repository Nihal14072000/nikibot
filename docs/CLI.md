# ⚙️ CLI Operations

Run shell commands on your server directly from Telegram.

---

## Commands

### `/run <command>`
Execute an exact shell command.

```
/run df -h
/run free -h
/run uptime
/run sudo systemctl status telegram-bot
/run journalctl -u telegram-bot -n 20 --no-pager
/run git status
/run ping -c 3 google.com
```

---

### `/shell <natural language request>`
Describe what you want in plain English — the bot figures out the command.

```
/shell show disk usage
/shell how much memory is free
/shell restart the telegram bot service
/shell show last 20 log lines for telegram-bot
/shell check if the bot service is running
/shell what processes are using the most CPU
```

The bot shows you the command it plans to run **before** executing it, so you always know what's happening.

---

### `/sysinfo`
Instant server health snapshot — uptime, memory, disk, and CPU in one message.

```
/sysinfo
```

Example output:
```
📊 System Info

Uptime
 10:32:01 up 3 days,  2:14,  1 user,  load average: 0.01, 0.01, 0.00

Memory
               total   used   free
Mem:           947Mi   312Mi  421Mi
Swap:          0B      0B     0B

Disk
Filesystem     Size  Used  Avail  Use%
/dev/sda1       46G  3.2G   43G    7%

CPU
top - 10:32:01 up 3 days ...
%Cpu(s):  1.2 us,  0.3 sy ...
```

---

## Security Model

The bot has two modes:

### Allowlist Mode (default, recommended)
Only commands matching pre-approved patterns in `tools/cli.js` are allowed.

```env
ALLOW_ANY_COMMAND=false   # default
```

Pre-approved commands include:
- System info: `uptime`, `free -h`, `df -h`, `top -bn1`, `ps aux`
- Systemd: `sudo systemctl status/start/stop/restart <service>`
- Logs: `journalctl -u <service> -n <N> --no-pager`
- Network: `ping -c N <host>`, `curl -I <url>`
- Git (read-only): `git status`, `git log`, `git diff`
- File listing: `ls`, `cat` (restricted paths)
- Node/npm: `node -v`, `npm list`, `npm outdated`

**To allow a new command**, add a regex pattern to `ALLOWED_PATTERNS` in `tools/cli.js`:
```js
/^your-command-pattern$/,
```

---

### Any Command Mode (⚠️ opt-in, personal use only)
Allows any command that doesn't match the permanent blocklist.

```env
ALLOW_ANY_COMMAND=true
```

> Only use this if `ALLOWED_USER_IDS` is set to your own Telegram ID. Never enable this on a shared or public bot.

---

### Permanent Blocklist
These are **always blocked**, regardless of `ALLOW_ANY_COMMAND`:

| Pattern | Reason |
|---|---|
| `rm -rf` | Recursive delete |
| `curl ... \| bash` | Remote code execution |
| `dd if=` | Disk wipe |
| `mkfs` | Format filesystem |
| `fork bomb` | Crash the server |
| `sudo su / sudo -i` | Root shell escalation |
| `passwd` | Change passwords |
| `base64 -d \| bash` | Obfuscated execution |

---

## Audit Log

Every command execution is logged to `cli.log` in the bot directory:

```json
{"ts":"2025-01-15T10:32:01Z","userId":"123456789","command":"df -h","outcome":"ok","durationMs":43}
{"ts":"2025-01-15T10:33:12Z","userId":"123456789","command":"rm -rf /","outcome":"blocked","durationMs":0}
```

View recent commands:
```
/run cat ./cli.log
```

---

## Configuration

```env
# Allow only allowlisted commands (default, safest)
ALLOW_ANY_COMMAND=false

# Kill commands that take longer than this (ms)
CLI_TIMEOUT_MS=15000

# Truncate output to this many characters before sending to Telegram
CLI_MAX_OUTPUT=3000
```

---

## Examples by Use Case

### Monitor your bot
```
/sysinfo
/run sudo systemctl status telegram-bot
/run journalctl -u telegram-bot -n 50 --no-pager
```

### After deploying code changes
```
/run git status
/run git log --oneline -5
/run sudo systemctl restart telegram-bot
/run sudo systemctl status telegram-bot
```

### Server health check
```
/run uptime
/run free -h
/run df -h
/shell what processes are using the most memory
```

### Network debugging
```
/run ping -c 3 8.8.8.8
/run curl -Is https://api.openai.com
/run ip addr
```

---

## Limitations

- **No interactive commands** — `nano`, `vim`, `htop`, `ssh` etc. won't work (they need a TTY)
- **No long-running processes** — commands timeout after `CLI_TIMEOUT_MS` (default 15s)
- **Output truncated** — only first `CLI_MAX_OUTPUT` characters are sent (default 3000)
- **No piped stdin** — commands that wait for input will timeout
