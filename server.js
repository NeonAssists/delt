require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { spawn, execSync: execSyncImport } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Ensure PATH includes common Claude Code install locations
// (launchd and pkg postinstall may not include user-local paths)
const extraPaths = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];
const currentPath = process.env.PATH || "";
const missingPaths = extraPaths.filter(p => !currentPath.includes(p));
if (missingPaths.length) {
  process.env.PATH = missingPaths.join(":") + ":" + currentPath;
}
const crypto = require("crypto");
const multer = require("multer");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

// ============================================
// Extracted modules
// ============================================
const cryptoLib = require("./lib/crypto");
const tunnel = require("./lib/tunnel");
const logging = require("./lib/logging");
const memoryLib = require("./lib/memory");
const { rateLimit } = require("./lib/rate-limit");
const mcpLib = require("./lib/mcp");

// ============================================
// Local HTTPS — opt-in only (DELT_HTTPS=1)
// Localhost is already a secure context in Chrome/Edge/Firefox,
// so PWA install works without HTTPS. Self-signed certs show
// scary "connection not private" warnings — only enable when
// the user explicitly opts in (e.g. custom domain, mkcert certs).
// ============================================
const CERT_DIR = path.join(os.homedir(), ".delt", "certs");
const CERT_PATH = path.join(CERT_DIR, "localhost.crt");
const KEY_PATH = path.join(CERT_DIR, "localhost.key");

function loadCerts() {
  // Only load/generate certs if explicitly requested
  if (!process.env.DELT_HTTPS) return null;

  // Use existing certs (e.g. from mkcert) if present
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    try {
      const certPem = fs.readFileSync(CERT_PATH, "utf-8");
      if (certPem.includes("-----BEGIN CERTIFICATE-----")) {
        console.log("  [HTTPS] Using certs from ~/.delt/certs/");
        return { cert: certPem, key: fs.readFileSync(KEY_PATH, "utf-8") };
      }
    } catch {}
  }

  // Auto-generate self-signed cert as last resort
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    execSyncImport(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" ` +
      `-days 365 -nodes -subj "/CN=localhost" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: "pipe" }
    );
    fs.chmodSync(KEY_PATH, 0o600);
    fs.chmodSync(CERT_PATH, 0o644);
    console.log("  [HTTPS] Generated self-signed certificate");
    console.log("  [HTTPS] Tip: Use mkcert for trusted local certs without browser warnings");
    return { cert: fs.readFileSync(CERT_PATH, "utf-8"), key: fs.readFileSync(KEY_PATH, "utf-8") };
  } catch (e) {
    console.warn("  [HTTPS] Could not generate cert — falling back to HTTP:", e.message);
    return null;
  }
}

const tlsCerts = loadCerts();

// ============================================
// Stability helpers
// ============================================
const PROCESS_TIMEOUT_MS = 600000; // 10 min — Claude needs time for tool use, file edits, multi-step tasks

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }
}

function spawnWithTimeout(proc, ws, errorType, timeoutMs = PROCESS_TIMEOUT_MS) {
  const timer = setTimeout(() => {
    if (proc && !proc.killed) {
      proc.kill("SIGKILL");
      safeSend(ws, { type: errorType, message: "Request timed out. Try again." });
    }
  }, timeoutMs);
  proc.on("close", () => clearTimeout(timer));
  proc.on("error", () => clearTimeout(timer));
  return timer;
}

// Load config — use config.json if exists, otherwise copy from config.default.json
const configPath = path.join(__dirname, "config.json");
const defaultConfigPath = path.join(__dirname, "config.default.json");
let config = {};
try {
  if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
    fs.copyFileSync(defaultConfigPath, configPath);
  }
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e) {
  console.error("Could not load config:", e.message);
  process.exit(1);
}

// ============================================
// Silent Install State (background CLI install)
// ============================================
let installState = { status: "idle", error: null, progress: "" };

// ============================================
// Integration & Credential Management
// ============================================
const integrationsPath = path.join(__dirname, "integrations.json");
const credentialsPath = path.join(__dirname, "credentials.json");
const oauthClientsPath = path.join(__dirname, "oauth-clients.json");
const encryptedOauthPath = path.join(os.homedir(), ".delt", "oauth-clients.enc.json");

let integrationsRegistry = { integrations: [] };
try {
  integrationsRegistry = JSON.parse(fs.readFileSync(integrationsPath, "utf-8"));
} catch {}

// OAuth clients — load from encrypted store, migrate from plaintext, or env vars
let oauthClients = {};
try {
  // Try encrypted store first
  const encRaw = JSON.parse(fs.readFileSync(encryptedOauthPath, "utf-8"));
  oauthClients = cryptoLib.decryptData(encRaw);
} catch {
  // Fall back to plaintext file and migrate
  try {
    oauthClients = JSON.parse(fs.readFileSync(oauthClientsPath, "utf-8"));
    if (Object.keys(oauthClients).length > 0) {
      // Migrate: encrypt and save to ~/.delt/, then remove plaintext
      const deltDir = path.join(os.homedir(), ".delt");
      if (!fs.existsSync(deltDir)) fs.mkdirSync(deltDir, { recursive: true, mode: 0o700 });
      const encrypted = cryptoLib.encryptData(oauthClients);
      fs.writeFileSync(encryptedOauthPath, JSON.stringify(encrypted), { mode: 0o600 });
      // Delete the plaintext file
      try { fs.unlinkSync(oauthClientsPath); } catch {}
      console.log("[Security] Migrated oauth-clients.json to encrypted store at ~/.delt/");
    }
  } catch {}
}

// Auto-provision Google OAuth from env vars (first-install support)
if (!oauthClients["google-workspace"] && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  oauthClients["google-workspace"] = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  // Persist so it survives restarts without env vars
  try {
    const deltDir = path.join(os.homedir(), ".delt");
    if (!fs.existsSync(deltDir)) fs.mkdirSync(deltDir, { recursive: true, mode: 0o700 });
    const encrypted = cryptoLib.encryptData(oauthClients);
    fs.writeFileSync(encryptedOauthPath, JSON.stringify(encrypted), { mode: 0o600 });
    console.log("[Setup] Google OAuth provisioned from environment variables");
  } catch {}
}

// Save OAuth clients to encrypted store
function saveOauthClients() {
  const deltDir = path.join(os.homedir(), ".delt");
  if (!fs.existsSync(deltDir)) fs.mkdirSync(deltDir, { recursive: true, mode: 0o700 });
  const encrypted = cryptoLib.encryptData(oauthClients);
  fs.writeFileSync(encryptedOauthPath, JSON.stringify(encrypted), { mode: 0o600 });
}

// Harden sensitive file permissions on startup
try { fs.chmodSync(credentialsPath, 0o600); } catch {}

// Write persistent integrations.md so Claude always knows what's connected
function writeIntegrationsMd() {
  const creds = cryptoLib.loadCredentials();
  const connected = integrationsRegistry.integrations.filter(
    (i) => creds[i.id] && creds[i.id].enabled
  );

  let md = "# Connected Integrations\n\n";

  if (!connected.length) {
    md += "No integrations connected. Use the Integrations panel to connect services.\n";
  } else {
    md += "These services are connected via MCP. ALWAYS use the MCP tools to interact with them.\n";
    md += "NEVER use local apps (Mail.app, Calendar.app), AppleScript, osascript, or shell commands for these services.\n\n";

    for (const i of connected) {
      const serverNames = i.composioSlug ? [i.composioSlug] : Object.keys(i.mcpServers || {});
      const tools = serverNames.map((s) => `mcp__${s}__*`);
      md += `## ${i.name}\n`;
      md += `${i.description}\n`;
      md += `MCP tools: ${tools.join(", ")}\n\n`;
    }
  }

  try {
    const mdPath = path.join(__dirname, "INTEGRATIONS.md");
    fs.writeFileSync(mdPath, md);
  } catch (e) {
    console.error("Failed to write INTEGRATIONS.md:", e.message);
  }
}

// ============================================
// Wire up extracted modules
// ============================================

// Initialize MCP module (needs loadCredentials, integrations, oauthClients)
mcpLib.init({
  loadCredentials: () => cryptoLib.loadCredentials(),
  integrationsRegistry,
  oauthClients,
});

// Initialize crypto module (needs callbacks from mcp + writeIntegrationsMd)
cryptoLib.init({
  credentialsPath,
  integrationsRegistry,
  invalidateMcpCache: () => mcpLib.invalidateMcpCache(),
  writeIntegrationsMd,
});

// Sync allowed tools to Claude settings on startup — ensures any
// previously-connected integrations are pre-approved for all sessions.
cryptoLib.syncClaudeSettingsAllowedTools();

// Initialize logging module (needs project base dir)
logging.initDirs(__dirname);

