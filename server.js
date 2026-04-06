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
const crypto = require("crypto");
const multer = require("multer");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

// ============================================
// Local HTTPS — auto-generated self-signed cert
// ============================================
const CERT_DIR = path.join(os.homedir(), ".delt", "certs");
const CERT_PATH = path.join(CERT_DIR, "localhost.crt");
const KEY_PATH = path.join(CERT_DIR, "localhost.key");

function ensureCerts() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    try {
      const certPem = fs.readFileSync(CERT_PATH, "utf-8");
      if (certPem.includes("-----BEGIN CERTIFICATE-----")) {
        return { cert: certPem, key: fs.readFileSync(KEY_PATH, "utf-8") };
      }
    } catch {}
  }

  // Generate self-signed cert via openssl (available on macOS and most Linux)
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
    return { cert: fs.readFileSync(CERT_PATH, "utf-8"), key: fs.readFileSync(KEY_PATH, "utf-8") };
  } catch (e) {
    console.warn("  [HTTPS] Could not generate cert — falling back to HTTP:", e.message);
    return null;
  }
}

const tlsCerts = ensureCerts();

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

let integrationsRegistry = { integrations: [] };
try {
  integrationsRegistry = JSON.parse(fs.readFileSync(integrationsPath, "utf-8"));
} catch {}

let oauthClients = {};
try {
  oauthClients = JSON.parse(fs.readFileSync(oauthClientsPath, "utf-8"));
} catch {}

// Encryption using a random key persisted in a restricted file
const keyFilePath = path.join(os.homedir(), ".delt", "encryption.key");

function getEncryptionKey() {
  const keyDir = path.dirname(keyFilePath);
  if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });

  try {
    const buf = fs.readFileSync(keyFilePath);
    if (buf.length === 32) return buf;
  } catch {}

  // First run — generate and store a random 256-bit key
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
  return key;
}

function encryptData(data) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), tag, data: encrypted };
}

function decryptData(encObj) {
  const key = getEncryptionKey();
  const iv = Buffer.from(encObj.iv, "hex");
  const tag = Buffer.from(encObj.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encObj.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

// Legacy key for migration from deterministic encryption
function getLegacyEncryptionKey() {
  const raw = `delt:${os.hostname()}:${os.userInfo().username}:${__dirname}`;
  return crypto.createHash("sha256").update(raw).digest();
}

function decryptWithLegacyKey(encObj) {
  const key = getLegacyEncryptionKey();
  const iv = Buffer.from(encObj.iv, "hex");
  const tag = Buffer.from(encObj.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encObj.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

function loadCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    try {
      return decryptData(raw);
    } catch {
      // Try legacy key and migrate if successful
      const creds = decryptWithLegacyKey(raw);
      console.log("[Security] Migrating credentials to new encryption key");
      saveCredentials(creds);
      return creds;
    }
  } catch {
    return {};
  }
}

function saveCredentials(creds) {
  const encrypted = encryptData(creds);
  const tmpFile = credentialsPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(encrypted), { mode: 0o600 });
  fs.renameSync(tmpFile, credentialsPath);
}

function getCredential(integrationId) {
  const creds = loadCredentials();
  return creds[integrationId] || null;
}

function saveCredential(integrationId, data) {
  const creds = loadCredentials();
  creds[integrationId] = { ...data, enabled: true, updatedAt: new Date().toISOString() };
  saveCredentials(creds);
  invalidateMcpCache();
  writeIntegrationsMd();
}

function deleteCredential(integrationId) {
  const creds = loadCredentials();
  delete creds[integrationId];
  saveCredentials(creds);
  invalidateMcpCache();
  writeIntegrationsMd();
}

// Write persistent integrations.md so Claude always knows what's connected
function writeIntegrationsMd() {
  const creds = loadCredentials();
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

// Build MCP config from enabled integrations
function buildMcpConfig() {
  const creds = loadCredentials();
  const mcpServers = {};

  for (const integration of integrationsRegistry.integrations) {
    const cred = creds[integration.id];
    if (!cred || !cred.enabled) continue;

    for (const [serverName, serverDef] of Object.entries(integration.mcpServers || {})) {
      const env = {};
      for (const [envVar, credKey] of Object.entries(serverDef.envMapping || {})) {
        if (credKey.startsWith("_static:")) {
          env[envVar] = credKey.slice(8);
        } else {
          const val = cred[credKey];
          if (val) env[envVar] = val;
        }
      }

      // Google Workspace: inject env vars per MCP server
      if (integration.id === "google-workspace") {
        const clientConfig = oauthClients["google-workspace"];
        if (serverName === "google-calendar") {
          env.CREDENTIALS_PATH = path.join(os.homedir(), ".delt", "google", "credentials.json");
        } else if (serverName === "google-sheets" && clientConfig) {
          env.GOOGLE_SHEETS_CLIENT_ID = clientConfig.clientId;
          env.GOOGLE_SHEETS_CLIENT_SECRET = clientConfig.clientSecret;
          if (cred.refreshToken) env.GOOGLE_SHEETS_REFRESH_TOKEN = cred.refreshToken;
          if (cred.accessToken) env.GOOGLE_SHEETS_ACCESS_TOKEN = cred.accessToken;
          env.TOKEN_PATH = path.join(os.homedir(), ".delt", "google", "token.json");
        }
      }

      // Local access: append directory args based on permission level
      if (integration.id === "local-access") {
        const dirs = cred.level === "full"
          ? [os.homedir()]
          : (cred.directories || []).filter(Boolean);
        if (!dirs.length) continue; // skip if no directories configured
        mcpServers[serverName] = {
          command: serverDef.command,
          args: [...(serverDef.args || []), ...dirs],
          env,
        };
      } else {
        mcpServers[serverName] = {
          command: serverDef.command,
          args: serverDef.args || [],
          env,
        };
      }
    }
  }

  return { mcpServers };
}

// Write MCP config — cached, only rewrites when integrations change
const mcpConfigDir = path.join(os.homedir(), ".delt", "mcp");
if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true, mode: 0o700 });

