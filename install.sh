#!/bin/bash
# ============================================
# Delt — One-click local AI assistant installer
# ============================================

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="$HOME/Delt"
PORT=3939

clear
echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║         ${BLUE}Delt${NC}${BOLD} — AI Assistant          ║${NC}"
echo -e "${BOLD}  ║      Local. Private. Yours.          ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""

# ---- Step 1: Check Node.js ----
echo -e "${BOLD}[1/5]${NC} Checking Node.js..."
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo -e "  ${GREEN}✓${NC} Node.js $NODE_VER"
    else
        echo -e "  ${RED}✗${NC} Node.js $NODE_VER is too old (need v18+)"
        echo ""
        echo -e "  Install the latest from: ${BLUE}https://nodejs.org${NC}"
        echo -e "  Or run: ${DIM}brew install node${NC}"
        exit 1
    fi
else
    echo -e "  ${RED}✗${NC} Node.js not found"
    echo ""
    # Try to install via brew on macOS
    if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
        echo -e "  Installing via Homebrew..."
        brew install node
        echo -e "  ${GREEN}✓${NC} Node.js installed"
    else
        echo -e "  Install from: ${BLUE}https://nodejs.org${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo -e "  Or install Homebrew first: ${DIM}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${NC}"
        fi
        exit 1
    fi
fi

# ---- Step 2: Copy app files ----
echo -e "${BOLD}[2/5]${NC} Installing Delt..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    # Copy everything except node_modules, logs, history, .git, install artifacts
    rsync -a --exclude node_modules --exclude logs --exclude history --exclude .git \
        --exclude config.json --exclude "*.zip" \
        "$SCRIPT_DIR/" "$INSTALL_DIR/"
    # If no config.json exists, copy the default
    if [ ! -f "$INSTALL_DIR/config.json" ]; then
        cp "$INSTALL_DIR/config.default.json" "$INSTALL_DIR/config.json"
    fi
    echo -e "  ${GREEN}✓${NC} Installed to $INSTALL_DIR"
else
    echo -e "  ${GREEN}✓${NC} Already in place"
fi

# ---- Step 3: Install dependencies ----
echo -e "${BOLD}[3/5]${NC} Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production --silent 2>/dev/null
echo -e "  ${GREEN}✓${NC} Dependencies ready"

# ---- Step 4: Check Claude Code CLI ----
echo -e "${BOLD}[4/5]${NC} Checking Claude Code CLI..."
if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "installed")
    echo -e "  ${GREEN}✓${NC} Claude CLI ($CLAUDE_VER)"
else
    echo -e "  ${YELLOW}!${NC} Claude CLI not found — installing..."
    npm install -g @anthropic-ai/claude-code 2>/dev/null || {
        echo -e "  ${YELLOW}!${NC} Global install failed, trying with sudo..."
        sudo npm install -g @anthropic-ai/claude-code
    }
    if command -v claude &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Claude CLI installed"
    else
        echo -e "  ${YELLOW}!${NC} Claude CLI will need to be installed manually"
        echo -e "  Run: ${DIM}npm install -g @anthropic-ai/claude-code${NC}"
        echo -e "  ${DIM}Delt will walk you through this in the browser.${NC}"
    fi
fi

# ---- Step 5: Create launcher ----
echo -e "${BOLD}[5/5]${NC} Creating launcher..."

# Create a simple launch script
cat > "$INSTALL_DIR/start.sh" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"
PORT=${PORT:-3939}

# Kill any existing instance
lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.5

# Start server
node server.js &
SERVER_PID=$!

# Wait for server to be ready
for i in {1..10}; do
    if curl -s -o /dev/null http://localhost:$PORT 2>/dev/null; then
        break
    fi
    sleep 0.5
done

# Open in browser
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$PORT"
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$PORT"
elif command -v start &>/dev/null; then
    start "http://localhost:$PORT"
fi

echo ""
echo "  Delt is running at http://localhost:$PORT"
echo "  Press Ctrl+C to stop"
echo ""

# Keep running until Ctrl+C
trap "kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
LAUNCHER
chmod +x "$INSTALL_DIR/start.sh"

# macOS: create a .command file (double-clickable)
if [[ "$OSTYPE" == "darwin"* ]]; then
    cat > "$INSTALL_DIR/Delt.command" << 'COMMAND'
#!/bin/bash
cd "$(dirname "$0")"
./start.sh
COMMAND
    chmod +x "$INSTALL_DIR/Delt.command"
    echo -e "  ${GREEN}✓${NC} Double-click ${BOLD}Delt.command${NC} to launch"
fi

echo ""
echo -e "${GREEN}${BOLD}  ✓ Delt is installed!${NC}"
echo ""
echo -e "  ${BOLD}To start:${NC}"
echo -e "    Double-click ${BOLD}Delt.command${NC} in ~/Delt"
echo -e "    Or run: ${DIM}cd ~/Delt && ./start.sh${NC}"
echo ""

# Ask if they want to launch now
read -p "  Launch Delt now? (Y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    cd "$INSTALL_DIR"
    ./start.sh
fi
