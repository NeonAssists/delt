#!/bin/bash
# ============================================
# Delt — One-click installer
# Works locally or piped: curl -fsSL <url>/install.sh | bash
# ============================================

# Do NOT use set -e — we handle errors ourselves so the script never dies silently
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$HOME/Delt"
DELT_DATA="$HOME/.delt"
PORT_FILE="$DELT_DATA/port"
DOWNLOAD_URL="https://delt.vercel.app/public/delt-latest.tar.gz"
PLIST_LABEL="com.neonotics.delt"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# Port — reuse existing or generate new
if [ -n "$DELT_PORT" ]; then
  PORT="$DELT_PORT"
elif [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
else
  PORT=$((10000 + RANDOM % 50000))
  mkdir -p "$DELT_DATA"
  echo "$PORT" > "$PORT_FILE"
  chmod 600 "$PORT_FILE"
fi

# ---- Header ----
clear 2>/dev/null || true
echo ""
echo -e "${BOLD}${CYAN}"
echo "    ____       _ _   "
echo "   |  _ \  ___| | |_ "
echo "   | | | |/ _ \ | __|"
echo "   | |_| |  __/ | |_ "
echo "   |____/ \___|_|\__|"
echo -e "${NC}"
echo -e "  ${DIM}Local AI assistant. Private. Yours.${NC}"
echo ""

# ---- Helpers ----
step=0
total=5
progress() { step=$((step + 1)); echo -e "${BOLD}[${step}/${total}]${NC} $1"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

# ---- Detect OS ----
OS="unknown"
case "$OSTYPE" in
  darwin*)  OS="macos" ;;
  linux*)   OS="linux" ;;
  msys*|cygwin*) echo -e "  ${RED}✗${NC} Windows is not yet supported. Use WSL."; exit 1 ;;
esac

