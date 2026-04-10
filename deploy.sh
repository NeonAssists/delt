#!/bin/bash
set -euo pipefail

# Delt Deploy — sync source to ~/Delt/ and restart
# Usage: ./deploy.sh

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Delt"
PLIST="$HOME/Library/LaunchAgents/com.neonotics.delt.plist"

echo "Deploying Delt from $SRC → $DEST"

# 1. Run tests
echo "  Running tests..."
cd "$SRC"
npm test 2>&1 | tail -5
echo "  Tests passed."

# 2. Sync files (exclude dev-only, secrets, and data dirs)
echo "  Syncing files..."
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.gitignore' \
  --exclude='.gstack/' \
  --exclude='.vercel/' \
  --exclude='.vercelignore' \
  --exclude='.env' \
  --exclude='service-account.json' \
  --exclude='config.json' \
  --exclude='config.json.bak' \
  --exclude='credentials.json' \
  --exclude='oauth-clients.json' \
  --exclude='signups.json' \
  --exclude='memory/' \
  --exclude='logs/' \
  --exclude='history/' \
  --exclude='node_modules/' \
  --exclude='demo-captures/' \
  --exclude='*.mp4' \
  --exclude='marketing-server.js' \
  --exclude='vercel.json' \
  --exclude='Dockerfile' \
  --exclude='.dockerignore' \
  --exclude='fly.toml' \
  --exclude='explainer.html' \
  --exclude='demo-video.html' \
  "$SRC/" "$DEST/"

# 3. Install deps if needed
if [ ! -d "$DEST/node_modules" ] || [ "$SRC/package.json" -nt "$DEST/node_modules/.package-lock.json" ]; then
  echo "  Installing dependencies..."
  cd "$DEST" && npm install --production 2>&1 | tail -3
fi

# 4. Preserve user config — copy default if none exists
if [ ! -f "$DEST/config.json" ]; then
  cp "$DEST/config.default.json" "$DEST/config.json"
  echo "  Created config.json from default"
fi

# 5. Restart LaunchAgent
echo "  Restarting Delt..."
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  sleep 1
  launchctl load "$PLIST"
else
  # Fallback: kill and restart manually
  pkill -f "node.*Delt/server.js" 2>/dev/null || true
  sleep 1
  cd "$DEST" && nohup node server.js > /tmp/delt.log 2>&1 &
fi

# 6. Smoke test — wait for server to respond
echo "  Waiting for server..."
PORT=$(cat "$HOME/.delt/port" 2>/dev/null || echo "39393")
for i in $(seq 1 10); do
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null | grep -q "200"; then
    echo "  Delt is running on port $PORT"
    echo ""
    echo "Deploy complete."
    exit 0
  fi
  sleep 1
done

echo "  WARNING: Server didn't respond within 10s. Check logs: cat /tmp/delt.log"
exit 1