let _mcpConfigCache = null;
let _mcpConfigPath = null;

function invalidateMcpCache() {
  _mcpConfigCache = null;
}

function writeMcpConfigFile() {
  const mcpConfig = buildMcpConfig();
  const serverCount = Object.keys(mcpConfig.mcpServers).length;
  if (serverCount === 0) { _mcpConfigPath = null; return null; }

  // Only rewrite if config changed
  const json = JSON.stringify(mcpConfig, null, 2);
  if (json === _mcpConfigCache) return _mcpConfigPath;

  _mcpConfigCache = json;
  _mcpConfigPath = path.join(mcpConfigDir, `mcp-${process.pid}.json`);
  fs.writeFileSync(_mcpConfigPath, json, { mode: 0o600 });
  return _mcpConfigPath;
}

// Build Claude args with MCP config injected
function buildClaudeArgs(fullMessage) {
  const args = [
    "-p", fullMessage,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  const mcpFile = writeMcpConfigFile();
  if (mcpFile) {
    args.push("--mcp-config", mcpFile);
    // Auto-allow all MCP tools — user already authorized via Delt's integrations UI
    const mcpConfig = buildMcpConfig();
    const allowedTools = Object.keys(mcpConfig.mcpServers)
      .map(name => `mcp__${name}__*`)
      .join(",");
    if (allowedTools) {
      args.push("--allowedTools", allowedTools);
    }
  }

  return args;
}

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

  proc.stderr.on("data", (chunk) => {
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
      } catch {}
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

// ============================================
// Mobile QR Handoff — Cloudflare Tunnel
// ============================================
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStarting = false;

// One-time tokens for mobile auth: token -> { createdAt, consumed }
const mobileTokens = new Map();

// Authenticated mobile sessions: cookieValue -> { createdAt }
const mobileSessions = new Map();

const MOBILE_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes
const MOBILE_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function generateMobileToken(activeSessionId) {
  const token = uuidv4();
  mobileTokens.set(token, { createdAt: Date.now(), consumed: false, sessionId: activeSessionId || null });
  setTimeout(() => mobileTokens.delete(token), MOBILE_TOKEN_TTL);
  return token;
}

function validateMobileToken(token) {
  const entry = mobileTokens.get(token);
  if (!entry) return false;
  if (entry.consumed) return false;
  if (Date.now() - entry.createdAt > MOBILE_TOKEN_TTL) {
    mobileTokens.delete(token);
    return false;
  }
  entry.consumed = true;
  mobileTokens.delete(token);
  return { valid: true, sessionId: entry.sessionId };
}

function createMobileSession() {
  const sessionValue = uuidv4();
  mobileSessions.set(sessionValue, { createdAt: Date.now() });
  // Expire session after TTL
  setTimeout(() => mobileSessions.delete(sessionValue), MOBILE_SESSION_TTL);
  return sessionValue;
}

function validateMobileSession(cookieValue) {
  const session = mobileSessions.get(cookieValue);
  if (!session) return false;
  if (Date.now() - session.createdAt > MOBILE_SESSION_TTL) {
    mobileSessions.delete(cookieValue);
    return false;
  }
  return true;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(";").forEach((c) => {
    const [name, ...rest] = c.trim().split("=");
    cookies[name] = rest.join("=");
  });
  return cookies;
}

function isLocalRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    if (tunnelProcess && tunnelUrl) {
      return resolve(tunnelUrl);
    }
    if (tunnelStarting) {
      return reject(new Error("Tunnel is already starting"));
    }

    tunnelStarting = true;
    let resolved = false;

    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.on("error", (err) => {
      tunnelStarting = false;
      if (!resolved) {
        resolved = true;
        if (err.code === "ENOENT") {
          reject(new Error("cloudflared not installed. Install it with: brew install cloudflared"));
        } else {
          reject(err);
        }
      }
    });

    // cloudflared prints the URL to stderr
    let stderrBuffer = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      // Look for the trycloudflare.com URL
      const match = stderrBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        tunnelUrl = match[0];
        tunnelProcess = proc;
        tunnelStarting = false;
        console.log("[Mobile] Tunnel ready:", tunnelUrl);
        resolve(tunnelUrl);
      }
    });

    proc.on("close", (code) => {
      tunnelStarting = false;
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        tunnelStarting = false;
        if (proc && !proc.killed) proc.kill("SIGTERM");
        reject(new Error("Tunnel startup timed out after 30 seconds"));
      }
    }, 30000);
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
    tunnelUrl = null;
    console.log("[Mobile] Tunnel stopped");
  }
}

