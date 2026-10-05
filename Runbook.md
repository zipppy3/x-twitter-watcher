# Operations Runbook

This runbook covers day-to-day operations, database migrations, CLI usage, and troubleshooting for the X/Twitter Watcher.

## Commands Reference

The X Watcher provides two ways to control the system: a Command Line Interface (CLI) and a Telegram Bot.

### CLI Commands

Commands can be run using the source code (via `npm run dev -- <command>`) or the compiled code (via `node dist/cli.js <command>`).

> [!NOTE]
> `npm run start`, `npm run stop`, and `npm run status` are convenience shortcuts for the compiled daemon management.

| Command | Description | Arguments / Options |
| :--- | :--- | :--- |
| `start` | Starts the watcher daemon. | `--foreground` (Interactive mode), `--clean` (skip the backlog) |
| `stop` | Gracefully stops the running daemon (waits for it to exit). | - |
| `catchup` | Marks everything currently on the watched timelines as seen. | - |
| `ensure-running` | Starts the watcher if it is not running, unless it was stopped with `stop`. Used by the auto-restart task. | - |
| `status` | Shows uptime, watchlist stats, and activity. | - |
| `add` | Adds a user to the watchlist. | `<username> [--spaces] [--tweets] [--replies] [--no-media] [--no-screenshots] [--no-metadata]` |
| `remove` | Removes a user from the watchlist. | `<username>` |
| `config` | View or update user-specific save settings. | `<username> [--media on/off] [--screenshots on/off] [--metadata on/off]` |
| `list` | Lists all users in the watchlist. | - |
| `delete` | Deletes downloaded files for a user. | `<username> <spaces\|tweets\|all>` |
| `switch` | Switches a background daemon to foreground. | - |
| `setup` | Interactive first-time setup wizard. | - |
| `login` | Manual browser login to refresh tokens. | - |
| `update-tokens`| Update Twitter tokens in `.env`. | - |
| `update` | Pulls code, updates npm packages and Camoufox, rebuilds. | - |
| `export` | Exports watchlist to a JSON file. | `<path>` |
| `import` | Imports watchlist from a JSON file. | `<path>` |
| `backup` | Backs up the SQLite database. | `<path>` |
| `doctor` | System health and integrity check. | - |
| `cleanup` | Deletes recordings/files older than 30 days. | - |
| `migrate:v1` | Migrates data from v1 installation. | `--source-root <path>` |

### Telegram Commands

If configured, these commands can be sent directly to your Telegram bot:

| Command | Description | Example Usage |
| :--- | :--- | :--- |
| `/add` | Add a user to the watchlist. | `/add elonmusk tweets replies` |
| `/remove` | Remove a user from the watchlist. | `/remove elonmusk` |
| `/list` | List all users and their settings. | `/list` |
| `/config` | View or change save settings for a user. | `/config elonmusk media off` |
| `/status` | Show real-time watcher status. | `/status` |
| `/delete` | Delete downloaded data for a user. | `/delete elonmusk all` |
| `/help` | Show the help message. | `/help` |
| `/start` | Same as `/help`. | `/start` |

## Nitter & Proxy Operations

### Rotating Proxies
The system supports rotating HTTP/S proxies. When `PROXY_ENABLED=true`, the `ProxyManager` will cycle through the `PROXY_LIST` for:
1. **API Requests:** Fetching tweet data and metadata.
2. **Screenshots:** Navigating to Nitter or Twitter pages via Playwright.

If a proxy fails repeatedly, it will be temporarily deprioritized in the rotation.

### Nitter Instance Management
To avoid "Invalid Response" or "Rate Limited" errors:
- Use a private or less-trafficked Nitter instance as your primary `NITTER_URL`.
- Maintain a healthy list of `NITTER_FALLBACK_URLS`. The system will automatically switch to a fallback instance if the primary one returns a non-200 status or fails to parse.

## Database Migrations & Maintenance

The system uses `better-sqlite3` and automatic schema migrations.

- **Check DB Health:** `npm run dev doctor` (Runs integrity checks on the SQLite database and verifies filesystem access)
- **Backup DB:** `npm run dev backup <destination>` (Safely copies the database using SQLite's online backup API)
- **Cleanup Old Recordings:** `npm run dev cleanup` (Prunes recordings older than 30 days)

## Recovery Procedures

If the watcher daemon crashes or enters an unstable state:
1. Stop the process: `npm run stop` (asks the daemon to shut down, and kills it if it has not exited after 45 seconds)
2. Check the logs: `tail -n 100 data/daemon.log` (PowerShell: `Get-Content data\daemon.log -Tail 100`)
3. Check the database health: `npm run dev doctor`
4. Restart: `npm run start`

A leftover `data/watcher.pid` from a crash is harmless: the daemon refreshes that file every few seconds while it runs, and a stale one is ignored and cleaned up.

## Troubleshooting Guide

**1. "Invalid Response" from Nitter**
- Nitter instances often experience rate limits or get blocked.
- Ensure `PROXY_ENABLED=true` and valid proxies are in `PROXY_LIST` in your `.env`.
- Verify the active `NITTER_URL`.

**2. EPERM Errors on Windows / CI**
- Occasionally, SQLite lock files or Vitest concurrency can cause write permission errors.
- Ensure no other process (like an IDE or another terminal) is holding a lock on `data/watcher.db`.

**3. Telegram Uploads Failing for Large Files**
- If an upload fails silently or with a "413 Request Entity Too Large" error, ensure your local Telegram Bot API Docker container is running (`docker compose ps`) and `TELEGRAM_API_URL` is set correctly in `.env`.

**4. No screenshots ("Failed to start Camoufox")**
- Screenshots need the Python side: `python -m pip install -r requirements.txt` and `python -m camoufox fetch` (inside `.venv`, see the README).
- `playwright` in `requirements.txt` and `playwright-core` in `package.json` must be on the same minor version; update them together.
- After a failed launch the watcher retries on its own every couple of minutes; tweets are still posted without a screenshot in the meantime.

**5. "Twitter Auth Failure" alert**
- The session cookies were rejected. Put fresh `auth_token` / `ct0` values in `.env` (`npm run dev -- update-tokens`, or `npm run login`) and restart the watcher.
- The alert is sent at most once every six hours.

**6. "Watcher problem" / "Recovered" messages**
- Sent by the built-in health monitor (see "Running 24/7" in the README). `X API` failing usually means dead session cookies (401), a rate limit (429) or a changed API; the alert quotes the last error.
- `tweet polling` stuck means a polling cycle has not finished for 30 minutes; restart the watcher and check `data/daemon.log` for the last thing it was doing.

**7. The watcher came back by itself after I killed it**
- That is the auto-restart task (Windows) or systemd (Linux). Use `npm run stop` / `systemctl stop x-watcher` for a stop that sticks.