// Initialize memory module (needs project base dir + todayStr from logging)
memoryLib.initDirs(__dirname, logging.todayStr);

// Re-export frequently used functions for local convenience
const { loadCredentials, saveCredentials, getCredential, saveCredential, deleteCredential } = cryptoLib;
const { isLocalRequest, parseCookies, validateMobileToken, createMobileSession, validateMobileSession, generateMobileToken, startTunnel, stopTunnel, cleanupTunnel, getTunnelState, touchTunnelActivity, mobileAuthPage, MOBILE_SESSION_TTL } = tunnel;
const { todayStr, weekStr, logConversation, readLogFile, safeName, escapeHtml, listLogFiles } = logging;
const { safeRead, safeWrite, getStateContext, persistExchange, flushMemoryExtraction, buildSystemPrefix, appendSessionLog } = memoryLib;
const { buildMcpConfig, writeMcpConfigFile, invalidateMcpCache, buildClaudeArgs } = mcpLib;

// ============================================
// Shared Claude stream handler
// Eliminates ~120 lines of duplicate stdout/stderr/close logic
// ============================================
function attachStreamHandlers(proc, ws, { streamType, errorType, onText, onCost, onBroadcast, onClose }) {
  let buffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        safeSend(ws, { type: streamType, data: obj });
        if (onBroadcast) onBroadcast(obj);

        if (obj.type === "assistant" && obj.message?.content) {
          for (const b of obj.message.content) {
            if (b.type === "text" && onText) onText(b.text);
            if (b.type === "tool_use" && onText) onText(null, b.name || "unknown");
          }
        }
        if (obj.type === "result" && obj.cost_usd && onCost) onCost(obj.cost_usd);
      } catch {}
    }
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const text = chunk.toString();
    if (text.includes("Error") || text.includes("ENOENT")) {
      safeSend(ws, { type: errorType, message: text.trim() });
    }
  });

  proc.on("close", (code) => {
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        safeSend(ws, { type: streamType, data: obj });
        if (obj.type === "result" && obj.cost_usd && onCost) onCost(obj.cost_usd);
      } catch (e) {
        console.error("[stream] Malformed JSON from Claude:", buffer.trim().slice(0, 200));
      }
    }
    // Detect auth failure by exit code + stderr content — not substring during streaming
    // Exit code 1 with auth-related stderr = expired session
    if (code !== 0 && code !== null && /\b(401|403|auth|token.expired|not.logged.in|unauthorized|UNAUTHENTICATED)\b/i.test(stderrBuf)) {
      safeSend(ws, { type: "auth-expired", message: "Your Claude session has expired. Please sign in again." });
    }
    if (onClose) onClose(code);
  });

  proc.on("error", (err) => {
    safeSend(ws, { type: errorType, message: err.message });
    if (onClose) onClose(-1);
  });
}

// Pending OAuth states (CSRF protection)
const pendingOAuthStates = new Map();

// Tunnel cleanup is called from the main shutdown handlers below

const { dailyDir, weeklyDir, userDir } = logging.getDirs();

// Each Delt install gets its own unique port — generated on first run, saved to ~/.delt/port
function getOrCreatePort() {
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  const portFile = path.join(os.homedir(), ".delt", "port");
  try {
    const saved = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
    if (saved >= 1024 && saved <= 65535) return saved;
  } catch {}
  // Generate random port in 10000–59999 range — hard to guess
  const port = 10000 + crypto.randomInt(50000);
  fs.mkdirSync(path.join(os.homedir(), ".delt"), { recursive: true });
  fs.writeFileSync(portFile, String(port), { mode: 0o600 });
  return port;
}
const PORT = getOrCreatePort();

const app = express();
app.disable("x-powered-by");
const server = tlsCerts
  ? https.createServer({ cert: tlsCerts.cert, key: tlsCerts.key }, app)
  : http.createServer(app);
const useHttps = !!tlsCerts;
const wss = new WebSocket.Server({ noServer: true });

// WebSocket ping/pong keepalive — detect dead connections
const WS_PING_INTERVAL = 30000; // 30 seconds
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._deltAlive === false) {
      // Missed last pong — connection is dead
      ws.terminate();
      return;
    }
    ws._deltAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

