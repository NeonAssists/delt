#!/bin/bash
# ============================================
# Builds Delt installer artifacts
# ============================================
set -e
cd "$(dirname "$0")"

echo "=== Building Delt Installer ==="
echo ""

# ---- Step 1: Bundle EVERYTHING (including node_modules) ----
echo "[1/4] Bundling..."
export COPYFILE_DISABLE=1

# Fresh production install to a temp dir so we get clean deps
STAGE="/tmp/delt-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp package.json package-lock.json "$STAGE/"
cd "$STAGE" && npm install --production --silent 2>/dev/null
cd /Users/neonotics/Projects/claude-code-ui

tar czf /tmp/delt-bundle.tar.gz \
  server.js \
  package.json \
  package-lock.json \
  config.default.json \
  install.sh \
  uninstall.sh \
  lib/crypto.js \
  lib/logging.js \
  lib/mcp.js \
  lib/memory.js \
  lib/rate-limit.js \
  lib/tunnel.js \
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
  -C "$STAGE" node_modules

BUNDLE_SIZE=$(wc -c < /tmp/delt-bundle.tar.gz | xargs)
echo "  Bundle: $BUNDLE_SIZE bytes (with node_modules)"

# ---- Step 2: Build .pkg ----
echo "[2/4] Building .pkg..."

PKG_SCRIPTS="/tmp/delt-pkg-scripts"
PKG_RESOURCES="/tmp/delt-pkg-resources"
rm -rf "$PKG_SCRIPTS" "$PKG_RESOURCES" "$STAGE"
mkdir -p "$PKG_SCRIPTS" "$PKG_RESOURCES"

# --- Postinstall: MINIMAL. Extract files, set permissions, register service, open browser. ---
cat > "$PKG_SCRIPTS/postinstall" << 'POSTINSTALL_TOP'
#!/bin/bash
# Delt postinstall — extract files, register service, open browser. That's it.

REAL_USER="$(stat -f %Su /dev/console)"
REAL_HOME="$(dscl . -read /Users/$REAL_USER NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -z "$REAL_HOME" ] && REAL_HOME="/Users/$REAL_USER"

INSTALL_DIR="$REAL_HOME/Delt"
DELT_DATA="$REAL_HOME/.delt"
PORT_FILE="$DELT_DATA/port"
mkdir -p "$DELT_DATA"

# Read existing port or generate a new one
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null)
fi
if [ -z "$PORT" ] || [ "$PORT" -lt 1024 ] 2>/dev/null || [ "$PORT" -gt 65535 ] 2>/dev/null; then
  PORT=$((10000 + RANDOM % 50000))
  echo "$PORT" > "$PORT_FILE"
  chmod 600 "$PORT_FILE"
fi
chown "$REAL_USER:staff" "$PORT_FILE"

PLIST_LABEL="com.neonotics.delt"
PLIST_PATH="$REAL_HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# Find node
NODE_BIN=""
for p in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$p" ] && NODE_BIN="$p" && break
done

if [ -z "$NODE_BIN" ]; then
  # Leave a breadcrumb — Delt onboarding UI will handle Node install
  mkdir -p "$DELT_DATA"
  echo "node_missing" > "$DELT_DATA/install-status"
  chown -R "$REAL_USER:staff" "$DELT_DATA"
  exit 0
fi

# 1. Extract files (node_modules included — no npm install needed)
mkdir -p "$INSTALL_DIR" "$DELT_DATA"

BUNDLE_B64='
POSTINSTALL_TOP

# Inject base64 bundle
base64 -i /tmp/delt-bundle.tar.gz >> "$PKG_SCRIPTS/postinstall"

cat >> "$PKG_SCRIPTS/postinstall" << 'POSTINSTALL_BOTTOM'
'

echo "$BUNDLE_B64" | base64 -d | tar xz -C "$INSTALL_DIR" 2>/dev/null

[ ! -f "$INSTALL_DIR/config.json" ] && [ -f "$INSTALL_DIR/config.default.json" ] && \
  cp "$INSTALL_DIR/config.default.json" "$INSTALL_DIR/config.json"

chown -R "$REAL_USER:staff" "$INSTALL_DIR" "$DELT_DATA"

# 2. Create launchd plist
mkdir -p "$(dirname "$PLIST_PATH")"
launchctl bootout "gui/$(id -u "$REAL_USER")/$PLIST_LABEL" 2>/dev/null || true

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
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${DELT_DATA}/delt.log</string>
  <key>StandardErrorPath</key><string>${DELT_DATA}/delt.err</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
chown "$REAL_USER:staff" "$PLIST_PATH"

# 3. Load the service and open browser
sudo -u "$REAL_USER" launchctl bootstrap "gui/$(id -u "$REAL_USER")" "$PLIST_PATH" 2>/dev/null || \
  sudo -u "$REAL_USER" launchctl load "$PLIST_PATH" 2>/dev/null || true

