/**
 * lib/mcp.js — MCP (Model Context Protocol) config generation.
 *
 * Builds MCP server configs from enabled integrations, writes cached
 * config files, and generates Claude CLI args with MCP injection.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

// MCP config dir + cache
const mcpConfigDir = path.join(os.homedir(), ".delt", "mcp");
if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true, mode: 0o700 });

let _mcpConfigCache = null;
let _mcpConfigPath = null;

// Injected dependencies — set via init()
let _loadCredentials = () => ({});
let _integrationsRegistry = { integrations: [] };
let _oauthClients = {};

function init(opts) {
  if (opts.loadCredentials) _loadCredentials = opts.loadCredentials;
  if (opts.integrationsRegistry) _integrationsRegistry = opts.integrationsRegistry;
  if (opts.oauthClients) _oauthClients = opts.oauthClients;
}

function invalidateMcpCache() {
  _mcpConfigCache = null;
}

function buildMcpConfig() {
  const creds = _loadCredentials();
  const mcpServers = {};

  for (const integration of _integrationsRegistry.integrations) {
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
        const clientConfig = _oauthClients["google-workspace"];
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
function buildClaudeArgs(fullMessage, { isRemote = false } = {}) {
  const args = [
    "-p", fullMessage,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  // Remote sessions: block dangerous tools (shell, file writes)
  if (isRemote) {
    args.push("--disallowedTools", "Bash,Write,Edit,NotebookEdit");
  }

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

module.exports = {
  init,
  buildMcpConfig,
  writeMcpConfigFile,
  invalidateMcpCache,
  buildClaudeArgs,
};