// WebSocket auth — reject unauthenticated remote connections
server.on("upgrade", (req, socket, head) => {
  const ip = req.socket.remoteAddress || "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

  if (isLocal) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  // Remote: require valid mobile session cookie
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(";").forEach((c) => {
      const [name, ...rest] = c.trim().split("=");
      cookies[name] = rest.join("=");
    });
  }

  if (cookies["delt-mobile-auth"] && validateMobileSession(cookies["delt-mobile-auth"])) {
    // Origin check — block cross-site WebSocket hijacking
    const origin = req.headers.origin;
    const { tunnelUrl } = getTunnelState();
    if (origin && tunnelUrl && !origin.startsWith(tunnelUrl)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  // Reject silently — no fingerprint
  socket.destroy();
});

// File uploads — use ~/.delt/uploads instead of world-readable /tmp
const uploadDir = path.join(os.homedir(), ".delt", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// OAuth callback — Desktop app redirects to root with ?code=&state=
app.use((req, res, next) => {
  if (req.path === "/" && req.query.code && req.query.state) {
    return res.redirect(`/oauth/callback?${new URLSearchParams(req.query)}`);
  }
  next();
});

// ============================================
// Mobile Auth Middleware — before static files
// ============================================
app.use((req, res, next) => {
  // Local requests bypass auth entirely
  if (isLocalRequest(req)) return next();

  // Only allow the mobile auth entry point — everything else requires session
  if (req.path === "/mobile/auth") return next();

  // Check for valid mobile session cookie
  const cookies = parseCookies(req);
  if (cookies["delt-mobile-auth"] && validateMobileSession(cookies["delt-mobile-auth"])) {
    return next();
  }

  // Check for valid token in query param (one-time, consumed on use)
  const tokenResult = req.query.token ? validateMobileToken(req.query.token) : null;
  if (tokenResult && tokenResult.valid) {
    const sessionValue = createMobileSession();
    const isSecure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
    res.cookie("delt-mobile-auth", sessionValue, {
      maxAge: MOBILE_SESSION_TTL,
      httpOnly: true,
      sameSite: isSecure ? "none" : "lax",
      secure: isSecure,
      path: "/",
    });
    return next();
  }

  // No valid auth — silent 404, no fingerprint
  res.status(404).end();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none';");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  res.removeHeader("Server");
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// CORS for signup endpoint — allows demo page to work from file:// or external hosts
app.use("/api/signup", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// CSRF protection — reject cross-origin mutating requests from remote clients
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (isLocalRequest(req)) return next();
  if (req.path === "/api/signup") return next(); // signup is public
  const origin = req.get("origin");
  const host = req.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return res.status(403).json({ error: "Cross-origin request blocked" });
  }
  next();
});

// Local-only guard — rejects remote requests silently
function localOnly(req, res, next) {
  if (!isLocalRequest(req)) return res.status(404).end();
  next();
}

// Health check — detect if claude CLI is installed and authed
const execSync = execSyncImport;

app.get("/health", (req, res) => {
  let installed = false;
  let version = null;
  let authed = false;

  try {
    version = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim();
    installed = true;
  } catch {}

  // Check auth by looking for actual credential files, not just the directory
  if (installed) {
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      // .claude/credentials.json or .claude/.credentials are the real auth artifacts
      authed = fs.existsSync(path.join(claudeDir, "credentials.json")) ||
               fs.existsSync(path.join(claudeDir, ".credentials")) ||
               fs.existsSync(path.join(claudeDir, "statsig", "cache"));
    } catch {}
  }

  res.json({ installed, version, authed, https: useHttps });
});

// Serve config
app.get("/config", (req, res) => {
  res.json(config);
});

// Open terminal with install command (cross-platform)
app.post("/run-install", localOnly, (req, res) => {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("osascript", ["-e", `tell application "Terminal" to do script "npm install -g @anthropic-ai/claude-code && echo '\\n\\nDone! Go back to your browser.' && read"`], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "cmd", "/k", "npm install -g @anthropic-ai/claude-code"], { detached: true, stdio: "ignore" }).unref();
    } else {
      // Linux — try common terminal emulators
      const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
      let launched = false;
      for (const term of terminals) {
        try {
          if (term === "gnome-terminal") {
            spawn(term, ["--", "bash", "-c", "npm install -g @anthropic-ai/claude-code; echo 'Done! Go back to your browser.'; read"], { detached: true, stdio: "ignore" }).unref();
          } else {
            spawn(term, ["-e", "bash -c 'npm install -g @anthropic-ai/claude-code; echo Done!; read'"], { detached: true, stdio: "ignore" }).unref();
          }
          launched = true;
          break;
        } catch {}
      }
      if (!launched) return res.json({ ok: false, error: "no_terminal", platform });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open terminal with claude auth (cross-platform)
// Resolve full path to claude so Terminal can find it even if ~/.local/bin isn't in shell PATH
function findClaudePath() {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "claude"; // fallback to bare name
}

app.post("/run-auth", localOnly, (req, res) => {
  try {
    const claudePath = findClaudePath();
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("osascript", ["-e", `tell application "Terminal" to do script "${claudePath}"`], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "cmd", "/k", claudePath], { detached: true, stdio: "ignore" }).unref();
    } else {
      const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
      let launched = false;
      for (const term of terminals) {
        try {
          if (term === "gnome-terminal") {
            spawn(term, ["--", "bash", "-c", `${claudePath}; read`], { detached: true, stdio: "ignore" }).unref();
          } else {
            spawn(term, ["-e", `bash -c '${claudePath}; read'`], { detached: true, stdio: "ignore" }).unref();
          }
          launched = true;
          break;
        } catch {}
      }
      if (!launched) return res.json({ ok: false, error: "no_terminal", platform });
    }
    res.json({ ok: true, platform });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// Silent Background Install & Auth Endpoints
// ============================================

// Kick off background install of Claude Code CLI
app.post("/install-silent", localOnly, (req, res) => {
  // Already installed — skip
  if (installState.status === "installed") {
    return res.json({ ok: true, status: "installed" });
  }
  // Already in progress — don't start a second one
  if (installState.status === "installing") {
    return res.json({ ok: true, status: "installing" });
  }

  // Check if claude is already on this machine (state resets on server restart)
  try {
    execSync("claude --version 2>/dev/null", { timeout: 5000 });
    installState = { status: "installed", error: null, progress: "" };
    return res.json({ ok: true, status: "installed" });
  } catch {}

  // Detect platform
  const platform = process.platform; // "darwin", "linux", "win32"

  // Check for npm, then npx
  // Start the install
  installState = { status: "installing", error: null, progress: "" };

  // Use the official Claude Code installer (curl | sh) — works on any machine with curl
  const installCmd = `curl -fsSL https://claude.ai/install.sh | sh`;

  const shell = platform === "win32" ? "cmd" : "/bin/sh";
  const shellFlag = platform === "win32" ? "/c" : "-c";

  const child = spawn(shell, [shellFlag, installCmd], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.stdout.on("data", (data) => {
    installState.progress += data.toString();
    // Keep only last 2000 chars to avoid unbounded growth
    if (installState.progress.length > 2000) {
      installState.progress = installState.progress.slice(-2000);
    }
  });

  child.stderr.on("data", (data) => {
    installState.progress += data.toString();
    if (installState.progress.length > 2000) {
      installState.progress = installState.progress.slice(-2000);
    }
  });

  child.on("close", (code) => {
    if (code === 0) {
      installState.status = "installed";
      installState.error = null;
    } else {
      installState.status = "failed";
      installState.error = `Install exited with code ${code}. ${installState.progress.slice(-500)}`;
    }
  });

  child.on("error", (err) => {
    installState.status = "failed";
    installState.error = err.message;
  });

  child.unref();

  res.json({ ok: true, status: "installing" });
});

// Poll install progress
app.get("/install-status", localOnly, (req, res) => {
  res.json({
    status: installState.status,
    error: installState.error,
    progress: installState.progress,
  });
});

// Confirm CLI install and return auth URL for user to complete OAuth
app.post("/auth-silent", localOnly, (req, res) => {
  try {
    const version = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim();
    res.json({
      ok: true,
      version,
      authUrl: "https://claude.ai/login",
    });
  } catch {
    res.json({
      ok: false,
      error: "claude_not_installed",
      authUrl: null,
    });
  }
});

// Deep auth check — actually runs Claude to verify auth is valid
// Only used during onboarding sign-in step, NOT on every health poll
app.post("/verify-auth", localOnly, async (req, res) => {
  try {
    const version = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim();
    if (!version) return res.json({ authed: false, reason: "not_installed" });

    // Actually run Claude to test auth — this is the only reliable way
    const result = await new Promise((resolve) => {
      const proc = spawn("claude", ["-p", "say ok", "--output-format", "text"], {
        cwd: os.homedir(),
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      let done = false;
      const killTimer = setTimeout(() => {
        if (!done) { done = true; proc.kill("SIGKILL"); resolve({ authed: false, reason: "timeout" }); }
      }, 20000);
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        if (code === 0 && stdout.trim().length > 0) {
          resolve({ authed: true, version });
        } else {
          resolve({ authed: false, reason: stderr.trim() || "auth_failed" });
        }
      });
      proc.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve({ authed: false, reason: err.message });
      });
    });
    res.json(result);
  } catch (e) {
    res.json({ authed: false, reason: e.message });
  }
});

// Onboarding — save user name + bot name, mark setup complete
app.post("/setup", localOnly, (req, res) => {
  const { ownerName, botName } = req.body;
  if (!ownerName || !botName) {
    return res.status(400).json({ error: "ownerName and botName required" });
  }

  config.business = config.business || {};
  config.business.owner = ownerName.trim();
  config.business.name = botName.trim();
  config.business.greeting = `Hey ${ownerName.trim()}`;
  config.business.subtitle = "What are we working on?";
  config.business.setupComplete = true;

  // Update context to include the bot name
  if (!config.business.context) {
    config.business.context = `You are ${botName.trim()}, an AI assistant for ${ownerName.trim()}. Be direct, practical, and skip corporate speak. Think like a sharp business partner, not a chatbot. When analyzing files or writing content, always consider what the user actually needs — clarity, action items, and no fluff.`;
  }

  // Write back to config.json
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.status(500).json({ error: "Failed to save config" });
  }

  res.json({ ok: true, config });
});

// ============================================
// Integration API Endpoints
// ============================================

// List all integrations with connection status
app.get("/integrations", (req, res) => {
  const creds = loadCredentials();
  const result = integrationsRegistry.integrations.map((i) => {
    const cred = creds[i.id];
    const entry = {
      id: i.id,
      name: i.name,
      description: i.description,
      icon: i.icon,
      category: i.category,
      authType: i.authType,
      setupSteps: i.setupSteps || [],
      tokenConfig: i.tokenConfig || null,
      connected: !!(cred && cred.enabled),
      connectedAt: cred?.updatedAt || null,
    };
    if (i.authType === "local-access" && cred && cred.enabled) {
      entry.accessLevel = cred.level || "none";
      entry.directories = cred.directories || [];
    }
    if (i.authType === "oauth2") {
      entry.oauthConfigured = !!(oauthClients[i.id]?.clientId);
    }
    return entry;
  });
  res.json({ integrations: result });
});

// Auto-detect credentials from local CLI tools (gh, gcloud, etc.)
// Tries to grab an existing token so the user doesn't have to create one manually
app.post("/integrations/:id/auto-detect", localOnly, async (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Integration not found" });

  // Map of integration IDs → CLI commands that return a token
  const detectors = {
    github: { cmd: "gh", args: ["auth", "token"] },
  };

  const detector = detectors[integration.id];
  if (!detector) return res.json({ detected: false, reason: "No auto-detect for this service" });

  try {
    const token = await new Promise((resolve, reject) => {
      const proc = spawn(detector.cmd, detector.args, { timeout: 5000 });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `${detector.cmd} not authenticated`));
      });
      proc.on("error", () => reject(new Error(`${detector.cmd} CLI not installed`)));
    });

    saveCredential(integration.id, { token, type: "auto-detected" });
    res.json({ detected: true, connected: true, source: `${detector.cmd} CLI` });
  } catch (err) {
    res.json({ detected: false, reason: err.message });
  }
});

// Connect an integration (token-based, multi-field, or enable)
app.post("/integrations/:id/connect", localOnly, async (req, res) => {
  const { token, baseUrl, fields } = req.body;
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Integration not found" });

  if (integration.authType === "enable") {
    saveCredential(integration.id, { type: "enable" });
  } else if (integration.authType === "local-access") {
    const { level, directories } = req.body;
    if (!level || !["none", "limited", "full"].includes(level)) {
      return res.status(400).json({ error: "Invalid access level" });
    }
    if (level === "none") {
      deleteCredential(integration.id);
      return res.json({ ok: true, connected: false });
    }
    saveCredential(integration.id, { type: "local-access", level, directories: directories || [] });
  } else if (integration.authType === "token" || integration.authType === "custom") {
    if (fields && typeof fields === "object") {
      saveCredential(integration.id, { ...fields, type: "token" });
    } else if (token) {
      saveCredential(integration.id, { token, baseUrl: baseUrl || "", type: "token" });
    } else {
      return res.status(400).json({ error: "Token required" });
    }
  } else {
    return res.status(400).json({ error: "Use OAuth flow for this integration" });
  }

  // Auto-test: verify the MCP server actually starts
  const skipTest = integration.authType === "local-access"; // filesystem server needs dirs, tested separately
  if (!skipTest) {
    const testResult = await testMcpServer(integration.id);
    if (!testResult.ok) {
      // Credentials saved but server won't start — keep connected but warn
      return res.json({ ok: true, connected: true, warning: testResult.error || "MCP server failed to start — integration may not work in chat" });
    }
  }

  res.json({ ok: true, connected: true, verified: true });
});

