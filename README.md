<div align="center">

# X/Twitter Watcher Framework

![Version](https://img.shields.io/badge/version-3.1-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

A robust, 24/7 automated monitoring and archival daemon for X (Twitter) Spaces AND Tweets. Designed for both personal desktop use and headless server deployments.

</div>

---

## 🚀 Features

* **Headless Daemon Mode:** Runs flawlessly in the background on bare-metal servers (Ubuntu/Debian) via PM2. Survives terminal closures and system reboots.
* **Full Tweet & Media Archiving:** Not just Spaces! Monitors timelines and automatically downloads tweets, JSON metadata, photos, and standardizes multi-video tweets into grouped Telegram albums.
* **Per-User Fine-Tuning:** Track original tweets only or include full reply threads (`watchReplies`) on a per-user basis. Uses static `rest_id` tracking so it doesn't break if a user changes their `@handle`.
* **Interactive Telegram Bot:** Add users, remove users, check system status, or `/delete` local storage directly from your phone.
* **Smart File Management & Auto-Delete:** Saves pristine `.m4a` audio files and `.txt` metadata. Optional `AUTO_DELETE_UPLOADED=true` to clean up server disk space immediately after a successful Telegram upload.
* **Auto-Refreshing Tokens:** Includes a Playwright-powered script to automatically launch a browser profile, extract fresh cookies, and update your configuration if your Twitter session drops.

---

## 🛠️ Installation

### Prerequisites
1. **Node.js** (v18 or higher)
2. **FFmpeg** (must be installed and accessible in your system `PATH`)
3. **Docker** (optional — only needed to bypass Telegram's 50MB upload limit)

### 1. Clone the repository
```bash
git clone https://github.com/zipppy3/x-space-watcher.git
cd x-space-watcher
npm install
```

### 2. Global Dependencies (For server deployments)
If you want to run this in the background 24/7, install PM2:
```bash
npm install -g pm2
pm2 startup
```

---

## ⚙️ Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

### Twitter Authentication
To download Spaces, you need active session cookies from an authenticated Twitter account.
1. Open your browser and log in to X.com.
2. Open Developer Tools (F12) -> Application (or Storage) -> Cookies.
3. Find the `auth_token` and `ct0` values.
4. Run the setup wizard to securely inject them:
```bash
node watcher.js setup
```

*(Alternatively, paste them directly into your `.env` file).*

### Telegram Notifications & Auto-Uploads (Optional)
During `node watcher.js setup`, you can provide a Telegram Bot Token and your Chat ID to enable push notifications to your phone.

If you are using a Telegram Group, you can also provide **Topic Thread IDs** to automatically upload the finished `.m4a` audio to one topic, and the `.txt` speakers metadata to another.

#### ⚠️ Bypassing Telegram's 50MB File Limit
The public Telegram Bot API rejects files larger than 50MB (which prevents 2+ hour Spaces from uploading). To bypass this and upload up to **2 GB**, a `docker-compose.yml` is included that runs a [Local Bot API Server](https://github.com/tdlib/telegram-bot-api) using the [`aiogram/telegram-bot-api`](https://hub.docker.com/r/aiogram/telegram-bot-api) Docker image.

1. Go to [`my.telegram.org`](https://my.telegram.org) and get your `API_ID` and `API_HASH`.
2. Add them to your `.env` file:
   ```env
   TELEGRAM_API_ID=12345
   TELEGRAM_API_HASH=abcdef1234567890
   ```
3. Start the local server:
   ```bash
   docker compose up -d
   ```
That's it! The watcher automatically routes file uploads through `http://127.0.0.1:8081`, bypassing the 50MB cloud limit entirely.

---

## 💻 Usage

The `watcher.js` CLI controls the entire application. 

### Commands

| Command | Description |
|---|---|
| `node watcher.js start` | Starts watching users (reads from your `watchlist.json`) |
| `node watcher.js start --id <space_id>` | Immediately downloads a specific active or recorded Space by ID |
| `node watcher.js add <username>` | Adds a user to watchlist (flags: `--tweets`, `--spaces`, `--replies`) |
| `node watcher.js update` | Automatically runs `git pull`, updates NPM packages, and patches downloads |
| `node watcher.js stop` | Safely stops the background daemon |
| `node watcher.js status` | Shows a clean overview of monitor status, uptime, and recent recordings |
| `node watcher.js switch` | Instantly swaps the watcher between Background PM2 and Foreground Interactive modes |
| `node watcher.js logs` | Live-tails the PM2 logs if running in the background |
| `node watcher.js setup` | Launches the interactive configuration wizard |

### Running 24/7

When you run `node watcher.js start`, the CLI will ask you to choose a mode:
1. **Minimalistic**: Disables all terminal colors and UI, hands the process to PM2, and runs silently in the background forever.
2. **Interactive**: Boots up exactly where you are, with colorful live timers and polling indicators.

You can bypass the prompt by passing `--minimal` or `--interactive` directly.

---

## 🔁 Automated Token Refresh (Local Machines Only)

Twitter actively expires session cookies. This repository includes `refresh_tokens.js`, which uses Playwright to maintain a persistent browser profile entirely within Node.js.

**First-time setup:**
```bash
npx playwright install chromium
node refresh_tokens.js --setup
```
*A visible browser will open. Log in to Twitter manually and close the browser. Your profile is saved in `.browser-profile/`.*

Now, whenever `watcher-core.js` detects a `401 Unauthorized` HTTP error, it will automatically run the javascript headless, fetch fresh cookies, and keep recording.

> **Note for Headless ARM Servers (e.g., Raspberry Pi, cheap VPS):** Playwright often fails to install Chrome binaries on ARM Linux. If you deploy there, rely on Telegram notifications to tell you when tokens expire, and run `node watcher.js update-tokens` to manually paste new ones.

---

## 📅 Monthly Auto-Update (Ubuntu/Linux)

Twitter frequently changes their internal API, which breaks open-source tools. This tool relies on the brilliant `twspace-crawler` library under the hood. To ensure you always have the latest fixes, set up the provided cron job:

```bash
chmod +x update.sh
crontab -e
```
Add this line to run the update on the 1st of every month at 3:00 AM:
`0 3 1 * * /path/to/x-space-watcher/update.sh >> /path/to/x-space-watcher/update.log 2>&1`

---

## ⚖️ License
This project is open-sourced under the MIT License. See `LICENSE` for details.
