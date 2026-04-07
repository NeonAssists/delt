/**
 * lib/memory.js — Persistent memory system.
 *
 * User memory, state tracking, session logs, daily logs,
 * background memory extraction via Claude CLI.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Directories and paths
let memoryDir, memDailyDir, memSessionsDir;
let userMemFile, stateFile, memMetaFile;

// External dependency — todayStr() from logging
let _todayStr = () => new Date().toISOString().slice(0, 10);

function initDirs(baseDir, todayStrFn) {
  memoryDir = path.join(baseDir, "memory");
  memDailyDir = path.join(memoryDir, "daily");
  memSessionsDir = path.join(memoryDir, "sessions");

  for (const d of [memoryDir, memDailyDir, memSessionsDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  userMemFile = path.join(memoryDir, "user.md");
  stateFile = path.join(memoryDir, "state.md");
  memMetaFile = path.join(memoryDir, "meta.json");

  if (todayStrFn) _todayStr = todayStrFn;
}

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
  const fp = path.join(memDailyDir, `${_todayStr()}.md`);
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

function extractMemories(userMsg, assistantMsg, config) {
  // Off by default — set config.memory.autoExtract = true to enable background memory extraction
  // This spawns a Claude CLI call per session (~$0.01-0.05) to update user.md
  if (!config?.memory?.autoExtract) return;
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
function flushMemoryExtraction(config) {
  if (!pendingMemoryExchanges.length) return;
  // Combine all exchanges into one extraction call
  const combined = pendingMemoryExchanges
    .map((e) => `User: ${(e.user || "").slice(0, 500)}\nAssistant: ${(e.assistant || "").slice(0, 500)}`)
    .join("\n---\n");
  pendingMemoryExchanges = [];
  extractMemories(combined, "", config);
}

// Sanitize user-generated content before injecting into system prompt
// Prevents bracket-based prompt injection from memory/logs
function sanitizeForPrompt(text) {
  if (!text) return "";
  return text.replace(/\[/g, "(").replace(/\]/g, ")");
}

function buildSystemPrefix(config, buildIntegrationsContext) {
  const ctx = config.business?.context || "";
  const userMem = sanitizeForPrompt(safeRead(userMemFile));
  const stateMem = sanitizeForPrompt(getStateContext());
  const dailyMem = sanitizeForPrompt(safeRead(path.join(memDailyDir, `${_todayStr()}.md`)));
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
    const tail = dailyMem.length > 2000 ? "...\n" + dailyMem.slice(-2000) : dailyMem;
    prefix += `[TODAY'S LOG — what's happened so far today]\n${tail}\n[END TODAY]\n\n`;
  }

  return prefix;
}

function getPaths() {
  return { memoryDir, memDailyDir, memSessionsDir, userMemFile, stateFile, memMetaFile };
}

module.exports = {
  initDirs,
  safeRead,
  safeWrite,
  readMemMeta,
  writeMemMeta,
  appendSessionLog,
  appendDailyLog,
  updateState,
  getStateContext,
  extractMemories,
  persistExchange,
  flushMemoryExtraction,
  sanitizeForPrompt,
  buildSystemPrefix,
  getPaths,
};