// Cleanup tunnel on shutdown
function cleanupTunnel() {
  stopTunnel();
}

process.on("SIGTERM", cleanupTunnel);
process.on("SIGINT", () => {
  cleanupTunnel();
  process.exit(0);
});

// ============================================
// Logging infrastructure
// ============================================
const logsDir = path.join(__dirname, "logs");
const dailyDir = path.join(logsDir, "daily");
const weeklyDir = path.join(logsDir, "weekly");
const userDir = path.join(logsDir, "users");

for (const d of [logsDir, dailyDir, weeklyDir, userDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function weekStr(date) {
  const d = new Date(date);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Serialize writes per file path to prevent race conditions losing entries
const logWriteQueues = new Map();

function appendLog(filePath, entry) {
  const prev = logWriteQueues.get(filePath) || Promise.resolve();
  const next = prev.then(() => {
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      if (e.code !== "ENOENT") console.error("Log read error:", filePath, e.message);
    }
    existing.push(entry);
    const tmpFile = filePath + ".tmp." + process.pid;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(existing, null, 2));
      fs.renameSync(tmpFile, filePath);
    } catch (e) {
      console.error("Log write error:", filePath, e.message);
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }).catch((e) => console.error("Log queue error:", filePath, e.message));
  logWriteQueues.set(filePath, next);
}

function logConversation({ sessionId, user, userMessage, assistantMessage, toolsUsed, costUsd, durationMs }) {
  const now = new Date();
  const entry = {
    id: uuidv4(),
    sessionId,
    timestamp: now.toISOString(),
    user: user || config.business?.owner || "User",
    userMessage: userMessage || "",
    assistantMessage: (assistantMessage || "").slice(0, 500),
    toolsUsed: toolsUsed || [],
    costUsd: costUsd || 0,
    durationMs: durationMs || 0,
  };

  // Daily log
  const dailyFile = path.join(dailyDir, `${todayStr()}.json`);
  appendLog(dailyFile, entry);

  // Weekly log
  const weeklyFile = path.join(weeklyDir, `${weekStr(now)}.json`);
  appendLog(weeklyFile, entry);

  // User log
  const userName = (entry.user || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "-");
  const userFile = path.join(userDir, `${userName}.json`);
  appendLog(userFile, entry);

  return entry;
}

function readLogFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

// Sanitize path params to prevent directory traversal
function safeName(param) {
  return String(param || "").replace(/[^a-zA-Z0-9._-]/g, "");
}

// Escape HTML to prevent reflected XSS
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function listLogFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ============================================
// Rate limiting — per-IP, in-memory
// ============================================
const rateLimitBuckets = new Map(); // ip -> { count, resetAt }

function rateLimit(windowMs, maxHits) {
  return (req, res, next) => {
    // Local requests get a much higher limit
    if (isLocalRequest(req)) return next();

    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = rateLimitBuckets.get(ip);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(ip, bucket);
    }

    bucket.count++;
    if (bucket.count > maxHits) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    next();
  };
}