# ---- Find node across common locations ----
find_node() {
  for p in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$p" ] && [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

find_npm() {
  for p in "$(command -v npm 2>/dev/null)" /opt/homebrew/bin/npm /usr/local/bin/npm; do
    if [ -n "$p" ] && [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# ============================================
# Step 1: Node.js
# ============================================
progress "Checking Node.js..."
NODE_BIN=$(find_node)

if [ -n "$NODE_BIN" ]; then
  NODE_VER=$("$NODE_BIN" -v 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js $NODE_VER"
  else
    warn "Node.js $NODE_VER is too old (need v18+)"
    if [ "$OS" = "macos" ] && command -v brew &>/dev/null; then
      brew upgrade node 2>/dev/null || brew install node 2>/dev/null
      NODE_BIN=$(find_node)
      ok "Node.js $("$NODE_BIN" -v) upgraded"
    else
      fail "Please upgrade Node.js to v18+: https://nodejs.org"
      exit 1
    fi
  fi
else
  warn "Node.js not found — installing..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install node 2>/dev/null
    else
      echo -e "  Installing Homebrew first (this may take a minute)..."
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 2>/dev/null
      # Add Homebrew to PATH for this session
      eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" 2>/dev/null
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
      brew install node 2>/dev/null
    fi
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs 2>/dev/null
    fi
  fi

  NODE_BIN=$(find_node)
  if [ -z "$NODE_BIN" ]; then
    fail "Could not install Node.js. Please install it from https://nodejs.org and re-run this script."
    exit 1
  fi
  ok "Node.js $("$NODE_BIN" -v) installed"
fi

NPM_BIN=$(find_npm)

# ============================================
# Step 2: Download Delt
# ============================================
progress "Downloading Delt..."
mkdir -p "$INSTALL_DIR" "$DELT_DATA"

# If running from within the project directory (local install), copy files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  rsync -a --exclude node_modules --exclude logs --exclude history --exclude .git \
    --exclude credentials.json --exclude "*.zip" --exclude "*.mp4" \
    --exclude demo-captures --exclude signups.json \
    "$SCRIPT_DIR/" "$INSTALL_DIR/" 2>/dev/null
  ok "Copied from local source"
else
  curl -fsSL "$DOWNLOAD_URL" -o /tmp/delt-latest.tar.gz 2>/dev/null
  if [ -s /tmp/delt-latest.tar.gz ]; then
    tar xzf /tmp/delt-latest.tar.gz -C "$INSTALL_DIR" 2>/dev/null
    rm -f /tmp/delt-latest.tar.gz
    ok "Downloaded"
  else
    fail "Download failed. Check your internet connection and try again."
    exit 1
  fi
fi

# Ensure default config exists
if [ ! -f "$INSTALL_DIR/config.json" ] && [ -f "$INSTALL_DIR/config.default.json" ]; then
  cp "$INSTALL_DIR/config.default.json" "$INSTALL_DIR/config.json"
fi

# ============================================
# Step 3: Install dependencies
# ============================================
progress "Installing dependencies..."
cd "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/node_modules" ]; then
  ok "Dependencies ready (bundled)"
else
  "$NPM_BIN" install --production 2>&1 | tail -5
  if [ -d "$INSTALL_DIR/node_modules" ]; then
    ok "Dependencies installed"
  else
    fail "npm install failed. Try running: cd ~/Delt && npm install"
    exit 1
  fi
fi

# ============================================
# Step 4: Install Claude Code CLI
# ============================================
progress "Installing Claude Code..."

# Use the official Anthropic installer — handles PATH correctly
CLAUDE_BIN=""
for p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi
done
if command -v claude &>/dev/null; then CLAUDE_BIN="$(command -v claude)"; fi

if [ -n "$CLAUDE_BIN" ]; then
  ok "Claude Code already installed"
else
  # Official one-liner — installs to ~/.local/bin, handles PATH
  curl -fsSL https://claude.ai/install.sh | sh 2>/dev/null

  # Re-check
  export PATH="$HOME/.local/bin:$PATH"
  for p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi
  done

  if [ -n "$CLAUDE_BIN" ]; then
    ok "Claude Code installed"
  else
    warn "Claude Code will be installed when you first open Delt"
  fi
fi

# ============================================
# Step 5: Start Delt and open browser
# ============================================
progress "Starting Delt..."

# Create launcher scripts
cat > "$INSTALL_DIR/start.sh" << LAUNCHER
#!/bin/bash
cd "\$(dirname "\$0")"
PORT=\$(cat "$PORT_FILE" 2>/dev/null || echo "$PORT")
lsof -ti:\$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.3
$NODE_BIN server.js &
PID=\$!
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -sf -o /dev/null http://localhost:\$PORT/health 2>/dev/null && break
  sleep 0.5
done
if [ "\$OSTYPE" = "darwin"* ]; then open "http://localhost:\$PORT"; fi
echo "  Delt is running at http://localhost:\$PORT"
echo "  Press Ctrl+C to stop"
trap "kill \$PID 2>/dev/null; exit 0" INT TERM
wait \$PID
LAUNCHER
chmod +x "$INSTALL_DIR/start.sh"

if [ "$OS" = "macos" ]; then
  cat > "$INSTALL_DIR/Delt.command" << 'COMMAND'
#!/bin/bash
cd "$(dirname "$0")"
./start.sh
COMMAND
  chmod +x "$INSTALL_DIR/Delt.command"
fi

# Set up auto-start service
if [ "$OS" = "macos" ]; then
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DELT_DATA}/delt.log</string>
  <key>StandardErrorPath</key><string>${DELT_DATA}/delt.err</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
    launchctl load "$PLIST_PATH" 2>/dev/null || true
elif [ "$OS" = "linux" ]; then
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SYSTEMD_DIR/delt.service" << SERVICE
[Unit]
Description=Delt AI Assistant
After=network.target
[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Environment=PATH=${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable delt 2>/dev/null || true
  systemctl --user start delt 2>/dev/null || true
fi

# Wait for server — try launchd first, fallback to direct start
SERVER_UP=false
TRIES=0
while [ "$TRIES" -lt 10 ]; do
  if curl -sf -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
    SERVER_UP=true
    break
  fi
  TRIES=$((TRIES + 1))
  sleep 1
done

if [ "$SERVER_UP" = "false" ]; then
  # Launchd didn't start it — start directly
  cd "$INSTALL_DIR"
  nohup "$NODE_BIN" server.js > "$DELT_DATA/delt.log" 2> "$DELT_DATA/delt.err" &
  TRIES=0
  while [ "$TRIES" -lt 15 ]; do
    if curl -sf -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
      SERVER_UP=true
      break
    fi
    TRIES=$((TRIES + 1))
    sleep 1
  done
fi

# Open browser
if [ "$SERVER_UP" = "true" ]; then
  ok "Running on http://localhost:$PORT"
  if [ "$OS" = "macos" ]; then
    open "http://localhost:$PORT"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$PORT"
  fi
else
  warn "Server took too long to start."
  echo -e "  Run manually: ${BOLD}cd ~/Delt && node server.js${NC}"
fi

# ---- Done ----
echo ""
echo -e "${GREEN}${BOLD}  Delt is installed!${NC}"
echo ""
echo -e "  ${BOLD}Open:${NC}        http://localhost:${PORT}"
echo -e "  ${BOLD}Auto-start:${NC}  Launches when you log in"
if [ "$OS" = "macos" ]; then
  echo -e "  ${BOLD}Desktop app:${NC} Open Chrome → ⋮ → Install Delt"
fi
echo ""
