/**
 * lib/crypto.js — Encryption, credential storage, and integration credential management.
 *
 * Uses AES-256-GCM with a random key stored in ~/.delt/encryption.key.
 * Supports migration from legacy deterministic keys.
 *
 * Call init({ integrationsRegistry, invalidateMcpCache, writeIntegrationsMd })
 * before using saveCredential / deleteCredential.
 */

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const keyFilePath = path.join(os.homedir(), ".delt", "encryption.key");
let credentialsPath = null;

// Simple synchronous write lock — prevents concurrent load→modify→save from clobbering
let _credLocked = false;
const _credQueue = [];

function withCredLock(fn) {
  if (_credLocked) {
    return new Promise((resolve) => _credQueue.push(() => resolve(fn())));
  }
  _credLocked = true;
  try {
    return fn();
  } finally {
    _credLocked = false;
    if (_credQueue.length) {
      const next = _credQueue.shift();
      _credLocked = true;
      Promise.resolve().then(() => {
        try { next(); } finally {
          _credLocked = false;
          if (_credQueue.length) {
            const n = _credQueue.shift();
            _credLocked = true;
            Promise.resolve().then(n);
          }
        }
      });
    }
  }
}

// Injected callbacks — set via init()
let _integrationsRegistry = { integrations: [] };
let _invalidateMcpCache = () => {};
let _writeIntegrationsMd = () => {};

function init(opts) {
  if (opts.credentialsPath) credentialsPath = opts.credentialsPath;
  if (opts.integrationsRegistry) _integrationsRegistry = opts.integrationsRegistry;
  if (opts.invalidateMcpCache) _invalidateMcpCache = opts.invalidateMcpCache;
  if (opts.writeIntegrationsMd) _writeIntegrationsMd = opts.writeIntegrationsMd;
}

function getEncryptionKey() {
  const keyDir = path.dirname(keyFilePath);
  if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });

  try {
    const buf = fs.readFileSync(keyFilePath);
    if (buf.length === 32) return buf;
  } catch {}

  // First run — generate and store a random 256-bit key
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
  } catch (err) {
    console.error("Failed to write encryption key (disk full?):", err.message);
    // Return the key in memory — it won't persist across restarts but won't crash
  }
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
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(encrypted), { mode: 0o600 });
    fs.renameSync(tmpFile, credentialsPath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpFile); } catch {}
    console.error("Failed to save credentials (disk full?):", err.message);
    throw new Error("Could not save credentials — check disk space");
  }
}

function getCredential(integrationId) {
  const creds = loadCredentials();
  return creds[integrationId] || null;
}

function saveCredential(integrationId, data) {
  withCredLock(() => {
    const creds = loadCredentials();
    creds[integrationId] = { ...data, enabled: true, updatedAt: new Date().toISOString() };
    saveCredentials(creds);
  });
  _invalidateMcpCache();
  _writeIntegrationsMd();
}

function deleteCredential(integrationId) {
  withCredLock(() => {
    const creds = loadCredentials();
    delete creds[integrationId];
    saveCredentials(creds);
  });
  _invalidateMcpCache();
  _writeIntegrationsMd();
}

module.exports = {
  init,
  getEncryptionKey,
  encryptData,
  decryptData,
  getLegacyEncryptionKey,
  decryptWithLegacyKey,
  loadCredentials,
  saveCredentials,
  getCredential,
  saveCredential,
  deleteCredential,
};