// Disconnect an integration
app.post("/integrations/:id/disconnect", localOnly, (req, res) => {
  deleteCredential(req.params.id);
  res.json({ ok: true, connected: false });
});

// Show active MCP config (no secrets — for diagnostics)
app.get("/integrations/mcp-status", (req, res) => {
  const mcpConfig = buildMcpConfig();
  const servers = {};
  for (const [name, def] of Object.entries(mcpConfig.mcpServers)) {
    servers[name] = {
      command: def.command,
      args: def.args,
      envKeys: Object.keys(def.env || {}),
      hasCredentials: Object.values(def.env || {}).every((v) => !!v),
    };
  }
  res.json({
    activeServers: Object.keys(servers).length,
    servers,
    mcpFilePath: writeMcpConfigFile(),
  });
});

// Test if an MCP server can spawn (reusable function)
async function testMcpServer(integrationId) {
  const integration = integrationsRegistry.integrations.find((i) => i.id === integrationId);
  if (!integration) return { ok: false, error: "Not found" };

  const cred = getCredential(integrationId);
  if (!cred || !cred.enabled) return { ok: false, error: "Not connected" };

  // For OAuth integrations, try refreshing the token
  if (cred.type === "oauth2") {
    const token = await refreshOAuthToken(integrationId);
    return { ok: !!token, message: token ? "Token valid" : "Token refresh failed" };
  }

  // For MCP-based integrations, try spawning the server
  const [serverName, serverDef] = Object.entries(integration.mcpServers || {})[0] || [];
  if (!serverName) return { ok: false, error: "No MCP server defined" };

  const env = { ...process.env };
  for (const [envVar, credKey] of Object.entries(serverDef.envMapping || {})) {
    if (credKey.startsWith("_static:")) {
      env[envVar] = credKey.slice(8);
    } else if (cred[credKey]) {
      env[envVar] = cred[credKey];
    }
  }

  try {
    const testProc = spawn(serverDef.command, serverDef.args || [], { env, timeout: 10000 });
    let stderr = "";

    testProc.stderr.on("data", (d) => { stderr += d.toString(); });

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        testProc.kill("SIGTERM");
        resolve();
      }, 3000);

      testProc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (testProc.killed || !testProc.exitCode) {
      return { ok: true, server: serverName, status: "running" };
    } else {
      return { ok: false, server: serverName, error: stderr.slice(0, 200) || `Exit code ${testProc.exitCode}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Test endpoint (manual trigger)
app.post("/integrations/:id/test", localOnly, rateLimit(60000, 5), async (req, res) => {
  res.json(await testMcpServer(req.params.id));
});

// Configure OAuth client credentials (first-install setup)
app.post("/integrations/:id/oauth-setup", localOnly, rateLimit(60000, 5), (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: "Client ID and Client Secret required" });

  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration || integration.authType !== "oauth2") {
    return res.status(400).json({ error: "Not an OAuth integration" });
  }

  oauthClients[integration.id] = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  saveOauthClients();
  res.json({ ok: true });
});

// Check if OAuth is configured for an integration
app.get("/integrations/:id/oauth-status", (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Not found" });
  const configured = !!(oauthClients[integration.id]?.clientId);
  res.json({ configured });
});

// Get OAuth authorization URL
app.get("/integrations/:id/auth-url", rateLimit(60000, 5), (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration || integration.authType !== "oauth2") {
    return res.status(400).json({ error: "Not an OAuth integration" });
  }

  const clientId = oauthClients[integration.id]?.clientId;
  if (!clientId) {
    return res.status(400).json({ error: "needs_setup", needsSetup: true });
  }

  const state = uuidv4();
  pendingOAuthStates.set(state, { integrationId: integration.id, createdAt: Date.now() });

  // Clean old states (> 10 min)
  for (const [k, v] of pendingOAuthStates) {
    if (Date.now() - v.createdAt > 600000) pendingOAuthStates.delete(k);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://localhost:${PORT}`,
    response_type: "code",
    scope: integration.oauth.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.json({ url: `${integration.oauth.authorizationUrl}?${params}` });
});

