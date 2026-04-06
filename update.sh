#!/bin/bash
# ═══════════════════════════════════════════════════
#  Monthly Auto-Update Script for Twitter Spaces Watcher
#  
#  Setup (run once):
#    chmod +x update.sh
#    crontab -e
#    # Add this line (runs at 3 AM on the 1st of every month):
#    0 3 1 * * /path/to/space-watcher/update.sh >> /path/to/space-watcher/update.log 2>&1
# ═══════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Auto-Update — $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"

# 1. Update Node.js dependencies
echo "[1/4] Updating npm packages..."
npm update 2>&1

# 2. Re-apply the download speed patch (maxConcurrent: 5 → 20)
DOWNLOADER_FILE="node_modules/twspace-crawler/dist/modules/SpaceDownloader.js"
if [ -f "$DOWNLOADER_FILE" ]; then
  echo "[2/4] Re-applying download speed patch..."
  sed -i 's/maxConcurrent: 5/maxConcurrent: 20/g' "$DOWNLOADER_FILE"
  echo "  → maxConcurrent set to 20"
else
  echo "[2/4] SpaceDownloader.js not found, skipping patch"
fi

# 3. Update Playwright browsers (if needed)
echo "[3/4] Updating browsers..."
npx playwright install chromium 2>&1 || true

# 4. Restart PM2 process if running
echo "[4/4] Restarting watcher..."
if command -v pm2 &> /dev/null; then
  pm2 restart space-watcher 2>&1 || echo "  → No running watcher to restart"
  pm2 save 2>&1
else
  echo "  → PM2 not installed, skipping restart"
fi

echo ""
echo "✅ Update complete — $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
