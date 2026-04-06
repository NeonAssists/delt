#!/bin/bash
# ============================================
# Delt — One-click installer
# Works locally or piped: curl -fsSL <url>/install.sh | bash
# ============================================

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$HOME/Delt"
PORT="${DELT_PORT:-3939}"
DELT_DATA="$HOME/.delt"
REPO_URL="https://github.com/neonotics/delt"
PLIST_LABEL="com.neonotics.delt"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

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
total=6

progress() {
  step=$((step + 1))
  echo -e "${BOLD}[${step}/${total}]${NC} $1"
}

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

# ---- Detect OS ----
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux"* ]]; then
  OS="linux"
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
  OS="windows"
fi

if [ "$OS" = "windows" ]; then
  fail "Windows is not yet supported. Use WSL: https://learn.microsoft.com/en-us/windows/wsl/install"
fi

# ---- Step 1: Node.js ----
progress "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node.js $NODE_VER"
  else
    warn "Node.js $NODE_VER is too old (need v18+)"
    if [ "$OS" = "macos" ] && command -v brew &>/dev/null; then
      echo -e "  Upgrading via Homebrew..."
      brew upgrade node 2>/dev/null || brew install node
      ok "Node.js $(node -v)"
    else
      fail "Please upgrade Node.js to v18+: https://nodejs.org"
    fi
  fi
else
  warn "Node.js not found — installing..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install node
      ok "Node.js $(node -v) installed via Homebrew"
    else
      echo -e "  Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
      brew install node
      ok "Node.js $(node -v) installed"
    fi
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null
      ok "Node.js $(node -v) installed via apt"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs 2>/dev/null
      ok "Node.js $(node -v) installed via dnf"
    else
      fail "Install Node.js v18+ manually: https://nodejs.org"
    fi
  fi
fi

# ---- Step 2: Download Delt ----
progress "Installing Delt..."
mkdir -p "$INSTALL_DIR" "$DELT_DATA"

# If running from within the project directory (local install), copy files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  # Local install — copy from source
  if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
    rsync -a --exclude node_modules --exclude logs --exclude history --exclude .git \
      --exclude credentials.json --exclude "*.zip" --exclude "*.mp4" \
      --exclude demo-captures --exclude signups.json \
      "$SCRIPT_DIR/" "$INSTALL_DIR/"
    ok "Copied from local source"
  else
    ok "Already installed"
  fi
elif command -v git &>/dev/null; then
  # Remote install — clone repo
  if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null
    ok "Updated from git"
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null
    ok "Cloned from GitHub"
  fi
else
  # No git — download tarball
  curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar xz -C /tmp
  cp -R /tmp/delt-main/* "$INSTALL_DIR/" 2>/dev/null || cp -R /tmp/claude-code-ui-main/* "$INSTALL_DIR/"
  rm -rf /tmp/delt-main /tmp/claude-code-ui-main
  ok "Downloaded from GitHub"
fi

# Ensure default config exists
if [ ! -f "$INSTALL_DIR/config.json" ] && [ -f "$INSTALL_DIR/config.default.json" ]; then
  cp "$INSTALL_DIR/config.default.json" "$INSTALL_DIR/config.json"
fi

# ---- Step 3: Dependencies ----
progress "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production --silent 2>&1 | tail -1
ok "Dependencies ready"

# ---- Step 4: Claude Code CLI ----
progress "Checking Claude Code CLI..."
if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "installed")
  ok "Claude CLI ($CLAUDE_VER)"
else
  warn "Claude CLI not found — installing..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null || {
    warn "Global install failed, trying with sudo..."
    sudo npm install -g @anthropic-ai/claude-code 2>/dev/null || true
  }
  if command -v claude &>/dev/null; then
    ok "Claude CLI installed"
  else
    warn "Claude CLI will be installed on first launch via the browser"
  fi
fi

# ---- Step 5: Create launcher + auto-start ----
progress "Setting up launcher..."

# Create start script
cat > "$INSTALL_DIR/start.sh" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"
PORT=${PORT:-3939}

# Kill any existing instance on the port
lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.3

# Start server
node server.js &
SERVER_PID=$!

# Wait for server
for i in {1..15}; do
  if curl -sf -o /dev/null http://localhost:$PORT/health 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Open browser
if [[ "$OSTYPE" == "darwin"* ]]; then
  open "http://localhost:$PORT"
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:$PORT"
fi

echo ""
echo "  Delt is running at http://localhost:$PORT"
echo "  Press Ctrl+C to stop"
echo ""

trap "kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
LAUNCHER
chmod +x "$INSTALL_DIR/start.sh"

# macOS: double-clickable .command file
if [ "$OS" = "macos" ]; then
  cat > "$INSTALL_DIR/Delt.command" << 'COMMAND'
#!/bin/bash
cd "$(dirname "$0")"
./start.sh
COMMAND
  chmod +x "$INSTALL_DIR/Delt.command"
fi

# ---- Step 6: Auto-start service ----
progress "Configuring auto-start..."

if [ "$OS" = "macos" ]; then
  # Stop existing service if running
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true

  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>${INSTALL_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${DELT_DATA}/delt.log</string>
  <key>StandardErrorPath</key>
  <string>${DELT_DATA}/delt.err</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
    launchctl load "$PLIST_PATH" 2>/dev/null || true
  ok "Auto-start enabled (launchd)"

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
ExecStart=$(which node) ${INSTALL_DIR}/server.js
Environment=PORT=${PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable delt 2>/dev/null || true
  systemctl --user start delt 2>/dev/null || true
  ok "Auto-start enabled (systemd)"
fi

# ---- Wait for server ----
echo ""
echo -e "${DIM}  Starting Delt...${NC}"
for i in {1..20}; do
  if curl -sf -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# ---- Open browser ----
if curl -sf -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
  if [ "$OS" = "macos" ]; then
    open "http://localhost:$PORT"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$PORT"
  fi
fi

# ---- Done ----
echo ""
echo -e "${GREEN}${BOLD}  Delt is installed and running!${NC}"
echo ""
echo -e "  ${BOLD}Open:${NC}        http://localhost:${PORT}"
echo -e "  ${BOLD}Auto-start:${NC}  Delt launches when you log in"
echo -e "  ${BOLD}Stop:${NC}        launchctl bootout gui/$(id -u)/${PLIST_LABEL}"
echo -e "  ${BOLD}Logs:${NC}        ${DELT_DATA}/delt.log"
if [ "$OS" = "macos" ]; then
  echo -e "  ${BOLD}Desktop:${NC}     Open Chrome → ⋮ → Install Delt"
fi
echo ""
echo -e "  ${DIM}Tip: Install as a desktop app from Chrome for the best experience.${NC}"
echo ""