// OAuth callback handler
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body><h2>Authorization failed</h2><p>${escapeHtml(error)}</p><script>window.close()</script></body></html>`);
  }

  const pending = pendingOAuthStates.get(state);
  if (!pending) {
    return res.status(400).send(`<html><body><h2>Invalid state</h2><p>Try again.</p><script>window.close()</script></body></html>`);
  }
  pendingOAuthStates.delete(state);

  const integration = integrationsRegistry.integrations.find((i) => i.id === pending.integrationId);
  if (!integration) {
    return res.status(400).send(`<html><body><h2>Unknown integration</h2><script>window.close()</script></body></html>`);
  }

  const clientConfig = oauthClients[integration.id];
  if (!clientConfig) {
    return res.status(500).send(`<html><body><h2>OAuth not configured</h2><script>window.close()</script></body></html>`);
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch(integration.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientConfig.clientId,
        client_secret: clientConfig.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: `http://localhost:${PORT}`,
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) {
      return res.send(`<html><body><h2>Token exchange failed</h2><p>${escapeHtml(tokens.error_description || tokens.error)}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    }

    saveCredential(integration.id, {
      type: "oauth2",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scope: tokens.scope,
    });

    // Google Workspace: write credentials for each MCP server
    if (integration.id === "google-workspace") {
      const oauthKeysJson = JSON.stringify({
        installed: {
          client_id: clientConfig.clientId,
          client_secret: clientConfig.clientSecret,
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          redirect_uris: ["http://localhost"]
        }
      });
      const tokenJson = JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || "Bearer",
        expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000
      });

      try {
        // Gmail MCP — reads from ~/.gmail-mcp/
        const gmailDir = path.join(os.homedir(), ".gmail-mcp");
        if (!fs.existsSync(gmailDir)) fs.mkdirSync(gmailDir, { recursive: true });
        fs.writeFileSync(path.join(gmailDir, "gcp-oauth.keys.json"), oauthKeysJson);
        fs.writeFileSync(path.join(gmailDir, "credentials.json"), tokenJson);

        // Calendar MCP — reads credentials.json + token.json from CREDENTIALS_PATH dir
        const calDir = path.join(os.homedir(), ".delt", "google");
        if (!fs.existsSync(calDir)) fs.mkdirSync(calDir, { recursive: true });
        fs.writeFileSync(path.join(calDir, "credentials.json"), oauthKeysJson);
        fs.writeFileSync(path.join(calDir, "token.json"), tokenJson);

        // Sheets MCP — uses env vars (handled in buildMcpConfig)
        // refresh_token is already in the saved credential
      } catch (e) {
        console.error("Failed to write Google MCP credentials:", e.message);
      }
    }

    res.send(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;">
      <div style="text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">&#10003;</div>
        <h2 style="margin:0 0 8px;">Connected!</h2>
        <p style="color:#666;" id="msg">You can close this window and return to Delt.</p>
      </div>
      <script>
        // Try postMessage to opener (works in regular browser popups)
        if (window.opener) {
          try {
            window.opener.postMessage({type:"oauth-complete",integrationId:${JSON.stringify(integration.id)}},window.location.origin);
          } catch(e) {}
        }
        // Auto-close after a short delay
        setTimeout(()=>{
          try { window.close(); } catch(e) {}
        }, 2500);
      </script>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<html><body><h2>Connection failed</h2><p>${escapeHtml(err.message)}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
  }
});

// Refresh OAuth token if expired
async function refreshOAuthToken(integrationId) {
  const cred = getCredential(integrationId);
  if (!cred || cred.type !== "oauth2" || !cred.refreshToken) return null;
  if (cred.expiresAt && Date.now() < cred.expiresAt - 60000) return cred.accessToken; // still valid

  const integration = integrationsRegistry.integrations.find((i) => i.id === integrationId);
  const clientConfig = oauthClients[integrationId];
  if (!integration || !clientConfig) return cred.accessToken;

  try {
    const tokenRes = await fetch(integration.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientConfig.clientId,
        client_secret: clientConfig.clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.access_token) {
      saveCredential(integrationId, {
        ...cred,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      });
      return tokens.access_token;
    }
  } catch (e) {
    console.error("Token refresh failed:", integrationId, e.message);
  }
  return cred.accessToken;
}

// File upload endpoint
const uploadedFileMap = new Map();

app.post("/upload", rateLimit(60000, 20), upload.array("files", 10), (req, res) => {
  const uploaded = (req.files || []).map((f) => {
    const id = path.basename(f.path);
    uploadedFileMap.set(id, f.path);
    setTimeout(() => { try { fs.unlinkSync(f.path); } catch {} uploadedFileMap.delete(id); }, 3600000);
    return { originalName: f.originalname, id, size: f.size };
  });
  res.json({ files: uploaded });
});

// ============================================
// Mobile QR Handoff API
// ============================================

// Start tunnel, generate token + QR
app.post("/mobile/start", localOnly, rateLimit(60000, 3), async (req, res) => {
  try {
    const activeSessionId = req.body?.sessionId || null;
    const url = await startTunnel(PORT);
    const token = generateMobileToken(activeSessionId);
    const authUrl = `${url}/mobile/auth?token=${token}`;

    // Generate QR code as data URL
    const qrDataUrl = await QRCode.toDataURL(authUrl, {
      width: 400,
      margin: 2,
      color: { dark: "#18182B", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    });

    res.json({
      url,
      token,
      qrData: authUrl,
      qrImage: qrDataUrl,
      status: "running",
    });
  } catch (err) {
    res.status(500).json({ error: err.message, status: "error" });
  }
});

// Tunnel status
app.get("/mobile/status", localOnly, (req, res) => {
  res.json({
    running: !!getTunnelState().tunnelProcess,
    url: getTunnelState().tunnelUrl || null,
    starting: getTunnelState().tunnelStarting,
  });
});

// Stop tunnel
app.post("/mobile/stop", localOnly, (req, res) => {
  stopTunnel();
  res.json({ ok: true, status: "stopped" });
});

// Mobile auth — validates one-time token, sets session cookie, redirects to /
app.get("/mobile/auth", rateLimit(60000, 10), (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(404).end();
  }

  const result = validateMobileToken(token);
  if (result && result.valid) {
    const sessionValue = createMobileSession();
    const isSecure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
    res.cookie("delt-mobile-auth", sessionValue, {
      maxAge: MOBILE_SESSION_TTL,
      httpOnly: true,
      sameSite: isSecure ? "none" : "lax",
      secure: isSecure,
      path: "/",
    });
    // Redirect to app with session ID so phone auto-resumes computer's conversation
    const redirectUrl = result.sessionId ? `/?resumeSession=${result.sessionId}` : "/";
    // Use HTTP 302 redirect — more reliable cookie propagation than JS redirect
    return res.redirect(redirectUrl);
  }

  return res.status(404).end();
});

// ============================================
// Log API endpoints
// ============================================

// List daily logs (dates available)
app.get("/logs/daily", (req, res) => {
  const files = listLogFiles(dailyDir);
  const days = files.map((f) => {
    const date = f.replace(".json", "");
    const entries = readLogFile(path.join(dailyDir, f));
    return {
      date,
      count: entries.length,
      totalCost: entries.reduce((s, e) => s + (e.costUsd || 0), 0),
    };
  });
  res.json({ days });
});

// Get a specific day's logs
app.get("/logs/daily/:date", (req, res) => {
  const date = safeName(req.params.date);
  const file = path.join(dailyDir, `${date}.json`);
  res.json({ date, entries: readLogFile(file) });
});

// List weekly logs
app.get("/logs/weekly", (req, res) => {
  const files = listLogFiles(weeklyDir);
  const weeks = files.map((f) => {
    const week = f.replace(".json", "");
    const entries = readLogFile(path.join(weeklyDir, f));
    return {
      week,
      count: entries.length,
      totalCost: entries.reduce((s, e) => s + (e.costUsd || 0), 0),
    };
  });
  res.json({ weeks });
});

// Get a specific week's logs
app.get("/logs/weekly/:week", (req, res) => {
  const week = safeName(req.params.week);
  const file = path.join(weeklyDir, `${week}.json`);
  res.json({ week, entries: readLogFile(file) });
});

// List user logs
app.get("/logs/users", (req, res) => {
  const files = listLogFiles(userDir);
  const users = files.map((f) => {
    const name = f.replace(".json", "");
    const entries = readLogFile(path.join(userDir, f));
    const lastActive = entries.length ? entries[entries.length - 1].timestamp : null;
    return {
      name,
      count: entries.length,
      totalCost: entries.reduce((s, e) => s + (e.costUsd || 0), 0),
      lastActive,
    };
  });
  res.json({ users });
});

// Get a specific user's logs
app.get("/logs/users/:name", (req, res) => {
  const name = safeName(req.params.name);
  const file = path.join(userDir, `${name}.json`);
  res.json({ user: name, entries: readLogFile(file) });
});

// Session summary — powers the welcome screen activity widget
app.get("/logs/summary", (req, res) => {
  const today = todayStr();
  const todayEntries = readLogFile(path.join(dailyDir, `${today}.json`));

  const thisWeek = weekStr(new Date());
  const weekEntries = readLogFile(path.join(weeklyDir, `${thisWeek}.json`));

  // Top tools this week
  const toolCounts = {};
  for (const e of weekEntries) {
    for (const t of e.toolsUsed || []) {
      toolCounts[t] = (toolCounts[t] || 0) + 1;
    }
  }
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Recent conversations (last 5 today, most recent first)
  const recent = [...todayEntries].reverse().slice(0, 5).map((e) => ({
    timestamp: e.timestamp,
    userMessage: (e.userMessage || "").slice(0, 120),
    assistantMessage: (e.assistantMessage || "").slice(0, 120),
    toolsUsed: e.toolsUsed || [],
    durationMs: e.durationMs || 0,
    costUsd: e.costUsd || 0,
  }));

  res.json({
    today: {
      date: today,
      count: todayEntries.length,
      totalCost: todayEntries.reduce((s, e) => s + (e.costUsd || 0), 0),
      totalDurationMs: todayEntries.reduce((s, e) => s + (e.durationMs || 0), 0),
    },
    week: {
      week: thisWeek,
      count: weekEntries.length,
      totalCost: weekEntries.reduce((s, e) => s + (e.costUsd || 0), 0),
    },
    topTools,
    recent,
  });
});

// ============================================
// Conversation history persistence
// ============================================
const historyDir = path.join(__dirname, "history");
if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

// Create history entry immediately when user sends first message
function createConversationEntry(sessionId, userMessage, tag) {
  const metaFile = path.join(historyDir, `${sessionId}.json`);
  const meta = {
    sessionId,
    title: (userMessage || "").slice(0, 80).replace(/\n/g, " ") || "Untitled",
    tag: tag || "chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 1,
    messages: [
      { role: "user", text: (userMessage || "").slice(0, 300), ts: new Date().toISOString() },
    ],
  };
  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch (e) { console.error("Failed to save conversation:", e.message); }
  return meta;
}

// Update history with assistant response (and subsequent exchanges)
function saveConversationMeta(sessionId, userMessage, assistantMessage, tag) {
  const metaFile = path.join(historyDir, `${sessionId}.json`);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
  } catch {
    meta = {
      sessionId,
      title: "",
      tag: tag || "chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      messages: [],
    };
  }

  if (!meta.title && userMessage) {
    meta.title = userMessage.slice(0, 80).replace(/\n/g, " ");
  }
  if (tag) meta.tag = tag;

  meta.updatedAt = new Date().toISOString();

  // If createConversationEntry already added the user message, just add assistant
  const lastMsg = meta.messages[meta.messages.length - 1];
  const userAlreadyAdded = lastMsg && lastMsg.role === "user" && lastMsg.text === (userMessage || "").slice(0, 300);

  if (!userAlreadyAdded && userMessage) {
    meta.messages.push({ role: "user", text: (userMessage || "").slice(0, 300), ts: new Date().toISOString() });
    meta.messageCount++;
  }
  if (assistantMessage) {
    meta.messages.push({ role: "assistant", text: (assistantMessage || "").slice(0, 300), ts: new Date().toISOString() });
    meta.messageCount++;
  }

  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch (e) { console.error("Failed to save conversation:", e.message); }
  return meta;
}

function listConversations() {
  try {
    return fs.readdirSync(historyDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(historyDir, f), "utf-8"));
          return {
            sessionId: meta.sessionId,
            title: meta.title || "Untitled",
            tag: meta.tag || "chat",
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            messageCount: meta.messageCount || 0,
            preview: meta.messages?.[0]?.text?.slice(0, 100) || "",
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch {
    return [];
  }
}

function getConversation(sessionId) {
  const file = path.join(historyDir, `${sessionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// History API endpoints
app.get("/history", (req, res) => {
  res.json({ conversations: listConversations() });
});

app.get("/history/:sessionId", (req, res) => {
  const convo = getConversation(safeName(req.params.sessionId));
  if (!convo) return res.status(404).json({ error: "Not found" });
  res.json(convo);
});

// ============================================
// Memory API (backed by lib/memory.js)
// ============================================
const { userMemFile, memSessionsDir, memDailyDir } = memoryLib.getPaths();

app.get("/memory", (req, res) => {
  res.json({
    user: safeRead(userMemFile),
    state: getStateContext(),
    daily: safeRead(path.join(memDailyDir, `${todayStr()}.md`)),
    meta: memoryLib.readMemMeta(),
  });
});

app.put("/memory", (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  safeWrite(userMemFile, content);
  res.json({ ok: true });
});

app.get("/memory/session/:sid", (req, res) => {
  const sid = safeName(req.params.sid);
  const content = safeRead(path.join(memSessionsDir, `${sid}.md`));
  res.json({ sessionId: sid, content });
});

// Active sessions
const sessions = new Map();

// Cross-device sync: sessionId → Set of WebSocket clients
const sessionClients = new Map();

function broadcastToSession(sessionId, data, excludeWs) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const client of clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      safeSend(client, data);
    }
  }
}

