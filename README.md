# X/Twitter Watcher

> [!NOTE]
> This project was vibe coded. 🎵✨

A robust, TypeScript-based daemon for monitoring X (Twitter) accounts for live Spaces and new Tweets. It automatically downloads recordings, media, and screenshots, and seamlessly uploads them to Telegram using a local bot API.

## Features

- **Space Monitoring:** Detects when watched users go live, records the Space audio, and downloads metadata.
- **Tweet Monitoring:** Polls for new tweets and replies, downloads media, captures screenshots of the thread, and saves JSON metadata.
- **Telegram Integration:** Uploads all captured artifacts directly to Telegram topics, circumventing the 50MB file limit using a local bot API.
- **Resilient Polling:** Includes intelligent backoff, error handling, and Camoufox/`twspace-crawler` integration to bypass anti-bot mechanisms.
- **Nitter Integration:** Optional fallback to Nitter for tweet polling to bypass Twitter's aggressive rate limiting and anti-bot challenges.
- **Proxy Support:** Rotating HTTP/S proxy integration for both API requests and browser-based screenshot captures to prevent IP bans.
- **Database Backend:** Uses SQLite (via `better-sqlite3`) to maintain state, watchlists, and deduplication records.

## Setup Instructions

### 1. Prerequisites
- Node.js (>= 22.12)
- Python (>= 3.10) — runs [Camoufox](https://camoufox.com), the browser used for screenshots and Nitter
- ffmpeg on your `PATH` (Space recording)
- Docker (optional, but highly recommended for the Telegram Bot API server)

### 2. Installation
Clone the repository and install the Node and Python dependencies:
```bash
git clone <repo-url>
cd space-watcher
npm install
```

Camoufox is driven through its official Python package, installed into a project-local virtual environment:
```bash
python -m venv .venv
# Windows
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m camoufox fetch
# Linux / macOS
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m camoufox fetch
```
The watcher looks for Python in `CAMOUFOX_PYTHON`, then `.venv`, then your `PATH`. Without it everything still runs, just without screenshots.

### 3. Configuration
Copy the environment template and configure your tokens:
```bash
cp .env.example .env
```
Fill out the required tokens in `.env`. You can also run the interactive setup wizard:
```bash
npm run dev setup
```

### 4. Running the Watcher

The watcher can be run using the source code (for development) or the compiled code (for stability).

#### Using Source Code (Development)
```bash
# Foreground / Interactive mode
npm run dev:fg

# Background mode (runs the compiled code in dist/, so build first)
npm run build
npm run dev -- start
```

#### Using Compiled Code (Production)
```bash
npm run build

# Background mode (default)
npm run start

# Foreground / Interactive mode
npm run start:fg

# Stop / status
npm run stop
npm run status
```

> [!TIP]
> Prefer the `dev:fg` / `start:fg` scripts over `npm run start -- --foreground`: in PowerShell npm swallows the flag and the watcher silently starts in the background instead.

#### Starting clean after downtime
On start the watcher reports every tweet it has not seen yet, which after a long break can be a large backlog. To skip it and only get tweets posted from now on:
```bash
npm run catchup            # mark everything currently on the timelines as seen
# or in one go
npm run dev -- start --clean
```

#### Deleted tweets
Every tweet that was posted to Telegram is checked again later. When it has been deleted on X, a **🗑 Tweet deleted** notice goes to the `TELEGRAM_DELETED_THREAD_ID` topic (or, without one, the topic the tweet was posted in) with the tweet's text and a link to the copy that was saved in the group when it was posted.

- Tweets are checked hourly on their first day, twice a day in their first week, then every two days, for `DELETED_TWEET_CHECK_DAYS` days (default 30, `0` to turn it off). A tweet that disappears from the account's timeline is looked up right away.
- A deletion is reported only after two lookups, ten minutes apart, both found the tweet gone. Expect a notice within about an hour for a recent tweet, later for old ones.
- A failed or rate-limited request never counts as a deletion. A suspended, deactivated or private account produces one **⚠️ Account unavailable** notice instead of one per tweet.
- Only tweets posted after this feature was installed are tracked, and only with `DATA_SOURCE=twitter`.

## Running 24/7

### Health alerts
The watcher tells you in Telegram when it stops working, instead of going quiet:

- **⚠ Watcher problem** when the X API, Nitter, Spaces polling or screenshots have been failing for 15 minutes with no success in between (`HEALTH_ALERT_AFTER_MINUTES`), or when the tweet loop has not completed a cycle for 30 minutes. One message per outage, plus **✅ Recovered** when it works again.
- **💚 X Watcher is alive** once a day at 09:00 machine-local time (`HEALTH_DAILY_REPORT_HOUR`, `off` to disable) with uptime, what was posted, and success/failure counts per source.

`npm run status` shows open problems on its `Error:` line.

### Auto-restart on Windows
```bash
npm run build
npm run autostart:install    # also: autostart:status, autostart:remove
```
This registers a per-user scheduled task that checks every 5 minutes and starts the watcher if it is not running (crash, reboot, sign-in). It leaves the watcher alone after `npm run stop` until you start it again. The task only runs while you are signed in; enable "Start Docker Desktop when you sign in" for the local Telegram API.

### Linux server (systemd)
Tested on Ubuntu 24.04, including ARM64.
```bash
# build-essential/python3-dev/libzstd-dev: one Python dependency has no ARM wheel and is compiled by pip
sudo apt install -y ffmpeg python3-venv python3-dev build-essential libzstd-dev \
  libgtk-3-0t64 libx11-xcb1 libasound2t64 libdbus-glib-1-2 libxtst6 libpci3 fonts-liberation fonts-noto-color-emoji
npm ci && npm run build
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt && .venv/bin/python -m camoufox fetch
cp .env.example .env         # fill in tokens
docker compose up -d         # local Telegram API (restarts by itself)
./deploy/install-systemd.sh  # starts now and at boot, restarts after a crash
```
After that, manage it with `systemctl` (`status`, `restart`, `stop x-watcher`; logs via `journalctl -u x-watcher -f`) rather than `npm run start/stop`. Daily report times use the server's time zone.

> [!IMPORTANT]
> Run the watcher in one place only. Two copies with the same Telegram bot post everything twice and fight over bot commands. When moving from Windows to a server, run `npm run stop` and `npm run autostart:remove` on the Windows machine first.

## Docker Setup (Telegram Bot API)

To upload Space recordings or videos larger than 50MB, you must run a local Telegram Bot API server.

1. Obtain your API ID and API Hash from [my.telegram.org](https://my.telegram.org).
2. Edit `.env` to include `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.
3. Set `TELEGRAM_API_URL=http://127.0.0.1:9201` (the port `docker-compose.yml` publishes, bound to localhost only).
4. Start the Docker container:
```bash
docker compose up -d
```

If the local server is unreachable the watcher falls back to the public API (50MB limit).

## Advanced Configuration

### Screenshots

Screenshots are taken logged out by default and show the tweet plus the post it replies to. Set `SCREENSHOT_LOGGED_IN=true` to load pages with your X session instead, which shows the whole conversation above the tweet (full threads). This uses your account in an automated browser, so only enable it for an account you are comfortable using that way.

### Nitter Integration

If you encounter severe rate limits or blocks on the official Twitter API, you can switch to Nitter for tweet polling:
- Set `DATA_SOURCE=nitter` in your `.env`.
- Configure `NITTER_URL` with your preferred instance.
- Provide a comma-separated list of `NITTER_FALLBACK_URLS` for automatic failover if the primary instance is down.

### Proxy Support

To further enhance reliability and prevent IP-based banning:
- Set `PROXY_ENABLED=true` in your `.env`.
- Add your proxy URLs (format: `http://user:pass@host:port`) to `PROXY_LIST`, separated by commas.
- The system will automatically rotate through these proxies for scraping and screenshot operations.

## Documentation

- **[Runbook](./Runbook.md):** Detailed guide on operations, CLI commands, database migrations, and troubleshooting.
