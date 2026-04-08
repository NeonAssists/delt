#!/bin/bash
# ============================================
# Delt — Release script
# Bumps version, builds update tarball, commits, pushes.
# All installed users auto-update within 6 hours.
#
# Usage:
#   ./release.sh patch       # 2.0.1 → 2.0.2
#   ./release.sh minor       # 2.0.1 → 2.1.0
#   ./release.sh major       # 2.0.1 → 3.0.0
#   ./release.sh 2.1.3       # explicit version
# ============================================
set -e
cd "$(dirname "$0")"

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

BUMP="${1:-patch}"

# ---- Validate ----
if [[ -z "$BUMP" ]]; then
  echo -e "${RED}Usage: ./release.sh [patch|minor|major|x.y.z]${NC}"
  exit 1
fi

# ---- Read current version ----
CURRENT=$(node -e "process.stdout.write(require('./package.json').version)")
echo ""
echo -e "${BOLD}${CYAN}Delt Release${NC}"
echo -e "  Current: ${CURRENT}"

# ---- Compute new version ----
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  IFS='.' read -r -a parts <<< "$CURRENT"
  MAJOR="${parts[0]}"
  MINOR="${parts[1]}"
  PATCH="${parts[2]}"
  case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    *)
      echo -e "${RED}Unknown bump type: $BUMP${NC}"
      exit 1
      ;;
  esac
  NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
fi

echo -e "  New:     ${GREEN}${NEW_VERSION}${NC}"
echo ""

# ---- Confirm ----
read -r -p "  Release v${NEW_VERSION}? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "  Aborted."
  exit 0
fi
echo ""

# ---- Step 1: Bump version in package.json ----
echo -e "${BOLD}[1/4]${NC} Bumping version..."
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# Also update hardcoded version in build-installer.sh
sed -i '' "s/--version [0-9]*\.[0-9]*\.[0-9]*/--version ${NEW_VERSION}/g" build-installer.sh 2>/dev/null || true
sed -i '' "s/Delt-v[0-9]*\.[0-9]*\.[0-9]*/Delt-v${NEW_VERSION}/g" build-installer.sh 2>/dev/null || true

echo -e "  ${GREEN}✓${NC} package.json → ${NEW_VERSION}"

# ---- Step 2: Build update tarball (no node_modules — excluded on extract anyway) ----
echo -e "${BOLD}[2/4]${NC} Building update tarball..."

export COPYFILE_DISABLE=1

tar czf public/delt-latest.tar.gz \
  server.js \
  package.json \
  package-lock.json \
  config.default.json \
  integrations.json \
  INTEGRATIONS.md \
  install.sh \
  uninstall.sh \
  lib/crypto.js \
  lib/logging.js \
  lib/mcp.js \
  lib/memory.js \
  lib/rate-limit.js \
  lib/tunnel.js \
  test/critical.test.js \
  public/index.html \
  public/style.css \
  public/app.js \
  public/sw.js \
  public/manifest.json \
  public/offline.html \
  public/icon-192.png \
  public/icon-512.png \
  public/icon-192.svg \
  public/icon-512.svg \
  public/privacy.html \
  2>/dev/null

SIZE=$(wc -c < public/delt-latest.tar.gz | xargs)
echo -e "  ${GREEN}✓${NC} public/delt-latest.tar.gz (${SIZE} bytes)"

# ---- Step 3: Commit ----
echo -e "${BOLD}[3/4]${NC} Committing..."
git add package.json package-lock.json build-installer.sh public/delt-latest.tar.gz
git commit -m "$(cat <<EOF
Delt v${NEW_VERSION}

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
echo -e "  ${GREEN}✓${NC} Committed"

# ---- Step 4: Push ----
echo -e "${BOLD}[4/4]${NC} Pushing..."
git push
echo -e "  ${GREEN}✓${NC} Pushed → Vercel deploys → users auto-update within 6h"

echo ""
echo -e "${GREEN}${BOLD}  Released v${NEW_VERSION}${NC}"
echo -e "  Users on v${CURRENT} will update automatically on next Delt restart"
echo -e "  or within 6 hours (background check)."
echo ""