function registerClient(sessionId, ws) {
  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(ws);
}

function unregisterClient(ws) {
  for (const [sid, clients] of sessionClients) {
    clients.delete(ws);
    if (clients.size === 0) sessionClients.delete(sid);
  }
}

// Generate integrations context for Claude — includes capabilities and creation routing
function buildIntegrationsContext() {
  const creds = loadCredentials();
  const connected = [];

  for (const integration of integrationsRegistry.integrations) {
    const cred = creds[integration.id];
    if (!cred || !cred.enabled) continue;
    connected.push(integration);
  }

  if (!connected.length) return "";

  // Build detailed capability lines for each integration
  const lines = connected.map((i) => {
    const tools = Object.keys(i.mcpServers || {}).map((s) => `mcp__${s}__*`).join(", ");
    const caps = i.capabilities || {};
    let line = `- **${i.name}** (${tools})`;
    if (caps.can && caps.can.length) line += `\n  Can: ${caps.can.join("; ")}`;
    if (caps.creates && caps.creates.length) line += `\n  Creates: ${caps.creates.join(", ")}`;
    if (caps.limitations && caps.limitations.length) line += `\n  Limitations: ${caps.limitations.join("; ")}`;
    return line;
  });

  // Build creation routing map — what can be created and which integration handles it
  const creationMap = [];
  for (const i of connected) {
    const caps = i.capabilities || {};
    if (caps.creates && caps.creates.length) {
      for (const item of caps.creates) {
        const tools = Object.keys(i.mcpServers || {}).map((s) => `mcp__${s}__*`).join(", ");
        creationMap.push(`  "${item}" → ${i.name} (${tools})`);
      }
    }
  }

  // Local access context
  let localCtx = "";
  const localCred = creds["local-access"];
  if (localCred && localCred.enabled) {
    if (localCred.level === "full") {
      localCtx = "\n\n[LOCAL COMPUTER ACCESS: FULL — You have unrestricted filesystem access to this Mac via mcp__filesystem__* tools. You can read, write, search, and manage files anywhere in the user's home directory.]";
    } else if (localCred.level === "limited") {
      const dirs = (localCred.directories || []).join(", ");
      localCtx = `\n\n[LOCAL COMPUTER ACCESS: LIMITED — You have filesystem access ONLY to these directories: ${dirs}. Use mcp__filesystem__* tools.]`;
    }
  } else {
    localCtx = "\n\n[LOCAL COMPUTER ACCESS: NONE — You do NOT have filesystem access. If the user asks you to work with local files, tell them to enable Local Computer access in the Integrations panel.]";
  }

  return `[CONNECTED INTEGRATIONS — the user has linked these services. ALWAYS use the MCP tools listed below. NEVER use local apps (Mail.app, Calendar.app, etc.), AppleScript, or osascript.

${lines.join("\n")}

CREATION ROUTING — When the user says "create", "make", "build", "set up", "draft", or "send" something, route to the right integration:
${creationMap.join("\n")}
  "Website / landing page / UI / design mockup" → Build as HTML/CSS file and serve or deploy it
  "Document / report / analysis" → Build as markdown or HTML, then email or save to connected service

INTUITIVE BEHAVIOR RULES:
- When the user says "create a X", just do it. Don't ask which tool to use — pick the best connected integration and execute.
- If no connected integration can create what they asked for, build it as a file (HTML, MD, PDF) and offer to send/deploy it.
- If an integration is read-only for what they want (e.g. Figma for design creation), say so briefly and immediately offer the alternative (build as code).
- Never say "I can't do that" without offering what you CAN do instead.
- If a tool call fails, try once more, then tell the user what happened — don't loop.

When the user asks you to do something with a connected service, use the corresponding MCP tools. If a tool call fails, tell the user — don't fall back to local apps.]${localCtx}

`;
}

