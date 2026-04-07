#!/bin/bash
# ============================================
# Delt — Clean uninstaller
# Removes app, data, auto-start, and all traces
# ============================================

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$HOME/Delt"
DELT_DATA="$HOME/.delt"
PLIST_LABEL="com.neonotics.delt"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SYSTEMD_SERVICE="$HOME/.config/systemd/user/delt.service"
PORT_FILE="$DELT_DATA/port"
PORT=""
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null)
fi

echo ""
echo -e "${BOLD}${CYAN}  Uninstall Delt${NC}"
echo -e "  ${DIM}This removes Delt and all its data from your computer.${NC}"
echo ""

# ---- Show what will be removed ----
echo -e "${BOLD}Will remove:${NC}"
[ -d "$INSTALL_DIR" ]    && echo -e "  ${DIM}App:${NC}        $INSTALL_DIR"
[ -d "$DELT_DATA" ]      && echo -e "  ${DIM}Data:${NC}       $DELT_DATA"
[ -f "$PLIST_PATH" ]     && echo -e "  ${DIM}Auto-start:${NC} $PLIST_PATH"
[ -f "$SYSTEMD_SERVICE" ] && echo -e "  ${DIM}Auto-start:${NC} $SYSTEMD_SERVICE"
if [ -n "$PORT" ]; then
  lsof -ti:$PORT &>/dev/null && echo -e "  ${DIM}Process:${NC}    Delt server on port $PORT"
fi
echo ""

# ---- Confirm ----
read -p "  Continue? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo -e "  ${DIM}Cancelled.${NC}"
  echo ""
  exit 0
fi
echo ""

# ---- Step 1: Stop the server ----
echo -e "${BOLD}[1/4]${NC} Stopping Delt..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || \
    launchctl remove "$PLIST_LABEL" 2>/dev/null || true
fi
if command -v systemctl &>/dev/null; then
  systemctl --user stop delt 2>/dev/null || true
  systemctl --user disable delt 2>/dev/null || true
fi
# Kill any remaining process on the port
if [ -n "$PORT" ]; then
  lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
fi
# Also kill by process name as fallback
pgrep -f "node.*server\.js.*Delt" 2>/dev/null | xargs kill -9 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Server stopped"

# ---- Step 2: Remove auto-start ----
echo -e "${BOLD}[2/4]${NC} Removing auto-start..."
if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  echo -e "  ${GREEN}✓${NC} Removed launchd plist"
fi
if [ -f "$SYSTEMD_SERVICE" ]; then
  rm -f "$SYSTEMD_SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Removed systemd service"
fi
echo -e "  ${GREEN}✓${NC} Auto-start disabled"

# ---- Step 3: Remove app files ----
echo -e "${BOLD}[3/4]${NC} Removing app..."
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo -e "  ${GREEN}✓${NC} Removed $INSTALL_DIR"
else
  echo -e "  ${DIM}–${NC} $INSTALL_DIR not found (already removed)"
fi

# ---- Step 4: Remove data ----
echo -e "${BOLD}[4/4]${NC} Removing data..."
if [ -d "$DELT_DATA" ]; then
  rm -rf "$DELT_DATA"
  echo -e "  ${GREEN}✓${NC} Removed $DELT_DATA"
else
  echo -e "  ${DIM}–${NC} $DELT_DATA not found (already removed)"
fi

# ---- Done ----
echo ""
echo -e "${GREEN}${BOLD}  Delt has been completely removed.${NC}"
echo ""
echo -e "  ${DIM}Note: Claude Code CLI was not removed.${NC}"
echo -e "  ${DIM}To remove it too: npm uninstall -g @anthropic-ai/claude-code${NC}"
echo ""
