/**
 * lib/logging.js — Conversation logging infrastructure.
 *
 * Daily, weekly, and per-user JSON logs with serialized writes
 * to prevent race conditions.
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// Directory setup — relative to project root (passed via init or computed)
let logsDir, dailyDir, weeklyDir, userDir;

function initDirs(baseDir) {
  logsDir = path.join(baseDir, "logs");
  dailyDir = path.join(logsDir, "daily");
  weeklyDir = path.join(logsDir, "weekly");
  userDir = path.join(logsDir, "users");

  for (const d of [logsDir, dailyDir, weeklyDir, userDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
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

function logConversation({ sessionId, user, userMessage, assistantMessage, toolsUsed, costUsd, durationMs }, config) {
  const now = new Date();
  const entry = {
    id: uuidv4(),
    sessionId,
    timestamp: now.toISOString(),
    user: user || (config && config.business?.owner) || "User",
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

function getDirs() {
  return { logsDir, dailyDir, weeklyDir, userDir };
}

module.exports = {
  initDirs,
  todayStr,
  weekStr,
  appendLog,
  logConversation,
  readLogFile,
  safeName,
  escapeHtml,
  listLogFiles,
  getDirs,
  logWriteQueues,
};