wss.on("connection", (ws, req) => {
  const _remoteAddr = req?.socket?.remoteAddress || "";
  const isRemote = !(_remoteAddr === "127.0.0.1" || _remoteAddr === "::1" || _remoteAddr === "::ffff:127.0.0.1");

  // Authenticate remote WebSocket connections via mobile session cookie
  if (isRemote) {
    const cookies = tunnel.parseCookies(req);
    if (!cookies["delt-mobile-auth"] || !tunnel.validateMobileSession(cookies["delt-mobile-auth"])) {
      ws.close(4401, "Unauthorized");
      return;
    }
  }

  let sessionId = null;

  ws._deltAlive = true;
  ws.on("pong", () => { ws._deltAlive = true; });

  ws.on("close", () => unregisterClient(ws));
  let currentProcess = null;
  let messageCount = 0;

  // BTW side-panel state
  let btwSessionId = null;
  let btwProcess = null;
  let btwMessageCount = 0;
  const btwQueue = [];

  // Pane 2 state
  let pane2SessionId = null;
  let pane2Process = null;
  let pane2MessageCount = 0;

  // Logging state per exchange
  let currentUserMessage = "";
  let currentAssistantText = "";
  let currentToolsUsed = [];
  let currentCost = 0;
  let exchangeStart = 0;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Keep tunnel alive while remote clients are active
    if (isRemote) touchTunnelActivity();

    if (msg.type === "chat") {
      if (currentProcess) {
        safeSend(ws, { type: "error", message: "Still working on your last request. One sec." });
        return;
      }

      // Reset logging state for this exchange
      currentAssistantText = "";
      currentToolsUsed = [];
      currentCost = 0;
      exchangeStart = Date.now();

      let { message, filePaths } = msg;
      currentUserMessage = message || "";

      // Prepend file context — resolve upload IDs to server paths
      if (filePaths && filePaths.length > 0) {
        const fileList = filePaths
          .map((f) => {
            const serverPath = uploadedFileMap.get(f.id) || f.path || f.id;
            return `- ${f.originalName}: ${serverPath}`;
          })
          .join("\n");
        message = `The user has uploaded these files:\n${fileList}\n\nTheir request: ${message}`;
      }

      // Create session on first message
      if (!sessionId) {
        sessionId = uuidv4();
        messageCount = 0;
        sessions.set(sessionId, { created: Date.now() });
        registerClient(sessionId, ws);
        safeSend(ws, { type: "session", sessionId });
      }

      const isFirst = messageCount === 0;
      messageCount++;

      // Save to history + session log immediately on send
      try {
        if (isFirst) {
          createConversationEntry(sessionId, currentUserMessage, "chat");
        } else {
          saveConversationMeta(sessionId, currentUserMessage, null, "chat");
        }
        appendSessionLog(sessionId, "user", currentUserMessage);
      } catch {}

      // Prepend business context on first message
      let fullMessage;
      if (isFirst) {
        let prefix = buildSystemPrefix(config, buildIntegrationsContext);
        // Inject remote access context so Claude uses tunnel URL instead of localhost
        if (isRemote) {
          const { tunnelUrl } = getTunnelState();
          if (tunnelUrl) {
            prefix += `[REMOTE ACCESS: The user is accessing Delt from a different device (phone/tablet) via ${tunnelUrl}. NEVER reference localhost or 127.0.0.1 — use ${tunnelUrl} for any URLs you share. If you create files that need to be viewed, serve them through Delt's public path (e.g. ${tunnelUrl}/filename.html) or offer to deploy them.]\n\n`;
          } else {
            prefix += `[REMOTE ACCESS: The user is accessing Delt from a different device. NEVER reference localhost — any local files or URLs won't be accessible. Offer to deploy, email, or use a connected service to share content instead.]\n\n`;
          }
        }
        fullMessage = prefix + message;
      } else {
        fullMessage = message;
      }

      const args = buildClaudeArgs(fullMessage);

      if (isFirst) {
        args.push("--session-id", sessionId);
      } else {
        args.push("--resume", sessionId);
      }

      const proc = spawn("claude", args, {
        cwd: os.homedir(),
        env: { ...process.env },
      });

      currentProcess = proc;
      spawnWithTimeout(proc, ws, "error");
      safeSend(ws, { type: "thinking" });
      broadcastToSession(sessionId, { type: "thinking" }, ws);
      broadcastToSession(sessionId, { type: "sync-user", message: currentUserMessage }, ws);

      attachStreamHandlers(proc, ws, {
        streamType: "stream",
        errorType: "error",
        onText: (text, toolName) => {
          if (text) currentAssistantText += text;
          if (toolName) currentToolsUsed.push(toolName);
        },
        onCost: (cost) => { currentCost = cost; },
        onBroadcast: (data) => { broadcastToSession(sessionId, { type: "stream", data }, ws); },
        onClose: (code) => {
          try {
            logConversation({
              sessionId,
              user: config.business?.owner || "User",
              userMessage: currentUserMessage,
              assistantMessage: currentAssistantText,
              toolsUsed: [...new Set(currentToolsUsed)],
              costUsd: currentCost,
              durationMs: Date.now() - exchangeStart,
            }, config);
          } catch (e) { console.error("Log write failed:", e.message); }
          try {
            saveConversationMeta(sessionId, currentUserMessage, currentAssistantText);
          } catch (e) { console.error("History save failed:", e.message); }
          persistExchange(sessionId, currentUserMessage, currentAssistantText, "chat");
          safeSend(ws, { type: "done", code });
          broadcastToSession(sessionId, { type: "done", code }, ws);
          currentProcess = null;
        },
      });
    }

    if (msg.type === "stop") {
      if (currentProcess) {
        currentProcess.kill("SIGINT");
        safeSend(ws, { type: "stopped" });
      }
    }

    if (msg.type === "resume-session") {
      if (currentProcess) currentProcess.kill("SIGINT");
      unregisterClient(ws);
      sessionId = msg.sessionId;
      messageCount = 1; // Not first message, so --resume will be used
      sessions.set(sessionId, { created: Date.now() });
      registerClient(sessionId, ws);
      safeSend(ws, { type: "session", sessionId });
      safeSend(ws, { type: "resumed", sessionId });
    }

    if (msg.type === "new-chat") {
      if (currentProcess) {
        currentProcess.kill("SIGINT");
      }
      sessionId = null;
      messageCount = 0;
      safeSend(ws, { type: "cleared" });
    }

    // ============================================
    // BTW — Side panel subagent orchestrator
    // ============================================
    if (msg.type === "btw") {
      if (btwProcess) {
        btwQueue.push(msg);
        return;
      }

      let { message } = msg;
      if (!message) return;

      // Track for history
      let btwUserMessage = message;
      let btwAssistantText = "";

      if (!btwSessionId) {
        btwSessionId = uuidv4();
        btwMessageCount = 0;
      }

      const isFirst = btwMessageCount === 0;
      btwMessageCount++;

      // Save to history immediately
      try {
        if (isFirst) {
          createConversationEntry(btwSessionId, btwUserMessage, "multitask");
        } else {
          saveConversationMeta(btwSessionId, btwUserMessage, null, "multitask");
        }
        appendSessionLog(btwSessionId, "user", btwUserMessage);
      } catch {}

      const btwMemory = safeRead(userMemFile);
      const btwState = getStateContext();
      const btwPrefix = isFirst ? `[CONTEXT: You are running in BTW mode — a side-thread orchestrator. ${config.business?.context || ""}
${btwMemory ? `\nUSER MEMORY:\n${btwMemory}\n` : ""}${btwState ? `\nWHERE WE LEFT OFF:\n${btwState}\n` : ""}

ORCHESTRATOR RULES:
- You can and SHOULD use the Agent tool to delegate work to subagents when tasks are parallelizable.
- Break complex requests into subtasks and run them concurrently via Agent subagents.
- For research: spawn Explore agents. For code changes: spawn general-purpose agents.
- Summarize subagent results rather than dumping raw output.
- If a task is simple enough to handle directly, just do it. Don't over-delegate.
- You have full tool access: Read, Write, Edit, Bash, Grep, Glob, Agent, WebSearch, WebFetch.
- Think of yourself as a dispatch center: receive the request, decide the fastest path, execute or delegate, report back.

FORMATTING RULES — CRITICAL. The user does NOT read long text. They SCAN. Format every response for visual scanners:
- **Lead with the answer.** First line is a bold one-liner headline or the single most important fact. No preamble.
- **Use headers (## and ###)** to break every section. Never write more than 3-4 lines without a header.
- **Bold every key name, number, price, date, and decision point.** If it matters, it's bold. When in doubt, bold it.
- **Use blockquotes (>) for key stats or callouts.** Put the single most important number/fact in a blockquote so it visually pops out like a card.
- **Use tables for any comparison** — people, companies, prices, features. Tables over bullet lists whenever there are 3+ items with multiple attributes.
- **Bullet points must have bold leads.** Example: "- **Jason Walters Group** — eXp Realty, top-rated in Camarillo"
- **Keep paragraphs to 1-2 sentences max.** If it's longer, break it up or use bullets.
- **End with a clear action prompt** — one line, what you can dig into next.
- Never dump a wall of text. If your response doesn't have headers, bold, and structure, rewrite it.
- Think: if someone glanced at this for 3 seconds, would they get the key takeaway? If not, restructure.]\n\n` : "";

      const fullMessage = btwPrefix + message;

      const args = buildClaudeArgs(fullMessage);

      if (isFirst) {
        args.push("--session-id", btwSessionId);
      } else {
        args.push("--resume", btwSessionId);
      }

      const proc = spawn("claude", args, {
        cwd: os.homedir(),
        env: { ...process.env },
      });

      btwProcess = proc;
      spawnWithTimeout(proc, ws, "btw-error");
      safeSend(ws, { type: "btw-thinking" });

      attachStreamHandlers(proc, ws, {
        streamType: "btw-stream",
        errorType: "btw-error",
        onText: (text) => { if (text) btwAssistantText += text; },
        onClose: (code) => {
          try { saveConversationMeta(btwSessionId, btwUserMessage, btwAssistantText, "multitask"); } catch {}
          persistExchange(btwSessionId, btwUserMessage, btwAssistantText, "multitask");
          safeSend(ws, { type: "btw-done", code });
          btwProcess = null;
          if (btwQueue.length) {
            ws.emit("message", JSON.stringify(btwQueue.shift()));
          }
        },
      });
    }

    if (msg.type === "btw-stop") {
      if (btwProcess) {
        btwProcess.kill("SIGINT");
        safeSend(ws, { type: "btw-stopped" });
        btwProcess = null;
      }
    }

    if (msg.type === "btw-clear") {
      if (btwProcess) btwProcess.kill("SIGINT");
      btwSessionId = null;
      btwMessageCount = 0;
      btwProcess = null;
      safeSend(ws, { type: "btw-cleared" });
    }

    // ============================================
    // Pane 2 — Second chat session
    // ============================================
    if (msg.type === "pane2-chat") {
      if (pane2Process) {
        safeSend(ws, { type: "pane2-error", message: "Still working. Hold on." });
        return;
      }

      let { message, sessionId: reqSid } = msg;
      if (!message) return;

      if (!pane2SessionId) {
        pane2SessionId = uuidv4();
        pane2MessageCount = 0;
      }

      const isFirst = pane2MessageCount === 0;
      pane2MessageCount++;

      const prefix = isFirst ? buildSystemPrefix(config, buildIntegrationsContext) : "";
      const fullMessage = prefix + message;

      const args = buildClaudeArgs(fullMessage);
      if (isFirst) {
        args.push("--session-id", pane2SessionId);
      } else {
        args.push("--resume", pane2SessionId);
      }

      const proc = spawn("claude", args, { cwd: os.homedir(), env: { ...process.env } });
      pane2Process = proc;
      spawnWithTimeout(proc, ws, "pane2-error");
      safeSend(ws, { type: "pane2-session", sessionId: pane2SessionId });
      safeSend(ws, { type: "pane2-thinking" });

      attachStreamHandlers(proc, ws, {
        streamType: "pane2-stream",
        errorType: "pane2-error",
        onClose: (code) => {
          safeSend(ws, { type: "pane2-done", code });
          pane2Process = null;
        },
      });
    }

    if (msg.type === "pane2-stop") {
      if (pane2Process) {
        pane2Process.kill("SIGINT");
        safeSend(ws, { type: "pane2-done" });
        pane2Process = null;
      }
    }
  });

  ws.on("close", () => {
    if (currentProcess) { currentProcess.kill("SIGINT"); currentProcess = null; }
    if (btwProcess) { btwProcess.kill("SIGINT"); btwProcess = null; }
    if (pane2Process) { pane2Process.kill("SIGINT"); pane2Process = null; }
    if (sessionId) sessions.delete(sessionId);
    // Batch extract memories from the entire session
    flushMemoryExtraction(config);
  });
});

