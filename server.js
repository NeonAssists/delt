const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

// ============================================
// Stability helpers
// ============================================
const PROCESS_TIMEOUT_MS = 120000; // 2 min max per Claude request

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

// Encryption using machine-specific key
function getEncryptionKey() {
  const raw = `delt:${os.hostname()}:${os.userInfo().username}:${__dirname}`;
  return crypto.createHash("sha256").update(raw).digest();
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

function loadCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    return decryptData(raw);
  } catch {
    return {};
  }
}

function saveCredentials(creds) {
  const encrypted = encryptData(creds);
  const tmpFile = credentialsPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(encrypted));
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
}

function deleteCredential(integrationId) {
  const creds = loadCredentials();
  delete creds[integrationId];
  saveCredentials(creds);
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
        const val = cred[credKey];
        if (val) env[envVar] = val;
      }
      mcpServers[serverName] = {
        command: serverDef.command,
        args: serverDef.args || [],
        env,
      };
    }
  }

  return { mcpServers };
}

// Write MCP config to temp file and return the path
// Using a file avoids shell escaping issues with inline JSON
const mcpConfigDir = path.join(os.tmpdir(), "delt-mcp");
if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true });

function writeMcpConfigFile() {
  const mcpConfig = buildMcpConfig();
  const serverCount = Object.keys(mcpConfig.mcpServers).length;
  if (serverCount === 0) return null;

  const filePath = path.join(mcpConfigDir, `mcp-${process.pid}.json`);
  fs.writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2));
  return filePath;
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
  }

  return args;
}

// Pending OAuth states (CSRF protection)
const pendingOAuthStates = new Map();

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

