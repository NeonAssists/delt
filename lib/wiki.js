/**
 * lib/wiki.js — LLM Wiki (Karpathy-style persistent knowledge base)
 *
 * Structured, searchable, page-based memory that survives across sessions.
 * Each page is a markdown file with frontmatter. The QMD (_index.json)
 * provides fast search without reading every page from disk.
 *
 * Categories: user, project, decision, preference, reference, fact
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Wiki root: ~/.delt/wiki/
const WIKI_DIR = path.join(os.homedir(), ".delt", "wiki");
const INDEX_FILE = path.join(WIKI_DIR, "_index.json");

// Category subdirs
const CATEGORIES = ["user", "project", "decision", "preference", "reference", "fact"];

// Max wiki context to inject per conversation (chars, ~4k tokens)
const MAX_CONTEXT_CHARS = 16000;

// --- Init ---

function initWiki() {
  if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR, { recursive: true });
  for (const cat of CATEGORIES) {
    const dir = path.join(WIKI_DIR, cat);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(INDEX_FILE)) {
    writeIndex({ version: 1, pages: [] });
  }
}

// --- QMD Index ---

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")); }
  catch { return { version: 1, pages: [] }; }
}

function writeIndex(index) {
  const tmp = INDEX_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, INDEX_FILE);
  } catch (e) {
    console.error("[Wiki] Index write error:", e.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// --- Page CRUD ---

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function createPage(category, title, content, tags = []) {
  if (!CATEGORIES.includes(category)) category = "fact";
  const slug = slugify(title);
  const id = `${category}/${slug}`;
  const filePath = path.join(WIKI_DIR, category, `${slug}.md`);

  // Don't overwrite — if exists, update instead
  if (fs.existsSync(filePath)) {
    return updatePage(id, content, tags, title);
  }

  const now = new Date().toISOString();
  // Escape for YAML: strip newlines (prevents frontmatter injection) and escape quotes/backslashes
  const yamlEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
  const frontmatter = [
    "---",
    `id: "${id}"`,
    `title: "${yamlEscape(title)}"`,
    `category: ${category}`,
    `tags: [${tags.map(t => `"${yamlEscape(t)}"`).join(", ")}]`,
    `created: ${now}`,
    `updated: ${now}`,
    "---",
  ].join("\n");

  const fullContent = frontmatter + "\n\n" + content.trim() + "\n";
  try { fs.writeFileSync(filePath, fullContent); } catch (e) {
    console.error("[Wiki] Page write error:", e.message);
    return null;
  }

  // Update QMD index
  const index = readIndex();
  index.pages.push({
    id,
    path: `${category}/${slug}.md`,
    title,
    category,
    tags,
    summary: content.trim().slice(0, 200),
    created: now,
    updated: now,
  });
  writeIndex(index);

  console.log(`[Wiki] Created: ${id}`);
  return id;
}

function updatePage(id, content, tags, title) {
  const filePath = path.join(WIKI_DIR, id + ".md");
  if (!fs.existsSync(filePath)) {
    // Page doesn't exist — create it
    const parts = id.split("/");
    const category = parts[0];
    const pageTitle = title || parts.slice(1).join("/").replace(/-/g, " ");
    return createPage(category, pageTitle, content, tags || []);
  }

  const now = new Date().toISOString();
  const existing = fs.readFileSync(filePath, "utf-8");

  // Parse existing frontmatter
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
  let fm = {};
  if (fmMatch) {
    // Simple YAML-ish parse
    for (const line of fmMatch[1].split("\n")) {
      const col = line.indexOf(":");
      if (col > 0) {
        const key = line.slice(0, col).trim();
        let val = line.slice(col + 1).trim();
        // Strip quotes
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        fm[key] = val;
      }
    }
  }

  const category = fm.category || id.split("/")[0];
  const pageTitle = title || fm.title || id;
  const pageTags = tags || (fm.tags ? fm.tags.replace(/[\[\]"]/g, "").split(",").map(t => t.trim()).filter(Boolean) : []);

  // Escape for YAML: strip newlines and escape quotes/backslashes
  const yamlEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
  const frontmatter = [
    "---",
    `id: "${id}"`,
    `title: "${yamlEscape(pageTitle)}"`,
    `category: ${category}`,
    `tags: [${pageTags.map(t => `"${yamlEscape(t)}"`).join(", ")}]`,
    `created: ${fm.created || now}`,
    `updated: ${now}`,
    "---",
  ].join("\n");

  const fullContent = frontmatter + "\n\n" + content.trim() + "\n";
  try { fs.writeFileSync(filePath, fullContent); } catch (e) {
    console.error("[Wiki] Page update error:", e.message);
    return null;
  }

  // Update QMD index
  const index = readIndex();
  const idx = index.pages.findIndex(p => p.id === id);
  const entry = {
    id,
    path: id + ".md",
    title: pageTitle,
    category,
    tags: pageTags,
    summary: content.trim().slice(0, 200),
    created: fm.created || now,
    updated: now,
  };
  if (idx >= 0) index.pages[idx] = entry;
  else index.pages.push(entry);
  writeIndex(index);

  console.log(`[Wiki] Updated: ${id}`);
  return id;
}

function deletePage(id) {
  const filePath = path.join(WIKI_DIR, id + ".md");
  try { fs.unlinkSync(filePath); } catch {}

  const index = readIndex();
  index.pages = index.pages.filter(p => p.id !== id);
  writeIndex(index);

  console.log(`[Wiki] Deleted: ${id}`);
}

function getPage(id) {
  const filePath = path.join(WIKI_DIR, id + ".md");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    // Strip frontmatter for content-only read
    const match = raw.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
    return match ? match[1].trim() : raw.trim();
  } catch { return null; }
}

function getPageWithMeta(id) {
  const index = readIndex();
  const meta = index.pages.find(p => p.id === id);
  const content = getPage(id);
  if (!meta && !content) return null;
  return { ...(meta || { id }), content };
}

// --- Search ---

function tokenize(text) {
  return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
}

function searchPages(query, opts = {}) {
  const { tags, category, limit = 10 } = opts;
  const index = readIndex();
  const queryTokens = tokenize(query);

  if (!queryTokens.length && !tags && !category) {
    // No query — return most recent pages
    return index.pages
      .sort((a, b) => new Date(b.updated) - new Date(a.updated))
      .slice(0, limit);
  }

  const scored = index.pages.map(page => {
    let score = 0;

    // Category filter (hard filter, not scoring)
    if (category && page.category !== category) return null;

    // Tag filter (hard filter)
    if (tags && tags.length) {
      const hasTag = tags.some(t => page.tags.includes(t));
      if (!hasTag) return null;
    }

    const titleTokens = tokenize(page.title);
    const summaryTokens = tokenize(page.summary);
    const tagTokens = (page.tags || []).map(t => t.toLowerCase());

    for (const qt of queryTokens) {
      // Title match: 3x weight
      if (titleTokens.some(t => t.includes(qt) || qt.includes(t))) score += 3;
      // Tag match: 2x weight
      if (tagTokens.some(t => t.includes(qt) || qt.includes(t))) score += 2;
      // Summary match: 1x weight
      if (summaryTokens.some(t => t.includes(qt) || qt.includes(t))) score += 1;
    }

    // Recency boost: pages updated in last 24h get +1, last 7d get +0.5
    const age = Date.now() - new Date(page.updated).getTime();
    if (age < 86400000) score += 1;
    else if (age < 7 * 86400000) score += 0.5;

    return score > 0 ? { ...page, score } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- Context Builder (main integration point) ---

function buildWikiContext(query, maxChars) {
  const max = maxChars || MAX_CONTEXT_CHARS;
  const results = searchPages(query, { limit: 8 });
  if (!results.length) return "";

  let ctx = "";
  let totalChars = 0;

  for (const page of results) {
    const content = getPage(page.id);
    if (!content) continue;
    const block = `### ${page.title} (${page.category})\n${content}\n\n`;
    if (totalChars + block.length > max) {
      // Try truncated version
      const remaining = max - totalChars - 100;
      if (remaining > 200) {
        ctx += `### ${page.title} (${page.category})\n${content.slice(0, remaining)}...\n\n`;
      }
      break;
    }
    ctx += block;
    totalChars += block.length;
  }

  return ctx;
}

// Always-load: pages that should be in every conversation regardless of query
function buildAlwaysContext() {
  const index = readIndex();
  // Always load user profile + active preferences
  const alwaysCategories = ["user", "preference"];
  const alwaysPages = index.pages.filter(p => alwaysCategories.includes(p.category));

  let ctx = "";
  let totalChars = 0;
  const alwaysMax = 6000; // Reserve ~1.5k tokens for always-on context

  for (const page of alwaysPages) {
    const content = getPage(page.id);
    if (!content) continue;
    const block = `### ${page.title}\n${content}\n\n`;
    if (totalChars + block.length > alwaysMax) break;
    ctx += block;
    totalChars += block.length;
  }

  return ctx;
}

// --- Wiki Extraction (replaces flat user.md extraction) ---

let wikiExtracting = false;
let wikiLastExtractedAt = 0;
const WIKI_EXTRACT_COOLDOWN_MS = 30000;

function extractToWiki(exchanges, config) {
  if (config?.memory?.autoExtract === false) return;
  if (wikiExtracting || !exchanges) return;

  const now = Date.now();
  if (wikiLastExtractedAt > 0 && (now - wikiLastExtractedAt) < WIKI_EXTRACT_COOLDOWN_MS) return;

  wikiExtracting = true;
  wikiLastExtractedAt = now;
  console.log("[Wiki] Extracting knowledge from session...");

  // Build existing wiki summary for the prompt
  const index = readIndex();
  const existingPages = index.pages.map(p => `- ${p.id}: ${p.title} [${p.tags.join(", ")}]`).join("\n") || "(empty wiki)";

  const prompt = `You are a wiki memory system for a personal AI assistant called Delt. Given conversation exchanges, extract lasting knowledge into wiki page operations.

EXISTING WIKI PAGES:
${existingPages}

CONVERSATION:
${(exchanges || "").slice(0, 6000)}

Output wiki operations in this EXACT format (one or more blocks). Output NOTHING else — no explanation, no markdown fences:

PAGE_CREATE: category/slug-name
TITLE: Page Title
TAGS: tag1, tag2
---
Page content here. One fact per line.
Multiple lines ok.
---

PAGE_UPDATE: existing/page-id
TAGS: tag1, tag2
---
Complete replacement content for this page.
---

RULES:
- Categories: user, project, decision, preference, reference, fact
- Only save LASTING facts: identity, preferences, projects, key decisions, references
- Skip: debugging steps, code snippets, temporary state, greetings
- Prefer PAGE_UPDATE for existing pages over creating duplicates
- Keep content concise — bullet points, one fact per line
- If nothing worth saving, output exactly: NO_EXTRACT`;

  const proc = spawn("claude", ["-p", prompt, "--output-format", "text"], {
    cwd: os.homedir(), env: { ...process.env },
  });

  let output = "";
  proc.stdout.on("data", (c) => { output += c.toString(); });
  proc.on("close", () => {
    wikiExtracting = false;
    const text = output.trim();
    if (!text || text === "NO_EXTRACT" || text.length < 10) return;

    // Parse operations
    const ops = parseWikiOps(text);
    let applied = 0;
    for (const op of ops) {
      try {
        if (op.type === "create") {
          createPage(op.category, op.title, op.content, op.tags);
          applied++;
        } else if (op.type === "update") {
          updatePage(op.id, op.content, op.tags);
          applied++;
        }
      } catch (e) {
        console.error("[Wiki] Op failed:", e.message);
      }
    }
    if (applied) console.log(`[Wiki] Applied ${applied} operations from extraction`);
  });
  proc.on("error", () => { wikiExtracting = false; });
}

function parseWikiOps(text) {
  const ops = [];
  // Split on PAGE_CREATE: or PAGE_UPDATE:
  const blocks = text.split(/(?=PAGE_CREATE:|PAGE_UPDATE:)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const createMatch = trimmed.match(/^PAGE_CREATE:\s*(.+)/);
    const updateMatch = trimmed.match(/^PAGE_UPDATE:\s*(.+)/);

    if (!createMatch && !updateMatch) continue;

    const isCreate = !!createMatch;
    const idOrPath = (createMatch || updateMatch)[1].trim();

    // Parse TITLE (only for create)
    const titleMatch = trimmed.match(/TITLE:\s*(.+)/);
    const title = titleMatch ? titleMatch[1].trim() : idOrPath.split("/").pop().replace(/-/g, " ");

    // Parse TAGS
    const tagsMatch = trimmed.match(/TAGS:\s*(.+)/);
    const tags = tagsMatch ? tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean) : [];

    // Parse content between --- markers
    const contentMatch = trimmed.match(/---\n([\s\S]*?)\n---/);
    const content = contentMatch ? contentMatch[1].trim() : "";

    if (!content) continue;

    if (isCreate) {
      const parts = idOrPath.split("/");
      const category = CATEGORIES.includes(parts[0]) ? parts[0] : "fact";
      ops.push({ type: "create", category, title, tags, content });
    } else {
      ops.push({ type: "update", id: idOrPath, tags: tags.length ? tags : undefined, content });
    }
  }

  return ops;
}

// --- Migration: import existing user.md into wiki ---

function migrateFromUserMd(userMdPath) {
  if (!userMdPath) return;
  try {
    const content = fs.readFileSync(userMdPath, "utf-8").trim();
    if (!content || content.length < 10) return;

    // Check if already migrated
    const index = readIndex();
    if (index.pages.some(p => p.id === "user/profile")) return;

    createPage("user", "Profile", content, ["identity", "preferences", "migrated"]);
    console.log("[Wiki] Migrated user.md → user/profile");
  } catch {}
}

// --- List all pages (for UI/API) ---

function listPages(category) {
  const index = readIndex();
  if (category) return index.pages.filter(p => p.category === category);
  return index.pages;
}

// --- Stats ---

function getStats() {
  const index = readIndex();
  const byCategory = {};
  for (const cat of CATEGORIES) byCategory[cat] = 0;
  for (const p of index.pages) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  return {
    totalPages: index.pages.length,
    byCategory,
    lastUpdated: index.pages.length
      ? index.pages.sort((a, b) => new Date(b.updated) - new Date(a.updated))[0].updated
      : null,
  };
}

module.exports = {
  WIKI_DIR,
  CATEGORIES,
  initWiki,
  readIndex,
  createPage,
  updatePage,
  deletePage,
  getPage,
  getPageWithMeta,
  searchPages,
  buildWikiContext,
  buildAlwaysContext,
  extractToWiki,
  migrateFromUserMd,
  listPages,
  getStats,
};
