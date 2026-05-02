<div align="center">

# X/Twitter Watcher Framework (v2)

![Version](https://img.shields.io/badge/version-2.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

A robust, 24/7 automated monitoring and archival daemon for X (Twitter) Spaces AND Tweets. Designed with stealth parsing and built for both personal desktop storage and headless server deployments.

*Disclosure: This project is vibecoded.*

</div>

---

## 🚀 Features

* **Vibecoded Architecture:** Completely rewritten in TypeScript with a hardened SQLite backend (`better-sqlite3`), dropping fragile JSON states for rigid concurrency.
* **Stealth Screenshot Archiving:** Utilizes `camoufox-js` to bypass Twitter's aggressive Cloudflare WAF protections. Prevents 503 errors and fingerprinting blocks while scraping timelines.
* **Dynamic GraphQL Resolver:** Automatically fetches live `.js` frontend bundles to extract the latest internal Twitter Query IDs, making it immune to arbitrary 404 endpoint changes.
* **Headless Daemon Mode:** Runs flawlessly in the background using native detached Node processes. Survives terminal closures and system reboots without requiring third-party tools like PM2.
* **Full Tweet & Media Archiving:** Monitors timelines and automatically downloads tweets, JSON metadata, photos, and standardizes multi-video tweets into grouped Telegram albums.
* **Interactive Telegram Bot:** Add users, remove users, check system status, or `/delete` local storage directly from your phone.
* **Auto-Refreshing Tokens:** Includes a Playwright-powered script to automatically launch a browser profile, extract fresh cookies, and completely update your configuration if your Twitter session drops organically without skipping a beat.

---

## 🛠️ Installation

### Prerequisites
1. **Node.js** (v22 or higher recommended)
2. **FFmpeg** (must be installed and accessible in your system `PATH`)
3. **Docker** (optional — only needed to bypass Telegram's 50MB upload limit)

### 1. Clone the repository
```bash
git clone https://github.com/zipppy3/x-space-watcher.git
cd x-space-watcher/v2
npm install
npm run build
```

---

## ⚙️ Configuration & Usage

The application provides a built-in CLI wizard to handle all configuration for you. Ensure you are running these commands inside the `v2/` directory!

### 1. Initial Setup
Run the setup wizard to easily securely inject your tokens:
```bash
npm run start setup
```
1. It will ask for your Twitter `auth_token` and `ct0` cookies (grabbed from X.com Developer Tools -> Application -> Cookies).
2. It will prompt for your Telegram Bot tokens and Chat IDs.
3. It will securely output everything to your local `.env`.

### 2. Auto-Token Refresh (Important!)
To ensure the watcher can heal itself when Twitter forcefully expires your cookies, you must create a persistent browser profile manually once:
```bash
npx playwright install chromium
node refresh_tokens.js --setup
```
*A visible browser will open. Log in to Twitter manually and close the browser. Your encrypted session will be saved securely in `.browser-profile/`.*

### 3. Start Watching!
To launch the daemon, just run:
```bash
npm run start
```
The CLI will ask you to choose a mode:
1. **Minimalistic**: Disconnects from the terminal and runs silently in the background forever.
2. **Interactive**: Boots up locally in your foreground with full live log outputs.

### Additional Commands

| Command | Description |
|---|---|
| `npm run start` | General command to launch the app |
| `npm run start add <username>` | Adds a user to watchlist (flags: `--tweets`, `--spaces`, `--replies`) |
| `npm run start stop` | Safely stops the background daemon |
| `npm run start status` | Shows an overview of monitor status, uptime, and database records |
| `npm run start switch` | Instantly swaps the watcher between Background detached and Foreground modes |
| `npm run start update` | Automatically runs `git pull`, updates packages, and installs browsers |
| `npm run start update-tokens` | Manually overwrites your Twitter cookies in `.env` |

---

## 💬 Telegram Notifications & 50MB Bypass

During `setup`, you can map specific **Topic Thread IDs** inside a Telegram Group to neatly organize your Spaces Audio, Metadata, and Tweet Screenshots.

### ⚠️ Bypassing Telegram's 50MB File Limit
The public Telegram Bot API rejects files larger than 50MB (breaking lengthy Spaces backups). We include a config to connect to a Local Bot API Server.

1. Go to [`my.telegram.org`](https://my.telegram.org) and get your `API_ID` and `API_HASH`.
2. Provide them during the `npm run start setup` wizard.
3. Drop a `docker-compose.yml` configured for `aiogram/telegram-bot-api` in your directory and start the local server:
   ```bash
   docker compose up -d
   ```
The watcher automatically routes files up to 2GB through `http://127.0.0.1:8081`.

---

## ⚖️ License
This project is open-sourced under the MIT License. See `LICENSE` for details.
