/**
 * lib/tunnel.js — Cloudflare tunnel + mobile auth session management.
 *
 * Manages one-time tokens, mobile sessions, cookie parsing, and
 * the cloudflared quick-tunnel lifecycle.
 */

const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const os = require("os");

// ============================================
// Tunnel state
// ============================================
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStarting = false;

// One-time tokens for mobile auth: token -> { createdAt, consumed }
const mobileTokens = new Map();

// Authenticated mobile sessions: cookieValue -> { createdAt }
const mobileSessions = new Map();

const MOBILE_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes
const MOBILE_SESSION_TTL = 60 * 60 * 1000; // 1 hour

// Tunnel idle watchdog — auto-kill after 30min of no WS activity
const TUNNEL_IDLE_TIMEOUT = 30 * 60 * 1000;
let lastWsActivity = Date.now();
let tunnelWatchdog = null;

function touchTunnelActivity() {
  lastWsActivity = Date.now();
}

function startTunnelWatchdog() {
  if (tunnelWatchdog) return;
  tunnelWatchdog = setInterval(() => {
    if (tunnelProcess && Date.now() - lastWsActivity > TUNNEL_IDLE_TIMEOUT) {
      console.log("[Mobile] Tunnel idle for 30min — auto-stopping");
      stopTunnel();
    }
  }, 60000);
}

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

function startTunnel(port) {
  return new Promise((resolve, reject) => {
    if (tunnelProcess && tunnelUrl) {
      return resolve(tunnelUrl);
    }
    if (tunnelStarting) {
      return reject(new Error("Tunnel is already starting"));
    }

    tunnelStarting = true;
    let resolved = false;

    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
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
        lastWsActivity = Date.now();
        startTunnelWatchdog();
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
  if (tunnelWatchdog) { clearInterval(tunnelWatchdog); tunnelWatchdog = null; }
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

function getTunnelState() {
  return { tunnelProcess, tunnelUrl, tunnelStarting };
}

// Get local network IP for LAN-based phone handoff (no cloudflared needed)
function getLocalNetworkUrl(port) {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return null;
}

function mobileAuthPage(message, success) {
  const color = success ? "#10B981" : "#EF4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;}
.card{text-align:center;padding:40px;}.icon{font-size:48px;color:${color};margin-bottom:16px;}
h2{margin:0 0 8px;color:#18182B;font-size:20px;}p{color:#5C5C72;font-size:15px;}</style>
</head><body><div class="card"><div class="icon">${icon}</div><h2>${success ? "Connected!" : "Access Denied"}</h2><p>${message}</p></div></body></html>`;
}

module.exports = {
  generateMobileToken,
  validateMobileToken,
  createMobileSession,
  validateMobileSession,
  parseCookies,
  isLocalRequest,
  startTunnel,
  stopTunnel,
  cleanupTunnel,
  getTunnelState,
  getLocalNetworkUrl,
  touchTunnelActivity,
  mobileAuthPage,
  MOBILE_TOKEN_TTL,
  MOBILE_SESSION_TTL,
};