// ============================================
// Signup API — email + Google Sheets
// ============================================

// Serve demo page — inject current port so signup works regardless of access method
app.get("/demo", (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "demo.html"), "utf-8");
  const injected = html.replace("<html", `<html data-delt-port="${PORT}"`);
  res.type("html").send(injected);
});

// Gmail transporter (lazy init)
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return mailTransporter;
}

// Google Sheets append via raw API (no googleapis SDK — saves 194MB)
async function createServiceAccountJwt(keyData) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: keyData.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(keyData.private_key, "base64url");
  return `${header}.${payload}.${signature}`;
}

let sheetsAccessToken = null;
let sheetsTokenExpiry = 0;

async function getSheetsToken() {
  if (sheetsAccessToken && Date.now() < sheetsTokenExpiry) return sheetsAccessToken;

  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return null;

  try {
    const key = keyJson.startsWith("{")
      ? JSON.parse(keyJson)
      : JSON.parse(fs.readFileSync(keyJson, "utf-8"));

    const jwt = await createServiceAccountJwt(key);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const data = await res.json();
    if (data.access_token) {
      sheetsAccessToken = data.access_token;
      sheetsTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return sheetsAccessToken;
    }
  } catch (e) {
    console.error("Sheets auth failed:", e.message);
  }
  return null;
}

async function appendToSheet(spreadsheetId, range, values) {
  const token = await getSheetsToken();
  if (!token) return false;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  return res.ok;
}

// Generate vCard for contact
function generateVCard(name, email) {
  const firstName = name || email.split("@")[0];
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${firstName}`,
    `N:;${firstName};;;`,
    `EMAIL;TYPE=INTERNET:${email}`,
    `NOTE:Delt early access signup — ${new Date().toISOString().split("T")[0]}`,
    "END:VCARD",
  ].join("\r\n");
}

// Local signup log (fallback + backup)
const signupsPath = path.join(__dirname, "signups.json");
function logSignupLocally(entry) {
  let signups = [];
  try { signups = JSON.parse(fs.readFileSync(signupsPath, "utf-8")); } catch {}
  signups.push(entry);
  try { fs.writeFileSync(signupsPath, JSON.stringify(signups, null, 2)); } catch (e) { console.error("Failed to log signup:", e.message); }
}

app.post("/api/signup", rateLimit(60000, 5), async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }

  const displayName = name || email.split("@")[0];
  const timestamp = new Date().toISOString();
  const results = { email: true, notification: false, sheet: false };

  // Always log locally as backup
  logSignupLocally({ email, name: displayName, timestamp });

  // 1. Send thank-you email to the signup
  const transporter = getMailTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Neonotics" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: "Welcome to Delt — You're on the list",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #18182B;">
            <div style="text-align: center; margin-bottom: 32px;">
              <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #6C5CE7, #06B6D4); color: #fff; font-weight: 800; font-size: 20px;">D</div>
            </div>
            <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 16px; text-align: center;">Thank you for your interest in Delt</h1>
            <p style="font-size: 15px; line-height: 1.7; color: #5C5C72; margin-bottom: 20px;">
              Hey ${displayName},
            </p>
            <p style="font-size: 15px; line-height: 1.7; color: #5C5C72; margin-bottom: 20px;">
              You're on the early access list for Delt — the AI assistant that connects to your tools and actually does things. Gmail, Slack, GitHub, Notion, Stripe, and more, all through one conversation.
            </p>
            <p style="font-size: 15px; line-height: 1.7; color: #5C5C72; margin-bottom: 20px;">
              We're letting people in weekly. When it's your turn, you'll get an invite with everything you need to get started.
            </p>
            <p style="font-size: 15px; line-height: 1.7; color: #5C5C72; margin-bottom: 32px;">
              In the meantime — if you have questions, just reply to this email. A real person reads it.
            </p>
            <div style="border-top: 1px solid #E3E3E8; padding-top: 20px; text-align: center;">
              <p style="font-size: 13px; color: #9494A8; margin: 0;">
                Delt by <a href="mailto:neonotics@gmail.com" style="color: #6C5CE7; text-decoration: none;">Neonotics</a>
              </p>
            </div>
          </div>
        `,
      });
      results.email = true;
    } catch (e) {
      console.error("Failed to send thank-you email:", e.message);
      results.email = false;
    }

    // 2. Send notification + vCard to neonotics@gmail.com
    try {
      const vcard = generateVCard(displayName, email);
      await transporter.sendMail({
        from: `"Delt Signups" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `Delt — New signup: ${displayName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; padding: 32px 24px; color: #18182B;">
            <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 20px;">Delt</h1>
            <div style="background: #F7F7F8; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #E3E3E8;">
              <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600;">${displayName}</p>
              <p style="margin: 0 0 4px 0; font-size: 14px; color: #5C5C72;">
                <a href="mailto:${email}" style="color: #6C5CE7; text-decoration: none;">${email}</a>
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; color: #9494A8;">Signed up: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
            </div>
            <p style="font-size: 13px; color: #9494A8;">Contact card attached. Save it to your contacts.</p>
          </div>
        `,
        attachments: [
          {
            filename: `${displayName.replace(/[^a-zA-Z0-9]/g, "_")}.vcf`,
            content: vcard,
            contentType: "text/vcard",
          },
        ],
      });
      results.notification = true;
    } catch (e) {
      console.error("Failed to send notification email:", e.message);
    }
  } else {
    console.warn("GMAIL_APP_PASSWORD not set — emails skipped. Signup logged locally.");
  }

  // 3. Append to Google Sheet
  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID;
    if (sheetId) {
      const ok = await appendToSheet(sheetId, "Sheet1!A:D", [[timestamp, displayName, email, "early-access"]]);
      results.sheet = ok;
      if (!ok) console.warn("Sheets append returned non-OK response.");
    } else {
      console.warn("Google Sheets not configured — signup logged locally only.");
    }
  } catch (e) {
    console.error("Failed to append to Google Sheet:", e.message);
  }

  console.log(`[signup] ${displayName} <${email}> — email:${results.email} notify:${results.notification} sheet:${results.sheet}`);
  res.json({ ok: true, results });
});

// ============================================
// Graceful shutdown + error handling
// ============================================

function killAllChildren() {
  wss.clients.forEach((client) => {
    try { client.close(); } catch {}
  });
}

function gracefulShutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  cleanupTunnel();
  killAllChildren();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.stack || err);
  // Don't exit — server stays alive. Log to file for diagnostics.
  try {
    const errLog = path.join(os.homedir(), ".delt", "crash.log");
    fs.appendFileSync(errLog, `[${new Date().toISOString()}] uncaughtException: ${err.stack || err}\n`);
  } catch {}
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  try {
    const errLog = path.join(os.homedir(), ".delt", "crash.log");
    fs.appendFileSync(errLog, `[${new Date().toISOString()}] unhandledRejection: ${err?.stack || err}\n`);
  } catch {}
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Is Delt already running?\n`);
    process.exit(1);
  }
  console.error("Server error:", err);
});

server.listen(PORT, "127.0.0.1", () => {
  const proto = useHttps ? "https" : "http";
  console.log(`\n  ${config.business?.name || "Delt"} is running!`);
  console.log(`  ${proto}://localhost:${PORT}`);

  // Disk space check — warn if low
  try {
    const { execSync: exec } = require("child_process");
    const dfOut = exec("df -k " + JSON.stringify(os.homedir()), { timeout: 3000 }).toString();
    const lines = dfOut.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const availKB = parseInt(parts[3], 10);
      if (availKB < 100 * 1024) { // < 100MB
        console.warn(`\n  ⚠ Low disk space: ${Math.round(availKB / 1024)}MB free. Logs and history may fail to save.\n`);
      }
    }
  } catch {}
  if (useHttps) {
    console.log(`  HTTPS enabled (self-signed cert at ~/.delt/certs/)`);
  }
  console.log(`  Bound to localhost only — not accessible from other devices.\n`);

  // Discovery beacon — fixed port so installer/demo pages can find the real server
  const DISCOVERY_PORT = 45100;
  const discoveryServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ port: PORT, url: `${proto}://localhost:${PORT}` }));
  });
  discoveryServer.listen(DISCOVERY_PORT, "127.0.0.1", () => {}).on("error", () => {});
});