// Prune stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(ip);
  }
}, 300000);

const app = express();
const server = tlsCerts
  ? https.createServer({ cert: tlsCerts.cert, key: tlsCerts.key }, app)
  : http.createServer(app);
const useHttps = !!tlsCerts;
const wss = new WebSocket.Server({ server });

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

  // Allow the mobile auth endpoint itself
  if (req.path === "/mobile/auth") return next();

  // Allow manifest/sw/icons for PWA install
  if (req.path === "/manifest.json" || req.path === "/sw.js" || req.path.startsWith("/icon-")) return next();

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

  // No valid auth — block access
  res.status(401).json({ error: "Unauthorized. Scan the QR code from Delt to access." });
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

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

  // Check auth by looking for Claude config/credentials, not by making an API call
  if (installed) {
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      authed = fs.existsSync(claudeDir) && fs.readdirSync(claudeDir).length > 0;
    } catch {}
  }

  res.json({ installed, version, authed, https: useHttps });
});

// Serve config
app.get("/config", (req, res) => {
  res.json(config);
});

// Open terminal with install command (cross-platform)
app.post("/run-install", (req, res) => {
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
app.post("/run-auth", (req, res) => {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("osascript", ["-e", `tell application "Terminal" to do script "claude"`], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "cmd", "/k", "claude"], { detached: true, stdio: "ignore" }).unref();
    } else {
      const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
      let launched = false;
      for (const term of terminals) {
        try {
          if (term === "gnome-terminal") {
            spawn(term, ["--", "bash", "-c", "claude; read"], { detached: true, stdio: "ignore" }).unref();
          } else {
            spawn(term, ["-e", "bash -c 'claude; read'"], { detached: true, stdio: "ignore" }).unref();
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
app.post("/install-silent", (req, res) => {
  // Already installed — skip
  if (installState.status === "installed") {
    return res.json({ ok: true, status: "installed" });
  }
  // Already in progress — don't start a second one
  if (installState.status === "installing") {
    return res.json({ ok: true, status: "installing" });
  }

  // Detect platform
  const platform = process.platform; // "darwin", "linux", "win32"

  // Check for npm, then npx
  let npmCmd = null;
  try {
    execSync("npm --version 2>/dev/null", { timeout: 5000 });
    npmCmd = "npm";
  } catch {
    try {
      execSync("npx --version 2>/dev/null", { timeout: 5000 });
      npmCmd = "npx";
    } catch {
      return res.json({ ok: false, error: "node_required" });
    }
  }

  // Start the install
  installState = { status: "installing", error: null, progress: "" };

  const installCmd = npmCmd === "npx"
    ? "npx -y @anthropic-ai/claude-code"
    : "npm install -g @anthropic-ai/claude-code";

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
app.get("/install-status", (req, res) => {
  res.json({
    status: installState.status,
    error: installState.error,
    progress: installState.progress,
  });
});

// Confirm CLI install and return auth URL for user to complete OAuth
app.post("/auth-silent", (req, res) => {
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

// Onboarding — save user name + bot name, mark setup complete
app.post("/setup", (req, res) => {
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
    return entry;
  });
  res.json({ integrations: result });
});

// Auto-detect credentials from local CLI tools (gh, gcloud, etc.)
// Tries to grab an existing token so the user doesn't have to create one manually
app.post("/integrations/:id/auto-detect", async (req, res) => {
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
app.post("/integrations/:id/connect", (req, res) => {
  const { token, baseUrl, fields } = req.body;
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Integration not found" });

  if (integration.authType === "enable") {
    saveCredential(integration.id, { type: "enable" });
    res.json({ ok: true, connected: true });
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
    res.json({ ok: true, connected: true });
  } else if (integration.authType === "token" || integration.authType === "custom") {
    // Multi-field support: if tokenConfig has fields, expect fields object
    if (fields && typeof fields === "object") {
      saveCredential(integration.id, { ...fields, type: "token" });
    } else if (token) {
      saveCredential(integration.id, { token, baseUrl: baseUrl || "", type: "token" });
    } else {
      return res.status(400).json({ error: "Token required" });
    }
    res.json({ ok: true, connected: true });
  } else {
    res.status(400).json({ error: "Use OAuth flow for this integration" });
  }
});

// Disconnect an integration
app.post("/integrations/:id/disconnect", (req, res) => {
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

// Test an MCP server can spawn
app.post("/integrations/:id/test", rateLimit(60000, 5), async (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Not found" });

  const cred = getCredential(integration.id);
  if (!cred || !cred.enabled) return res.json({ ok: false, error: "Not connected" });

  // For OAuth integrations, try refreshing the token
  if (cred.type === "oauth2") {
    const token = await refreshOAuthToken(integration.id);
    return res.json({ ok: !!token, message: token ? "Token valid" : "Token refresh failed" });
  }

  // For MCP-based integrations, try spawning the server
  const [serverName, serverDef] = Object.entries(integration.mcpServers || {})[0] || [];
  if (!serverName) return res.json({ ok: false, error: "No MCP server defined" });

  const env = { ...process.env };
  for (const [envVar, credKey] of Object.entries(serverDef.envMapping || {})) {
    if (cred[credKey]) env[envVar] = cred[credKey];
  }

  try {
    const testProc = spawn(serverDef.command, serverDef.args || [], { env, timeout: 10000 });
    let stderr = "";

    testProc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Give it 3 seconds to see if it starts without crashing
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        testProc.kill("SIGTERM");
        resolve();
      }, 3000);

      testProc.on("close", (code) => {
        clearTimeout(timer);
        resolve();
      });
    });

    // If it ran for 3 seconds without dying, it's working
    if (testProc.killed || !testProc.exitCode) {
      res.json({ ok: true, server: serverName, status: "running" });
    } else {
      res.json({ ok: false, server: serverName, error: stderr.slice(0, 200) || `Exit code ${testProc.exitCode}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Get OAuth authorization URL
app.get("/integrations/:id/auth-url", rateLimit(60000, 5), (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration || integration.authType !== "oauth2") {
    return res.status(400).json({ error: "Not an OAuth integration" });
  }

  const state = uuidv4();
  pendingOAuthStates.set(state, { integrationId: integration.id, createdAt: Date.now() });

  // Clean old states (> 10 min)
  for (const [k, v] of pendingOAuthStates) {
    if (Date.now() - v.createdAt > 600000) pendingOAuthStates.delete(k);
  }

  const clientId = oauthClients[integration.id]?.clientId;
  if (!clientId) return res.status(500).json({ error: "OAuth not configured for this service. Contact your admin." });

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
        <p style="color:#666;">You can close this window.</p>
      </div>
      <script>
        if (window.opener) window.opener.postMessage({type:"oauth-complete",integrationId:${JSON.stringify(integration.id)}},window.location.origin);
        setTimeout(()=>window.close(),2000);
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
app.post("/mobile/start", rateLimit(60000, 3), async (req, res) => {
  try {
    const activeSessionId = req.body?.sessionId || null;
    const url = await startTunnel();
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
app.get("/mobile/status", (req, res) => {
  res.json({
    running: !!tunnelProcess,
    url: tunnelUrl || null,
    starting: tunnelStarting,
  });
});

// Stop tunnel
app.post("/mobile/stop", (req, res) => {
  stopTunnel();
  res.json({ ok: true, status: "stopped" });
});

// Mobile auth — validates one-time token, sets session cookie, redirects to /
app.get("/mobile/auth", rateLimit(60000, 10), (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send(mobileAuthPage("Missing token", false));
  }

  const result = validateMobileToken(token);
  if (result && result.valid) {
    const sessionValue = createMobileSession();
    res.cookie("delt-mobile-auth", sessionValue, {
      maxAge: MOBILE_SESSION_TTL,
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });
    // Redirect to app with session ID so phone auto-resumes computer's conversation
    const redirectUrl = result.sessionId ? `/?resumeSession=${result.sessionId}` : "/";
    return res.send(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:-apple-system,system-ui,sans-serif;background:#f7f7f8;}
      .box{text-align:center;}.icon{font-size:48px;margin-bottom:12px;}.title{font-size:20px;font-weight:600;margin-bottom:6px;}.sub{color:#888;font-size:14px;}</style>
      </head><body><div class="box"><div class="icon">&#10003;</div><div class="title">Connected to Delt</div><div class="sub">Opening...</div></div>
      <script>setTimeout(function(){window.location.href="${redirectUrl}";},800);</script></body></html>`);
  }

  return res.status(401).send(mobileAuthPage("Token expired or invalid. Get a new QR code from Delt.", false));
});

function mobileAuthPage(message, success) {
  const color = success ? "#10B981" : "#EF4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;}
.card{text-align:center;padding:40px;}.icon{font-size:48px;color:${color};margin-bottom:16px;}
h2{margin:0 0 8px;color:#18182B;font-size:20px;}p{color:#5C5C72;font-size:15px;}</style>
</head><body><div class="card"><div class="icon">${icon}</div><h2>${success ? "Connected!" : "Access Denied"}</h2><p>${message}</p></div></body></html>`;
}

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
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
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

  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
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
// Persistent Memory — all markdown, all local
// ============================================
const memoryDir = path.join(__dirname, "memory");
const memDailyDir = path.join(memoryDir, "daily");
const memSessionsDir = path.join(memoryDir, "sessions");

for (const d of [memoryDir, memDailyDir, memSessionsDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const userMemFile = path.join(memoryDir, "user.md");
const stateFile = path.join(memoryDir, "state.md");
const memMetaFile = path.join(memoryDir, "meta.json");

function safeRead(fp) {
  try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
}

function safeWrite(fp, content) {
  const tmp = fp + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.error("Write error:", fp, e.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readMemMeta() {
  try { return JSON.parse(fs.readFileSync(memMetaFile, "utf-8")); }
  catch { return { lastExtraction: null, exchangeCount: 0 }; }
}

function writeMemMeta(meta) {
  try { fs.writeFileSync(memMetaFile, JSON.stringify(meta, null, 2)); } catch {}
}

// --- Full session logs (not truncated) ---
function appendSessionLog(sid, role, text) {
  if (!sid || !text) return;
  const fp = path.join(memSessionsDir, `${sid}.md`);
  const ts = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const label = role === "user" ? "**You**" : "**Assistant**";
  const entry = `\n### ${label} — ${ts}\n${text}\n`;
  try { fs.appendFileSync(fp, entry); } catch {}
}

// --- Daily log ---
function appendDailyLog(userMsg, assistantMsg, tag) {
  const fp = path.join(memDailyDir, `${todayStr()}.md`);
  const ts = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const tagStr = tag && tag !== "chat" ? ` [${tag}]` : "";
  let entry = `\n---\n#### ${ts}${tagStr}\n`;
  if (userMsg) entry += `**You:** ${userMsg.slice(0, 500)}\n\n`;
  if (assistantMsg) entry += `**Assistant:** ${assistantMsg.slice(0, 800)}\n`;
  try { fs.appendFileSync(fp, entry); } catch {}
}

// --- State file — what's in progress ---
function updateState(userMsg, assistantMsg) {
  // Lightweight: just keep last 5 exchanges as "recent context"
  let state;
  try { state = JSON.parse(safeRead(stateFile) || "{}"); } catch { state = {}; }

  if (!state.recentExchanges) state.recentExchanges = [];
  state.recentExchanges.push({
    ts: new Date().toISOString(),
    user: (userMsg || "").slice(0, 400),
    assistant: (assistantMsg || "").slice(0, 600),
  });
  // Keep last 5
  if (state.recentExchanges.length > 5) {
    state.recentExchanges = state.recentExchanges.slice(-5);
  }
  state.lastActive = new Date().toISOString();
  safeWrite(stateFile, JSON.stringify(state, null, 2));
}

function getStateContext() {
  let state;
  try { state = JSON.parse(safeRead(stateFile) || "{}"); } catch { return ""; }
  if (!state.recentExchanges || !state.recentExchanges.length) return "";

  let ctx = "## Recent conversation (last session)\n";
  for (const ex of state.recentExchanges) {
    if (ex.user) ctx += `**You:** ${ex.user}\n`;
    if (ex.assistant) ctx += `**Assistant:** ${ex.assistant}\n\n`;
  }
  return ctx;
}

// --- Background memory extraction (debounced — 30s cooldown) ---
let memExtracting = false;
let memLastExtractedAt = 0;
const MEM_EXTRACT_COOLDOWN_MS = 30000;

function extractMemories(userMsg, assistantMsg) {
  if (memExtracting || (!userMsg && !assistantMsg)) return;

  const now = Date.now();
  const current = safeRead(userMemFile);
  const meta = readMemMeta();
  meta.exchangeCount = (meta.exchangeCount || 0) + 1;
  writeMemMeta(meta);

  // Cooldown: skip if extracted within last 30 seconds (unless first ever)
  if (current.length > 0 && (now - memLastExtractedAt) < MEM_EXTRACT_COOLDOWN_MS) return;

  memExtracting = true;
  memLastExtractedAt = now;

  const prompt = `You are a memory system. Update this user profile from the latest exchange.

CURRENT:
${current || "(empty — first session)"}

EXCHANGE:
User: ${(userMsg || "").slice(0, 1500)}
Assistant: ${(assistantMsg || "").slice(0, 1500)}

Rules: extract lasting facts (preferences, names, projects, decisions, style). One line per fact under ## headers. Replace stale facts. Skip code/temp details. Output ONLY the updated file:`;

  const proc = spawn("claude", ["-p", prompt, "--output-format", "text"], {
    cwd: os.homedir(), env: { ...process.env },
  });

  let output = "";
  proc.stdout.on("data", (c) => { output += c.toString(); });
  proc.on("close", () => {
    memExtracting = false;
    const t = output.trim();
    if (t.length > 10) {
      safeWrite(userMemFile, t);
      const m = readMemMeta();
      m.lastExtraction = new Date().toISOString();
      writeMemMeta(m);
    }
  });
  proc.on("error", () => { memExtracting = false; });
}

// --- Save everything after each exchange ---
// Accumulate exchanges for end-of-session memory extraction
let pendingMemoryExchanges = [];

function persistExchange(sid, userMsg, assistantMsg, tag) {
  appendSessionLog(sid, "user", userMsg);
  appendSessionLog(sid, "assistant", assistantMsg);
  appendDailyLog(userMsg, assistantMsg, tag);
  updateState(userMsg, assistantMsg);
  // Queue for batch extraction on session close instead of per-message
  if (userMsg || assistantMsg) {
    pendingMemoryExchanges.push({ user: userMsg, assistant: assistantMsg });
  }
}

// Called when a WebSocket disconnects — extract memories from the full session
function flushMemoryExtraction() {
  if (!pendingMemoryExchanges.length) return;
  // Combine all exchanges into one extraction call
  const combined = pendingMemoryExchanges
    .map((e) => `User: ${(e.user || "").slice(0, 500)}\nAssistant: ${(e.assistant || "").slice(0, 500)}`)
    .join("\n---\n");
  pendingMemoryExchanges = [];
  extractMemories(combined, "");
}

// --- Memory API ---
app.get("/memory", (req, res) => {
  res.json({
    user: safeRead(userMemFile),
    state: getStateContext(),
    daily: safeRead(path.join(memDailyDir, `${todayStr()}.md`)),
    meta: readMemMeta(),
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

// Generate integrations context for Claude
function buildIntegrationsContext() {
  const creds = loadCredentials();
  const connected = [];

  for (const integration of integrationsRegistry.integrations) {
    const cred = creds[integration.id];
    if (!cred || !cred.enabled) continue;
    connected.push(integration);
  }

  if (!connected.length) return "";

  const lines = connected.map((i) => {
    const tools = Object.keys(i.mcpServers || {}).map((s) => `mcp__${s}__*`).join(", ");
    return `- **${i.name}**: ${i.description}. Use MCP tools (${tools}).`;
  });

  // Local access context
  let localCtx = "";
  const localCred = creds["local-access"];
  if (localCred && localCred.enabled) {
    if (localCred.level === "full") {
      localCtx = "\n\n[LOCAL COMPUTER ACCESS: FULL — You have unrestricted filesystem access to this Mac via mcp__filesystem__* tools. You can read, write, search, and manage files anywhere in the user's home directory.]";
    } else if (localCred.level === "limited") {
      const dirs = (localCred.directories || []).join(", ");
      localCtx = `\n\n[LOCAL COMPUTER ACCESS: LIMITED — You have filesystem access ONLY to these directories: ${dirs}. Use mcp__filesystem__* tools. Before accessing any file, confirm the path is within an allowed directory. If the user asks you to access something outside these directories, tell them it's outside your permitted access and ask them to update their Local Computer settings.]`;
    }
  } else {
    localCtx = "\n\n[LOCAL COMPUTER ACCESS: NONE — You do NOT have filesystem access. Do not attempt to read, write, or search local files. If the user asks you to work with local files, tell them to enable Local Computer access in the Integrations panel.]";
  }

  return `[CONNECTED INTEGRATIONS — the user has linked these services. ALWAYS use the MCP tools listed below to interact with them. NEVER use local apps (Mail.app, Calendar.app, etc.), AppleScript, or osascript. NEVER try to open Terminal or shell commands to interact with these services. The MCP tools handle everything directly.

${lines.join("\n")}

When the user asks you to do something with a connected service (send email, check calendar, search files, etc.), use the corresponding mcp__* tools. If a tool call fails, tell the user — don't fall back to local apps.]${localCtx}

`;
}

function buildSystemPrefix() {
  const ctx = config.business?.context || "";
  const userMem = safeRead(userMemFile);
  const stateMem = getStateContext();
  const dailyMem = safeRead(path.join(memDailyDir, `${todayStr()}.md`));
  const integrationsCtx = buildIntegrationsContext();

  let prefix = "";
  if (ctx) prefix += `[CONTEXT: ${ctx}]\n\n`;

  if (integrationsCtx) prefix += integrationsCtx;

  if (userMem) {
    prefix += `[WHO THIS USER IS — persistent memory from all prior sessions]\n${userMem}\n[END USER MEMORY]\n\n`;
  }

  if (stateMem) {
    prefix += `[WHERE WE LEFT OFF — last few exchanges from the previous session]\n${stateMem}\n[END STATE]\n\n`;
  }

  if (dailyMem) {
    // Only inject last ~2000 chars of today's log to keep context manageable
    const tail = dailyMem.length > 2000 ? "...\n" + dailyMem.slice(-2000) : dailyMem;
    prefix += `[TODAY'S LOG — what's happened so far today]\n${tail}\n[END TODAY]\n\n`;
  }

  return prefix;
}

wss.on("connection", (ws) => {
  let sessionId = null;

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
      const fullMessage = isFirst
        ? buildSystemPrefix() + message
        : message;

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
            });
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

      const prefix = isFirst ? buildSystemPrefix() : "";
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
    flushMemoryExtraction();
  });
});

// ============================================
// Signup API — email + Google Sheets
// ============================================

// Serve demo.html at /demo
app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "demo.html"));
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
  fs.writeFileSync(signupsPath, JSON.stringify(signups, null, 2));
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

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  killAllChildren();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  killAllChildren();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

const PORT = process.env.PORT || 3939;

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
  if (useHttps) {
    console.log(`  HTTPS enabled (self-signed cert at ~/.delt/certs/)`);
  }
  console.log(`  Bound to localhost only — not accessible from other devices.\n`);
});