function appendLog(filePath, entry) {
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Log read error:", filePath, e.message);
  }
  existing.push(entry);
  // Atomic write: temp file + rename to prevent corruption on concurrent writes
  const tmpFile = filePath + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(existing, null, 2));
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    console.error("Log write error:", filePath, e.message);
    try { fs.unlinkSync(tmpFile); } catch {}
  }
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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// File uploads
const uploadDir = path.join(os.tmpdir(), "delt-uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Health check — detect if claude CLI is installed and authed
const { execSync } = require("child_process");

app.get("/health", (req, res) => {
  let installed = false;
  let version = null;
  let authed = false;

  try {
    version = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim();
    installed = true;
  } catch {}

  // If installed, check if it can run (has auth)
  if (installed) {
    try {
      const out = execSync('claude -p "say ok" --output-format text 2>/dev/null', { timeout: 15000 }).toString().trim();
      authed = out.length > 0;
    } catch {}
  }

  res.json({ installed, version, authed });
});

// Serve config
app.get("/config", (req, res) => {
  res.json(config);
});

// Open Terminal.app with install command (macOS)
app.post("/run-install", (req, res) => {
  try {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "npm install -g @anthropic-ai/claude-code && echo '\\n\\nDone! Go back to your browser.' && read"`], { detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open Terminal.app with claude auth
app.post("/run-auth", (req, res) => {
  try {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "claude"`], { detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const result = integrationsRegistry.integrations.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    icon: i.icon,
    category: i.category,
    authType: i.authType,
    setupSteps: i.setupSteps || [],
    tokenConfig: i.tokenConfig || null,
    connected: !!(creds[i.id] && creds[i.id].enabled),
    connectedAt: creds[i.id]?.updatedAt || null,
  }));
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

// Connect an integration (token-based or enable)
app.post("/integrations/:id/connect", (req, res) => {
  const { token, baseUrl } = req.body;
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Integration not found" });

  if (integration.authType === "enable") {
    saveCredential(integration.id, { type: "enable" });
    res.json({ ok: true, connected: true });
  } else if (integration.authType === "token" || integration.authType === "custom") {
    if (!token) return res.status(400).json({ error: "Token required" });
    saveCredential(integration.id, { token, baseUrl: baseUrl || "", type: "token" });
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
app.post("/integrations/:id/test", async (req, res) => {
  const integration = integrationsRegistry.integrations.find((i) => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Not found" });

  const cred = getCredential(integration.id);
  if (!cred || !cred.enabled) return res.json({ ok: false, error: "Not connected" });

  // Try to spawn the first MCP server for this integration
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
app.get("/integrations/:id/auth-url", (req, res) => {
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
    redirect_uri: `http://localhost:${PORT}/oauth/callback`,
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
    return res.send(`<html><body><h2>Authorization failed</h2><p>${error}</p><script>window.close()</script></body></html>`);
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
        redirect_uri: `http://localhost:${PORT}/oauth/callback`,
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) {
      return res.send(`<html><body><h2>Token exchange failed</h2><p>${tokens.error_description || tokens.error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    }

    saveCredential(integration.id, {
      type: "oauth2",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scope: tokens.scope,
    });

    // Gmail: write credentials to ~/.gmail-mcp/ so MCP server can read them
    if (integration.id === "gmail") {
      try {
        const gmailDir = path.join(os.homedir(), ".gmail-mcp");
        if (!fs.existsSync(gmailDir)) fs.mkdirSync(gmailDir, { recursive: true });

        // OAuth client config (for token refresh)
        fs.writeFileSync(path.join(gmailDir, "gcp-oauth.keys.json"), JSON.stringify({
          web: {
            client_id: clientConfig.clientId,
            client_secret: clientConfig.clientSecret,
            auth_uri: "https://accounts.google.com/o/oauth2/auth",
            token_uri: "https://oauth2.googleapis.com/token",
            redirect_uris: [`http://localhost:${PORT}/oauth/callback`]
          }
        }));

        // User credentials
        fs.writeFileSync(path.join(gmailDir, "credentials.json"), JSON.stringify({
          type: "authorized_user",
          client_id: clientConfig.clientId,
          client_secret: clientConfig.clientSecret,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          token_type: tokens.token_type || "Bearer",
          expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000
        }));
      } catch (e) {
        console.error("Failed to write Gmail MCP credentials:", e.message);
      }
    }

    res.send(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;">
      <div style="text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">&#10003;</div>
        <h2 style="margin:0 0 8px;">Connected!</h2>
        <p style="color:#666;">You can close this window.</p>
      </div>
      <script>
        if (window.opener) window.opener.postMessage({type:"oauth-complete",integrationId:"${integration.id}"},"*");
        setTimeout(()=>window.close(),2000);
      </script>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<html><body><h2>Connection failed</h2><p>${err.message}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
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

// Test an integration connection
app.post("/integrations/:id/test", async (req, res) => {
  const cred = getCredential(req.params.id);
  if (!cred) return res.json({ ok: false, error: "Not connected" });

  // For OAuth, try refreshing token
  if (cred.type === "oauth2") {
    const token = await refreshOAuthToken(req.params.id);
    res.json({ ok: !!token, message: token ? "Token valid" : "Token refresh failed" });
  } else {
    res.json({ ok: true, message: "Credentials stored" });
  }
});

// File upload endpoint
const uploadedFileMap = new Map();

app.post("/upload", upload.array("files", 10), (req, res) => {
  const uploaded = (req.files || []).map((f) => {
    const id = path.basename(f.path);
    uploadedFileMap.set(id, f.path);
    setTimeout(() => { try { fs.unlinkSync(f.path); } catch {} uploadedFileMap.delete(id); }, 3600000);
    return { originalName: f.originalname, id, size: f.size };
  });
  res.json({ files: uploaded });
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

// --- Background memory extraction ---
let memExtracting = false;

function extractMemories(userMsg, assistantMsg) {
  if (memExtracting || (!userMsg && !assistantMsg)) return;

  const current = safeRead(userMemFile);
  const meta = readMemMeta();
  meta.exchangeCount = (meta.exchangeCount || 0) + 1;
  writeMemMeta(meta);

  // Extract every 3 exchanges or on first
  if (meta.exchangeCount % 3 !== 0 && current.length > 0) return;

  memExtracting = true;

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
function persistExchange(sid, userMsg, assistantMsg, tag) {
  appendSessionLog(sid, "user", userMsg);
  appendSessionLog(sid, "assistant", assistantMsg);
  appendDailyLog(userMsg, assistantMsg, tag);
  updateState(userMsg, assistantMsg);
  extractMemories(userMsg, assistantMsg);
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
  const content = safeRead(path.join(memSessionsDir, `${req.params.sid}.md`));
  res.json({ sessionId: req.params.sid, content });
});

// Active sessions
const sessions = new Map();

function buildSystemPrefix() {
  const ctx = config.business?.context || "";
  const userMem = safeRead(userMemFile);
  const stateMem = getStateContext();
  const dailyMem = safeRead(path.join(memDailyDir, `${todayStr()}.md`));

  let prefix = "";
  if (ctx) prefix += `[CONTEXT: ${ctx}]\n\n`;

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
      let buffer = "";

      safeSend(ws, { type: "thinking" });

      proc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            safeSend(ws, { type: "stream", data: obj });

            // Capture data for logging
            if (obj.type === "assistant" && obj.message?.content) {
              for (const b of obj.message.content) {
                if (b.type === "text") currentAssistantText += b.text;
                if (b.type === "tool_use") currentToolsUsed.push(b.name || "unknown");
              }
            }
            if (obj.type === "result" && obj.cost_usd) {
              currentCost = obj.cost_usd;
            }
          } catch {}
        }
      });

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.includes("Error") || text.includes("ENOENT")) {
          safeSend(ws, { type: "error", message: text.trim() });
        }
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim());
            safeSend(ws, { type: "stream", data: obj });
            if (obj.type === "result" && obj.cost_usd) currentCost = obj.cost_usd;
          } catch {}
        }

        // Auto-log this exchange
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
        } catch (logErr) {
          console.error("Log write failed:", logErr.message);
        }

        // Save to conversation history + persist all memory layers
        try {
          saveConversationMeta(sessionId, currentUserMessage, currentAssistantText);
        } catch (histErr) {
          console.error("History save failed:", histErr.message);
        }
        persistExchange(sessionId, currentUserMessage, currentAssistantText, "chat");

        safeSend(ws, { type: "done", code });
        currentProcess = null;
      });

      proc.on("error", (err) => {
        safeSend(ws, { type: "error", message: `Something went wrong: ${err.message}` });
        currentProcess = null;
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
      sessionId = msg.sessionId;
      messageCount = 1; // Not first message, so --resume will be used
      sessions.set(sessionId, { created: Date.now() });
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
      let btwBuffer = "";

      safeSend(ws, { type: "btw-thinking" });

      proc.stdout.on("data", (chunk) => {
        btwBuffer += chunk.toString();
        const lines = btwBuffer.split("\n");
        btwBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            safeSend(ws, { type: "btw-stream", data: obj });
            // Capture assistant text for history
            if (obj.type === "assistant" && obj.message?.content) {
              for (const b of obj.message.content) {
                if (b.type === "text") btwAssistantText += b.text;
              }
            }
          } catch {}
        }
      });

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.includes("Error") || text.includes("ENOENT")) {
          safeSend(ws, { type: "btw-error", message: text.trim() });
        }
      });

      proc.on("close", (code) => {
        if (btwBuffer.trim()) {
          try {
            const obj = JSON.parse(btwBuffer.trim());
            safeSend(ws, { type: "btw-stream", data: obj });
          } catch {}
        }
        // Save to history + persist all memory layers
        try {
          saveConversationMeta(btwSessionId, btwUserMessage, btwAssistantText, "multitask");
        } catch {}
        persistExchange(btwSessionId, btwUserMessage, btwAssistantText, "multitask");
        safeSend(ws, { type: "btw-done", code });
        btwProcess = null;
        // Process queued BTW messages
        if (btwQueue.length) {
          const next = btwQueue.shift();
          // Re-dispatch through the handler by simulating the message
          ws.emit("message", JSON.stringify(next));
        }
      });

      proc.on("error", (err) => {
        safeSend(ws, { type: "btw-error", message: `BTW error: ${err.message}` });
        btwProcess = null;
        if (btwQueue.length) {
          const next = btwQueue.shift();
          ws.emit("message", JSON.stringify(next));
        }
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
      let p2Buffer = "";

      safeSend(ws, { type: "pane2-session", sessionId: pane2SessionId });
      safeSend(ws, { type: "pane2-thinking" });

      proc.stdout.on("data", (chunk) => {
        p2Buffer += chunk.toString();
        const lines = p2Buffer.split("\n");
        p2Buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            safeSend(ws, { type: "pane2-stream", data: obj });
          } catch {}
        }
      });

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.includes("Error") || text.includes("ENOENT")) {
          safeSend(ws, { type: "pane2-error", message: text.trim() });
        }
      });

      proc.on("close", (code) => {
        if (p2Buffer.trim()) {
          try {
            const obj = JSON.parse(p2Buffer.trim());
            safeSend(ws, { type: "pane2-stream", data: obj });
          } catch {}
        }
        safeSend(ws, { type: "pane2-done", code });
        pane2Process = null;
      });

      proc.on("error", (err) => {
        safeSend(ws, { type: "pane2-error", message: err.message });
        pane2Process = null;
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
  });
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
  console.log(`\n  ${config.business?.name || "Delt"} is running!`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Bound to localhost only — not accessible from other devices.\n`);
});