# Wait for server
for i in $(seq 1 20); do
  curl -sf -o /dev/null "http://localhost:$PORT/health" 2>/dev/null && break
  sleep 0.5
done

sudo -u "$REAL_USER" open "http://localhost:$PORT" 2>/dev/null || true

exit 0
POSTINSTALL_BOTTOM

chmod +x "$PKG_SCRIPTS/postinstall"

# Welcome/conclusion HTML for the installer UI
cat > "$PKG_RESOURCES/welcome.html" << 'WELCOME'
<html><body style="font-family:-apple-system,sans-serif;padding:20px;color:#333">
<h2 style="font-weight:700">Install Delt</h2>
<p style="color:#666;line-height:1.6">Your private AI assistant. Runs entirely on your computer.</p>
<ul style="color:#666;line-height:1.8"><li>Installs to ~/Delt</li><li>Auto-starts on login</li><li>Takes about 10 seconds</li></ul>
</body></html>
WELCOME

cat > "$PKG_RESOURCES/conclusion.html" << 'CONCLUSION'
<html><body style="font-family:-apple-system,sans-serif;padding:20px;color:#333">
<h2 style="font-weight:700;color:#10B981">Delt is ready!</h2>
<p style="color:#666;line-height:1.6">Opening in your browser now. Delt auto-starts every time you log in.</p>
<p style="color:#999;font-size:13px;margin-top:12px">Install as a desktop app: Chrome menu → Install Delt</p>
</body></html>
CONCLUSION

# Build component pkg
pkgbuild \
  --nopayload \
  --identifier com.neonotics.delt \
  --version 1.0 \
  --scripts "$PKG_SCRIPTS" \
  /tmp/delt-component.pkg >/dev/null 2>&1

# Wrap with distribution for welcome/conclusion
cat > /tmp/delt-distribution.xml << 'DIST'
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>Delt</title>
    <welcome file="welcome.html"/>
    <conclusion file="conclusion.html"/>
    <options customize="never" require-scripts="false"/>
    <choices-outline><line choice="com.neonotics.delt"/></choices-outline>
    <choice id="com.neonotics.delt" visible="false"><pkg-ref id="com.neonotics.delt"/></choice>
    <pkg-ref id="com.neonotics.delt" version="1.0">#delt-component.pkg</pkg-ref>
</installer-gui-script>
DIST

productbuild \
  --distribution /tmp/delt-distribution.xml \
  --package-path /tmp \
  --resources "$PKG_RESOURCES" \
  /tmp/Delt.pkg >/dev/null 2>&1

echo "  Unsigned: $(wc -c < /tmp/Delt.pkg | xargs) bytes"

# Sign
SIGN_ID="Developer ID Installer: NATHANIEL MOSHE MARMORSTEIN (94KWFS52XW)"
productsign --sign "$SIGN_ID" /tmp/Delt.pkg /tmp/Delt-signed.pkg >/dev/null 2>&1
mv /tmp/Delt-signed.pkg /tmp/Delt.pkg
echo "  Signed: $(wc -c < /tmp/Delt.pkg | xargs) bytes"

# Notarize
echo "  Notarizing..."
if xcrun notarytool submit /tmp/Delt.pkg --keychain-profile "delt-notary" --wait 2>/dev/null; then
  xcrun stapler staple /tmp/Delt.pkg 2>/dev/null
  echo "  Notarized + stapled"
else
  echo "  WARNING: Notarization failed. Pkg is signed but will show Gatekeeper warning."
fi

# ---- Step 3: Build HTML ----
echo "[3/4] Building HTML..."
base64 -i /tmp/Delt.pkg > /tmp/delt-pkg.b64

python3 << 'PYEOF'
import re
with open('/tmp/delt-pkg.b64', 'r') as f:
    pkg_b64 = f.read().replace('\n', '')
with open('delt-installer.html', 'r') as f:
    html = f.read()
html = re.sub(r'const PKG_BUNDLE = "[^"]*"', 'const PKG_BUNDLE = "' + pkg_b64 + '"', html)
with open('delt-installer.html', 'w') as f:
    f.write(html)
PYEOF

echo "  HTML: $(wc -c < delt-installer.html | xargs) bytes"

# ---- Step 4: Cleanup ----
echo "[4/4] Cleanup..."
rm -rf "$PKG_SCRIPTS" "$PKG_RESOURCES" /tmp/delt-bundle.tar.gz /tmp/delt-pkg.b64 \
  /tmp/delt-component.pkg /tmp/delt-distribution.xml /tmp/Delt.pkg /tmp/delt-stage

echo ""
echo "=== Done ==="
echo ""
