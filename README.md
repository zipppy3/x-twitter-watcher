# X/Twitter Watcher

> [!NOTE]
> This project was vibe coded. 🎵✨

A robust, TypeScript-based daemon for monitoring X (Twitter) accounts for live Spaces and new Tweets. It automatically downloads recordings, media, and screenshots, and seamlessly uploads them to Telegram using a local bot API.

## Features

- **Space Monitoring:** Detects when watched users go live, records the Space audio, and downloads metadata.
- **Tweet Monitoring:** Polls for new tweets and replies, downloads media, captures screenshots of the thread, and saves JSON metadata.
- **Telegram Integration:** Uploads all captured artifacts directly to Telegram topics, circumventing the 50MB file limit using a local bot API.
- **Resilient Polling:** Includes intelligent backoff, error handling, and `camoufox-js`/`twspace-crawler` integration to bypass anti-bot mechanisms.
- **Nitter Integration:** Optional fallback to Nitter for tweet polling to bypass Twitter's aggressive rate limiting and anti-bot challenges.
- **Proxy Support:** Rotating HTTP/S proxy integration for both API requests and browser-based screenshot captures to prevent IP bans.
- **Database Backend:** Uses SQLite (via `better-sqlite3`) to maintain state, watchlists, and deduplication records.

## Setup Instructions

### 1. Prerequisites
- Node.js (>= 22.0.0)
- npm or yarn
- Docker (optional, but highly recommended for the Telegram Bot API server)

### 2. Installation
Clone the repository and install dependencies:
```bash
git clone <repo-url>
cd space-watcher/v2
npm install
```

### 3. Configuration
Copy the environment template and configure your tokens:
```bash
cp .env.example .env
```
Fill out the required tokens in `.env`. You can also run the interactive setup wizard:
```bash
npm run dev setup
```

#### 4. Running the Watcher

The watcher can be run using the source code (for development) or the compiled code (for stability).

#### Using Source Code (Development)
Good for testing changes immediately.
```bash
# Foreground / Interactive mode
npm run dev -- start --foreground

# Background mode
npm run dev -- start
```

#### Using Compiled Code (Production)
Recommended for daily use. Ensure you build first.
```bash
npm run build

# Background mode (default)
npm run start

# Foreground / Interactive mode
npm run start -- --foreground
```

> [!TIP]
> Use the `--` separator when running via `npm run` to ensure flags like `--foreground` are passed correctly to the application.

## Docker Setup (Telegram Bot API)

To upload Space recordings or videos larger than 50MB, you must run a local Telegram Bot API server.

1. Obtain your API ID and API Hash from [my.telegram.org](https://my.telegram.org).
2. Edit `.env` to include `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.
3. Set `TELEGRAM_API_URL=http://127.0.0.1:8081`.
4. Start the Docker container:
```bash
docker compose up -d
```

## Advanced Configuration

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
