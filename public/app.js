/* ============================================
   Delt — Client
   Config-driven AI assistant UI
   ============================================ */

(() => {
  // --- Icon SVGs keyed by name ---
  const ICONS = {
    mail: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
    document: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>`,
    share: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`,
    chat: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    edit: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    lightbulb: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>`,
    search: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    dollar: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    chart: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    calendar: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  };

  // --- Session persistence ---
  const SESSION_KEY = "delt-session";

  function saveSession() {
    if (!sessionId) return;
    try {
      const data = {
        sessionId,
        messages: messagesEl ? messagesEl.innerHTML : "",
        welcomeHidden: welcome ? welcome.classList.contains("hidden") : false,
        ts: Date.now(),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch {}
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      // Skip if older than 7 days (was 24h — too aggressive for a persistent assistant)
      if (Date.now() - data.ts > 7 * 86400000) {
        localStorage.removeItem(SESSION_KEY);
        return false;
      }
      if (data.sessionId && data.messages) {
        sessionId = data.sessionId;
        messagesEl.innerHTML = typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(data.messages) : escapeHtml(data.messages);
        if (data.welcomeHidden && welcome) welcome.classList.add("hidden");
        // Re-attach copy buttons on restored code blocks
        messagesEl.querySelectorAll("pre").forEach((pre) => addCopyBtns(pre.closest(".message-content") || pre.parentElement));
        // Tell server to resume this session
        return true;
      }
    } catch {}
    return false;
  }

  // Auto-resume from server history if no local session saved
  async function autoResumeFromHistory() {
    try {
      const resp = await fetch("/history-latest");
      if (!resp.ok) return false;
      const { conversation } = await resp.json();
      if (!conversation || !conversation.messages?.length) return false;
      sessionId = conversation.sessionId;
      if (welcome) welcome.classList.add("hidden");
      // Render past messages — sanitize role to prevent DOM injection
      const validRoles = new Set(["user", "assistant"]);
      for (const msg of conversation.messages) {
        const role = validRoles.has(msg.role) ? msg.role : "assistant";
        const div = document.createElement("div");
        div.className = `message ${role}`;
        const content = document.createElement("div");
        content.className = "message-content";
        // Messages in history are truncated to 300 chars — show as-is, user can continue the thread
        content.innerHTML = typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(typeof marked !== "undefined" ? marked.parse(msg.text || "") : escapeHtml(msg.text || ""))
          : escapeHtml(msg.text || "");
        div.appendChild(content);
        messagesEl.appendChild(div);
      }
      messagesEl.querySelectorAll("pre").forEach((pre) => addCopyBtns(pre.closest(".message-content") || pre.parentElement));
      // Scroll to bottom so user sees latest, not top of old convo
      if (scrollAnchor) scrollAnchor.scrollIntoView({ behavior: "instant" });
      return true;
    } catch { return false; }
  }

  function clearSavedSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // --- State ---
  let ws = null;
  let connected = false;
  let busy = false;
  let sessionId = null;
  let currentAssistantEl = null;
  let lastTextContent = "";
  let attachedFiles = [];
  let config = null;
  let completedSteps = [];
  let activeStep = null;
  let recognition = null;
  let micListening = false;
  let previewOpen = false;
  let inspectorActive = false;
  let selectedElement = null;

  // --- DOM ---
  const messagesEl = document.getElementById("messages");
  const welcome = document.getElementById("welcome");
  const scrollAnchor = document.getElementById("scroll-anchor");
  const input = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const statusDot = document.getElementById("status-dot");
  const statusLabel = document.getElementById("status-label");
  const newChatBtn = document.getElementById("new-chat-btn");
  const dropOverlay = document.getElementById("drop-overlay");
  const attachedFilesEl = document.getElementById("attached-files");
  const fileInput = document.getElementById("file-input");
  const toolsGrid = document.getElementById("tools-grid");
  const welcomeGreeting = document.getElementById("welcome-greeting");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const logoMark = document.getElementById("logo-mark");
  const logoText = document.getElementById("logo-text");
  const integrationChipsEl = document.getElementById("integration-chips");

  // --- Preview DOM ---
  const previewPanel = document.getElementById("preview-panel");
  const previewBtn = document.getElementById("preview-btn");
  const previewIframe = document.getElementById("preview-iframe");
  const previewUrlInput = document.getElementById("preview-url-input");
  const previewGoBtn = document.getElementById("preview-go-btn");
  const previewInspectorBtn = document.getElementById("preview-inspector-btn");
  const previewReloadBtn = document.getElementById("preview-reload-btn");
  const previewCloseBtn = document.getElementById("preview-close-btn");
  const previewEmpty = document.getElementById("preview-empty");
  const previewError = document.getElementById("preview-error");
  const previewErrorText = document.getElementById("preview-error-text");
  const previewRetryBtn = document.getElementById("preview-retry-btn");
  const previewPopover = document.getElementById("preview-element-popover");
  const previewElementTag = document.getElementById("preview-element-tag");
  const previewElementText = document.getElementById("preview-element-text");
  const previewElementStyles = document.getElementById("preview-element-styles");
  const previewEditBtn = document.getElementById("preview-edit-btn");
  const previewPopoverDismiss = document.getElementById("preview-popover-dismiss");

  // --- Integration status chips (header bar) ---
  // Short names for chips to save space
  const CHIP_NAMES = {
    "google-workspace": "Google",
    "local-access": "Local",
    "apple": "Apple",
    "microsoft-365": "M365",
    "custom-api": "API",
  };

  async function refreshIntegrationChips() {
    if (!integrationChipsEl) return;
    try {
      const res = await fetch("/integrations");
      const data = await res.json();
      const connected = (data.integrations || []).filter(i => i.connected);
      if (!connected.length) {
        integrationChipsEl.innerHTML = "";
        return;
      }
      integrationChipsEl.innerHTML = connected.map(i => {
        const label = CHIP_NAMES[i.id] || i.name;
        return `<span class="integration-chip" title="${i.name}: Connected"><span class="chip-dot"></span>${label}</span>`;
      }).join("");
    } catch {}
  }

  // --- Load config ---
  async function loadConfig() {
    try {
      const res = await fetch("/config");
      config = await res.json();
      applyConfig();
    } catch (e) {
      console.warn("Config load failed, using defaults");
    }
  }

  function applyConfig() {
    if (!config) return;

    const biz = config.business || {};
    const theme = config.theme || {};

    // Branding
    if (biz.name) {
      document.title = biz.name;
      logoText.textContent = biz.name.toLowerCase();
      logoMark.textContent = biz.name.charAt(0).toUpperCase();
    }

    if (biz.greeting) welcomeGreeting.textContent = biz.greeting;
    if (biz.subtitle) welcomeSubtitle.textContent = biz.subtitle;

    // Theme
    if (theme.accent) {
      document.documentElement.style.setProperty("--accent", theme.accent);
    }
    if (theme.accentHover) {
      document.documentElement.style.setProperty("--accent-hover", theme.accentHover);
    }
    if (theme.accentSoft) {
      document.documentElement.style.setProperty("--accent-soft", theme.accentSoft);
    }

    // Tools
    renderTools(config.tools || []);
  }

  function renderTools(tools) {
    toolsGrid.innerHTML = tools
      .map(
        (t) => `
      <button class="tool-card" data-tool-id="${t.id}">
        <div class="tool-icon">${ICONS[t.icon] || ICONS.lightbulb}</div>
        <div class="tool-info">
          <span class="tool-name">${escapeHtml(t.name)}</span>
          <span class="tool-desc">${escapeHtml(t.desc)}</span>
        </div>
      </button>
    `
      )
      .join("");

    // Bind clicks
    toolsGrid.querySelectorAll(".tool-card").forEach((card) => {
      card.addEventListener("click", () => {
        const toolId = card.dataset.toolId;
        const tool = (config.tools || []).find((t) => t.id === toolId);
        if (tool) sendMessage(tool.prompt);
      });
    });

    // Add integration-aware quick suggestions
    addIntegrationSuggestions();
  }

  // Dynamic suggestions based on connected integrations
  const INTEGRATION_SUGGESTIONS = {
    "google-workspace": [
      { icon: "mail", name: "Check email", prompt: "Summarize my unread emails" },
      { icon: "calendar", name: "Today's schedule", prompt: "What's on my calendar today?" },
    ],
    "github": [
      { icon: "chart", name: "PR status", prompt: "Show my open pull requests" },
    ],
    "slack": [
      { icon: "chat", name: "Slack catch-up", prompt: "What's the latest in my Slack channels?" },
    ],
    "stripe": [
      { icon: "dollar", name: "Revenue check", prompt: "Show my recent Stripe payments" },
    ],
    "notion": [
      { icon: "document", name: "Search Notion", prompt: "Search my Notion workspace" },
    ],
    "todoist": [
      { icon: "edit", name: "My tasks", prompt: "Show my Todoist tasks for today" },
    ],
    "linear": [
      { icon: "chart", name: "My issues", prompt: "Show my assigned Linear issues" },
    ],
    "jira": [
      { icon: "chart", name: "Sprint status", prompt: "Show my Jira sprint tickets" },
    ],
  };

  async function addIntegrationSuggestions() {
    try {
      const res = await fetch("/integrations");
      const data = await res.json();
      const connected = (data.integrations || []).filter(i => i.connected);
      if (!connected.length) return;

      const suggestions = [];
      for (const int of connected) {
        const items = INTEGRATION_SUGGESTIONS[int.id];
        if (items) suggestions.push(...items);
      }
      if (!suggestions.length) return;

      // Build a "Your tools" row below the main tools grid
      const existingRow = document.getElementById("integration-suggestions");
      if (existingRow) existingRow.remove();

      const row = document.createElement("div");
      row.id = "integration-suggestions";
      row.className = "integration-suggestions";
      row.innerHTML = `
        <div class="int-suggestions-label">From your connected apps</div>
        <div class="int-suggestions-grid">
          ${suggestions.slice(0, 4).map(s => `
            <button class="int-suggestion-chip" data-prompt="${escapeHtml(s.prompt)}">
              <span class="int-suggestion-icon">${ICONS[s.icon] || ""}</span>
              ${escapeHtml(s.name)}
            </button>
          `).join("")}
        </div>
      `;

      // Insert after tools grid
      toolsGrid.parentElement.insertBefore(row, toolsGrid.nextSibling);

      // Bind clicks
      row.querySelectorAll(".int-suggestion-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          sendMessage(chip.dataset.prompt);
        });
      });
    } catch {}
  }

  // --- Markdown ---
  function initMarked() {
    if (typeof marked === "undefined") return;
    try {
      const renderer = new marked.Renderer();
      renderer.link = function(href, title, text) {
        // Handle marked v9+ object-style args
        if (typeof href === "object") {
          text = href.text; title = href.title; href = href.href;
        }
        const t = title ? ` title="${title}"` : "";
        return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
      };
      if (typeof marked.use === "function") {
        marked.use({ breaks: true, gfm: true, renderer });
      } else if (typeof marked.setOptions === "function") {
        marked.setOptions({ breaks: true, gfm: true, renderer });
      }
    } catch (e) {}
  }
  initMarked();

  // Safety net: any <a> in the app that points externally opens in new tab
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });

  // Save session on tab close / navigate away
  window.addEventListener("beforeunload", saveSession);

  // --- WebSocket ---
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 15000;

  function wsConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      connected = true;
      reconnectDelay = 1000;
      setStatus("connected", "Ready");

      // Auto-resume session from QR handoff
      const params = new URLSearchParams(window.location.search);
      const resumeId = params.get("resumeSession");
      // Clean auth tokens and session params from URL bar
      if (params.has("token") || params.has("resumeSession")) {
        window.history.replaceState({}, "", "/");
      }
      if (resumeId) {
        resumeConversation(resumeId);
      }
    };

    ws.onclose = () => {
      connected = false;
      setStatus("error", "Reconnecting...");
      setTimeout(wsConnect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    };

    ws.onerror = () => {
      connected = false;
      setStatus("error", "Connection error");
    };

    ws.onmessage = (e) => {
      try {
        handleServer(JSON.parse(e.data));
      } catch {}
    };
  }

  function setStatus(state, label) {
    statusDot.className = "status-dot-inner " + state;
    statusLabel.textContent = label;
  }

  // Contextual thinking labels — smarter than generic "Thinking..."
  function getThinkingLabel() {
    const lastUserMsg = messagesEl ? messagesEl.querySelector(".message.user:last-of-type .message-content") : null;
    const text = (lastUserMsg?.textContent || "").toLowerCase();
    if (/email|mail|inbox|send.*message/i.test(text)) return "Checking your email...";
    if (/calendar|schedule|meeting|appointment/i.test(text)) return "Looking at your calendar...";
    if (/slack|channel|dm/i.test(text)) return "Checking Slack...";
    if (/github|pr|pull request|issue|commit|repo/i.test(text)) return "Working with GitHub...";
    if (/stripe|payment|invoice|subscription|charge/i.test(text)) return "Checking Stripe...";
    if (/notion|page|database|wiki/i.test(text)) return "Working with Notion...";
    if (/figma|design|mockup|prototype/i.test(text)) return "Working with Figma...";
    if (/file|document|pdf|spreadsheet|csv/i.test(text)) return "Working with your files...";
    if (/search|find|look up|research/i.test(text)) return "Researching...";
    if (/write|draft|compose|create/i.test(text)) return "Drafting...";
    if (/summarize|summary|recap|tldr/i.test(text)) return "Summarizing...";
    if (/analyze|analysis|report|data/i.test(text)) return "Analyzing...";
    if (/fix|bug|error|broken|debug/i.test(text)) return "Investigating...";
    if (/plan|strategy|brainstorm|idea/i.test(text)) return "Thinking it through...";
    return "Thinking...";
  }

  function handleServer(msg) {
    // Route btw-* and pane2-* to their handlers
    if (msg.type && msg.type.startsWith("btw-")) {
      if (btwPane) btwPane.handleServer(msg);
      return;
    }
    if (msg.type && msg.type.startsWith("pane2-")) {
      if (pane2Pane) pane2Pane.handleServer(msg);
      return;
    }

    switch (msg.type) {
      case "session":
        sessionId = msg.sessionId;
        break;
      case "resumed":
        sessionId = msg.sessionId;
        setStatus("connected", "Resumed");
        break;
      case "thinking":
        showTyping();
        setStatus("busy", getThinkingLabel());
        break;
      case "stream":
        handleStream(msg.data);
        break;
      case "done":
        hideTyping();
        finishResponse();
        incrementBadge();
        break;
      case "stopped":
        hideTyping();
        setBusy(false);
        setStatus("connected", "Ready");
        break;
      case "cleared":
        clearChat();
        break;
      case "error":
        hideTyping();
        showError(msg.message);
        break;
      case "auth-expired":
        hideTyping();
        setBusy(false);
        showAuthExpired();
        break;
      case "sync-user":
        // Message sent from another device on this session
        addMessage("user", msg.message);
        break;
      case "action":
        // Server-triggered UI action (Claude decided to do something)
        executeAction(msg.action, msg.params);
        break;
      case "cron-result":
        showCronNotification(msg);
        break;
      case "preview-reload":
        if (previewOpen && previewIframe && !previewIframe.classList.contains("hidden")) {
          previewIframe.src = previewIframe.src; // reload
        }
        break;
    }
  }

  // --- Stream ---
  function handleStream(data) {
    if (!data || !data.type) return;

    if (data.type === "assistant") {
      hideTyping();
      setStatus("busy", "Responding...");
      const content = data.message?.content;
      if (!content || !Array.isArray(content)) return;

      if (!currentAssistantEl) {
        currentAssistantEl = addMessage("assistant", "");
      }

      let text = "";
      const tools = [];
      for (const b of content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") tools.push(b);
      }

      if (text && text !== lastTextContent) {
        lastTextContent = text;
        // Strip action markers so user doesn't see raw [DELT_DO:...] or [DELT_HTML]...[/DELT_HTML]
        const displayText = text
          .replace(/\s*\[DELT_DO:\{[^[\]]*\}\]\s*/g, " ")
          .replace(/\s*\[DELT_HTML\][\s\S]*?\[\/DELT_HTML\]\s*/g, " ")
          .trim();
        const el = currentAssistantEl.querySelector(".message-content");
        if (el && displayText) {
          el.innerHTML = renderMd(displayText);
          addCopyBtns(el);
        }
        scrollDown();
      }

      for (const t of tools) showActivity(t);
    }

    if (data.type === "result") {
      hideTyping();
      if (!currentAssistantEl && data.result) {
        currentAssistantEl = addMessage("assistant", "");
        const el = currentAssistantEl.querySelector(".message-content");
        if (el) {
          el.innerHTML = renderMd(data.result);
          addCopyBtns(el);
        }
      }
      if (data.cost_usd && currentAssistantEl) {
        const c = document.createElement("div");
        c.className = "cost-indicator";
        c.textContent = data.cost_usd < 0.01 ? "< $0.01" : `$${data.cost_usd.toFixed(2)}`;
        currentAssistantEl.after(c);
      }
      scrollDown();
    }
  }

  // --- Activity Checklist ---
  const seenTools = new Set();
  let checklistEl = null;

  function ensureChecklist() {
    if (checklistEl) return checklistEl;
    checklistEl = document.createElement("ul");
    checklistEl.className = "activity-checklist";
    if (currentAssistantEl) {
      const body = currentAssistantEl.querySelector(".message-body");
      const content = body.querySelector(".message-content");
      body.insertBefore(checklistEl, content);
    } else {
      messagesEl.appendChild(checklistEl);
    }
    return checklistEl;
  }

  function showActivity(tool) {
    if (seenTools.has(tool.id)) return;
    seenTools.add(tool.id);

    const d = descTool(tool);

    // Mark previous active step as done
    if (activeStep) {
      markStepDone(activeStep.el);
      completedSteps.push({ label: activeStep.label, detail: activeStep.detail, doneAt: Date.now() });
    }

    // Create new active step
    const list = ensureChecklist();
    const li = document.createElement("li");
    li.className = "activity-step";
    li.innerHTML = `
      <span class="step-check active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg></span>
      <span class="step-label active">${escapeHtml(d.label)}${d.detail ? ' — ' + escapeHtml(d.detail) : ''}</span>
    `;
    list.appendChild(li);

    activeStep = { el: li, label: d.label, detail: d.detail, startedAt: Date.now() };
    setStatus("busy", d.label);
    scrollDown();
  }

  function markStepDone(li) {
    if (!li) return;
    const check = li.querySelector(".step-check");
    const label = li.querySelector(".step-label");
    if (check) {
      check.className = "step-check done";
      check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    }
    if (label) label.className = "step-label done";
  }

  function finalizeChecklist() {
    if (activeStep) {
      markStepDone(activeStep.el);
      completedSteps.push({ label: activeStep.label, detail: activeStep.detail, doneAt: Date.now() });
      activeStep = null;
    }
    checklistEl = null;
    completedSteps = [];
  }

  // MCP tool → human-friendly descriptions
  const MCP_TOOL_LABELS = {
    gmail: "Checking your email", calendar: "Checking your calendar", sheets: "Working with your spreadsheet",
    drive: "Accessing your files", slack: "Checking Slack", discord: "Checking Discord",
    github: "Working with GitHub", linear: "Checking Linear", gitlab: "Working with GitLab",
    jira: "Checking Jira", vercel: "Checking Vercel", stripe: "Checking Stripe",
    shopify: "Working with Shopify", salesforce: "Checking Salesforce", hubspot: "Checking HubSpot",
    pipedrive: "Checking Pipedrive", notion: "Working with Notion", todoist: "Checking your tasks",
    asana: "Checking Asana", monday: "Checking Monday", airtable: "Working with Airtable",
    figma: "Working with Figma", dropbox: "Accessing Dropbox", s3: "Accessing cloud storage",
    resend: "Sending an email", postmark: "Sending an email", sendgrid: "Sending an email",
    mailgun: "Sending an email", twilio: "Sending a message", supabase: "Querying your database",
    openai: "Using AI tools", replicate: "Generating content", elevenlabs: "Generating audio",
  };
  function descMcpTool(name) {
    const parts = name.split("__");
    if (parts.length >= 2) {
      const server = parts[1].toLowerCase();
      for (const [key, label] of Object.entries(MCP_TOOL_LABELS)) {
        if (server.includes(key)) return { label, detail: parts[2] ? parts[2].replace(/_/g, " ") : "" };
      }
      return { label: "Using " + parts[1].replace(/-/g, " "), detail: parts[2] ? parts[2].replace(/_/g, " ") : "" };
    }
    return null;
  }
  function descTool(tool) {
    const n = tool.name || "";
    const inp = tool.input || {};
    if (n.startsWith("mcp__")) { const d = descMcpTool(n); if (d) return d; }
    if (n === "Read" || n.includes("Read"))
      return { label: "Reading a file", detail: shortPath(inp.file_path) };
    if (n === "Write" || n.includes("Write"))
      return { label: "Creating a file", detail: shortPath(inp.file_path) };
    if (n === "Edit")
      return { label: "Editing", detail: shortPath(inp.file_path) };
    if (n === "Bash")
      return { label: "Running a task", detail: (inp.description || inp.command || "").slice(0, 60) };
    if (n === "Glob" || n === "Grep" || n.includes("Search"))
      return { label: "Searching", detail: inp.pattern || inp.query || "" };
    if (n === "Agent")
      return { label: "Delegating to a specialist", detail: inp.description || "" };
    if (n === "WebSearch")
      return { label: "Searching the web", detail: inp.query || "" };
    if (n === "WebFetch")
      return { label: "Fetching a web page", detail: "" };
    return { label: "Working on it...", detail: n.replace(/([A-Z])/g, " $1").trim().toLowerCase() };
  }

  // (timer and response actions removed — keeping it clean)

  // --- Messages ---
  function addMessage(role, text, files) {
    welcome.classList.add("hidden");

    const el = document.createElement("div");
    el.className = `message ${role}`;

    const biz = config?.business || {};
    const sender = role === "user" ? "You" : (biz.name || "Assistant");
    const avatar = role === "user" ? "Y" : (biz.name || "A").charAt(0);

    let filesHtml = "";
    if (files && files.length) {
      filesHtml = `<div class="message-files">${files.map((f) =>
        `<span class="file-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>${escapeHtml(f.originalName)}</span>`
      ).join("")}</div>`;
    }

    el.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-body">
        <div class="message-sender">${sender}</div>
        ${filesHtml}
        <div class="message-content">${role === "user" ? escapeHtml(text) : renderMd(text)}</div>
      </div>
    `;

    if (role === "assistant") addCopyBtns(el.querySelector(".message-content"));
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function renderMd(text) {
    if (!text) return "";
    try {
      if (typeof marked !== "undefined") {
        const fn = marked.parse || marked;
        if (typeof fn === "function") {
          const raw = fn(text);
          if (typeof DOMPurify !== "undefined") return DOMPurify.sanitize(raw);
          return raw;
        }
      }
    } catch {}
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function addCopyBtns(el) {
    if (!el) return;
    el.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.onclick = () => {
        navigator.clipboard.writeText(pre.querySelector("code")?.textContent || pre.textContent);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      };
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }

  // --- Typing ---
  let typingEl = null;

  function showTyping() {
    if (typingEl) return;
    const biz = config?.business || {};
    const avatar = (biz.name || "A").charAt(0);
    typingEl = document.createElement("div");
    typingEl.className = "typing-indicator";
    typingEl.innerHTML = `
      <div class="message-avatar" style="background:var(--accent-soft);color:var(--accent);font-weight:700;">${avatar}</div>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    `;
    messagesEl.appendChild(typingEl);
    scrollDown();
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  // --- Error translation (technical → human) ---
  const ERROR_TRANSLATIONS = [
    { match: /EADDRINUSE|port.*in use/i, msg: "Delt is already running in another tab or window.", hint: "Close other tabs running Delt, or restart your computer.", icon: "refresh" },
    { match: /ECONNREFUSED|connection refused/i, msg: "Can't reach the AI service right now.", hint: "Check your internet connection and try again.", icon: "wifi" },
    { match: /ENOENT.*claude|claude.*not found|spawn.*ENOENT/i, msg: "Delt's AI engine isn't installed yet.", hint: "Click below to install it.", icon: "download", action: "install" },
    { match: /timeout|timed? ?out|ETIMEDOUT/i, msg: "That took too long — the AI didn't respond in time.", hint: "Try again with a simpler request, or wait a moment.", icon: "clock" },
    { match: /ENOMEM|out of memory|heap/i, msg: "Your computer is running low on memory.", hint: "Close some other apps and try again.", icon: "warning" },
    { match: /rate.?limit|429|too many requests/i, msg: "You've hit the usage limit for now.", hint: "Wait a few minutes, or upgrade your Claude plan.", icon: "pause" },
    { match: /network|fetch|ERR_NETWORK|ENETUNREACH/i, msg: "Lost connection to the internet.", hint: "Check your Wi-Fi or ethernet and try again.", icon: "wifi" },
    { match: /MCP.*fail|mcp.*error|server.*failed.*start/i, msg: "One of your connected tools had trouble starting.", hint: "Open Integrations to check which tool isn't working.", icon: "tool", action: "integrations" },
    { match: /permission|EACCES|EPERM/i, msg: "Delt doesn't have permission to access that.", hint: "Check your file permissions or integration settings.", icon: "lock" },
    { match: /JSON|parse|syntax/i, msg: "Got an unexpected response.", hint: "Try again. If this keeps happening, restart Delt.", icon: "warning" },
  ];
  const ERROR_ICONS = {
    refresh: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    wifi: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
    download: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>',
    tool: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  };
  function translateError(raw) {
    for (const rule of ERROR_TRANSLATIONS) { if (rule.match.test(raw)) return rule; }
    return { msg: "Something went wrong.", hint: "Try again — if it keeps happening, restart Delt.", icon: "error" };
  }
  function showError(text) {
    const t = translateError(text);
    const el = document.createElement("div");
    el.className = "error-banner";
    el.innerHTML = '<div class="error-icon">' + (ERROR_ICONS[t.icon] || ERROR_ICONS.error) + '</div>' +
      '<div class="error-body"><div class="error-msg">' + escapeHtml(t.msg) + '</div><div class="error-hint">' + escapeHtml(t.hint) + '</div></div>' +
      (t.action === "integrations" ? '<button class="error-action-btn" data-action="integrations">Open Integrations</button>' : '') +
      (t.action === "install" ? '<button class="error-action-btn" data-action="install">Install now</button>' : '') +
      '<button class="error-dismiss-btn" title="Dismiss">&times;</button>';
    const actionBtn = el.querySelector(".error-action-btn");
    if (actionBtn) actionBtn.addEventListener("click", () => { if (actionBtn.dataset.action === "integrations" && document.getElementById("integrations-btn")) document.getElementById("integrations-btn").click(); el.remove(); });
    el.querySelector(".error-dismiss-btn").addEventListener("click", () => el.remove());
    messagesEl.appendChild(el);
    scrollDown();
    setBusy(false);
  }

  function showAuthExpired() {
    const el = document.createElement("div");
    el.className = "error-banner auth-expired";
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;">
        <strong>Session expired</strong>
        <span>Your Claude authentication has expired. Sign in again to continue.</span>
        <button class="auth-reauth-btn" style="align-self:flex-start;padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">Sign in to Claude</button>
      </div>
    `;
    el.querySelector(".auth-reauth-btn").addEventListener("click", async () => {
      try {
        await fetch("/run-auth", { method: "POST" });
        el.querySelector("span").textContent = "Terminal opened — sign in there, then come back.";
        // Poll until auth is restored
        const poll = setInterval(async () => {
          try {
            const res = await fetch("/verify-auth", { method: "POST" });
            const data = await res.json();
            if (data.authed) {
              clearInterval(poll);
              el.remove();
              setStatus("connected", "Ready");
            }
          } catch {}
        }, 3000);
        // Stop polling after 2 minutes
        setTimeout(() => clearInterval(poll), 120000);
      } catch {}
    });
    messagesEl.appendChild(el);
    scrollDown();
    setStatus("error", "Auth expired");
  }

  // --- File upload ---
  async function uploadFiles(fileList) {
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    try {
      const res = await fetch("/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.files) {
        attachedFiles.push(...data.files);
        renderAttached();
      }
    } catch {
      showError("Upload failed. Try again.");
    }
  }

  function renderAttached() {
    if (!attachedFiles.length) {
      attachedFilesEl.classList.add("hidden");
      updateSendBtn();
      return;
    }
    attachedFilesEl.classList.remove("hidden");
    attachedFilesEl.innerHTML = attachedFiles
      .map((f, i) => `
        <div class="attached-file">
          <span class="attached-file-name">${escapeHtml(f.originalName)}</span>
          <button class="attached-file-remove" data-i="${i}">&times;</button>
        </div>`)
      .join("");

    attachedFilesEl.querySelectorAll(".attached-file-remove").forEach((btn) => {
      btn.onclick = () => {
        attachedFiles.splice(+btn.dataset.i, 1);
        renderAttached();
      };
    });
    updateSendBtn();
  }

  // Drag and drop
  let dragCount = 0;

  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++dragCount === 1) dropOverlay.classList.remove("hidden");
  });

  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--dragCount === 0) dropOverlay.classList.add("hidden");
  });

  document.addEventListener("dragover", (e) => e.preventDefault());

  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCount = 0;
    dropOverlay.classList.add("hidden");
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) {
      uploadFiles(fileInput.files);
      fileInput.value = "";
    }
  });

  // ============================================
  // Delt Action Engine
  // Claude is the brain. The UI is the body.
  // Claude emits [DELT_DO:{...}] → server detects → client executes.
  // Fast-path catches obvious commands client-side for zero latency.
  // ============================================

  // --- Action handlers (parameterized) ---
  const ACTION_HANDLERS = {
    "clear-chat": () => {
      clearChat();
      if (ws && connected) ws.send(JSON.stringify({ type: "new-chat" }));
    },
    "dark-mode": () => {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("delt-theme", "dark");
    },
    "light-mode": () => {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("delt-theme", "light");
    },
    "set-font-size": (params) => {
      const size = Math.max(12, Math.min(32, Number(params.size) || 15));
      document.documentElement.style.setProperty("--msg-font-size", size + "px");
      localStorage.setItem("delt-font-size", size);
    },
    "set-accent-color": (params) => {
      if (params.color && /^#[0-9a-f]{3,8}$/i.test(params.color)) {
        document.documentElement.style.setProperty("--accent", params.color);
        // Derive hover and soft variants
        document.documentElement.style.setProperty("--accent-hover", params.color + "dd");
        document.documentElement.style.setProperty("--accent-soft", params.color + "14");
        document.documentElement.style.setProperty("--accent-softer", params.color + "0a");
        localStorage.setItem("delt-accent", params.color);
      }
    },
    "set-bg-color": (params) => {
      if (params.color) {
        document.documentElement.style.setProperty("--bg-page", params.color);
        localStorage.setItem("delt-bg", params.color);
      }
    },
    "fullscreen": () => {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    },
    "exit-fullscreen": () => {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    },
    "scroll-top": () => { messagesEl.scrollTop = 0; },
    "scroll-bottom": () => { scrollDown(); },
    "stop": () => {
      if (busy && ws && connected) ws.send(JSON.stringify({ type: "stop" }));
    },
    "confetti": () => { spawnConfetti(); },
    "shake": () => {
      document.body.classList.add("delt-shake");
      setTimeout(() => document.body.classList.remove("delt-shake"), 600);
    },
    "notification": (params) => {
      showToast(params.text || "Hey!");
    },
    "show-html": (params) => {
      if (params.html) renderHtmlBlock(params.html);
    },
  };

  // --- Live Preview ---
  const PREVIEW_URL_KEY = "delt-preview-url";

  function togglePreview() {
    if (!previewPanel) return;
    previewOpen = !previewOpen;
    previewPanel.classList.toggle("hidden", !previewOpen);
    if (chatColumn) chatColumn.classList.toggle("preview-open", previewOpen);
    if (previewOpen) {
      const saved = localStorage.getItem(PREVIEW_URL_KEY);
      if (saved && previewUrlInput) previewUrlInput.value = saved;
      previewUrlInput?.focus();
    } else {
      setInspector(false);
      dismissPopover();
    }
  }

  function loadPreview(rawUrl) {
    if (!rawUrl || !previewIframe) return;
    rawUrl = rawUrl.trim();
    if (!rawUrl) return;

    localStorage.setItem(PREVIEW_URL_KEY, rawUrl);
    dismissPopover();

    // Determine mode: URL vs file path
    const isUrl = /^https?:\/\//i.test(rawUrl);
    const isPath = rawUrl.startsWith("/") || rawUrl.startsWith("~");

    let src;
    if (isUrl) {
      // Proxy mode — inject inspector
      src = "/preview-proxy?url=" + encodeURIComponent(rawUrl);
    } else if (isPath) {
      // File serve mode
      const dir = rawUrl.replace(/^~/, "");
      fetch("/preview-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl.startsWith("~") ? rawUrl : rawUrl }),
      }).catch(() => {});
      src = "/preview-serve/";
    } else {
      // Assume URL without protocol
      src = "/preview-proxy?url=" + encodeURIComponent("http://" + rawUrl);
    }

    previewIframe.classList.remove("hidden");
    if (previewEmpty) previewEmpty.style.display = "none";
    if (previewError) previewError.classList.add("hidden");
    previewIframe.src = src;

    previewIframe.onerror = () => showPreviewError("Failed to load preview");
  }

  function showPreviewError(msg) {
    if (previewError && previewErrorText) {
      previewErrorText.textContent = msg;
      previewError.classList.remove("hidden");
    }
    previewIframe?.classList.add("hidden");
  }

  function setInspector(active) {
    inspectorActive = active;
    if (previewInspectorBtn) previewInspectorBtn.classList.toggle("active", active);
    // Tell iframe to enable/disable inspector
    try {
      previewIframe?.contentWindow?.postMessage({ type: "delt-inspector-set", active }, "*");
    } catch {}
    if (!active) dismissPopover();
  }

  function dismissPopover() {
    if (previewPopover) previewPopover.classList.add("hidden");
    selectedElement = null;
  }

  function showElementPopover(el) {
    if (!previewPopover || !el) return;
    selectedElement = el;

    // Tag label
    let tagLabel = el.tag;
    if (el.id) tagLabel += "#" + el.id;
    if (el.classes && el.classes.length) tagLabel += "." + el.classes.slice(0, 2).join(".");
    if (previewElementTag) previewElementTag.textContent = tagLabel;

    // Text content
    if (previewElementText) {
      const txt = el.text || "";
      previewElementText.textContent = txt.length > 120 ? txt.slice(0, 120) + "..." : txt;
      previewElementText.style.display = txt ? "" : "none";
    }

    // Style chips
    if (previewElementStyles && el.styles) {
      const chips = [];
      if (el.styles.fontSize) chips.push("font: " + el.styles.fontSize);
      if (el.styles.color && el.styles.color !== "rgba(0, 0, 0, 0)") chips.push("color: " + el.styles.color);
      if (el.styles.background && el.styles.background !== "rgba(0, 0, 0, 0)") chips.push("bg: " + el.styles.background);
      if (el.styles.padding && el.styles.padding !== "0px") chips.push("pad: " + el.styles.padding);
      if (el.styles.borderRadius && el.styles.borderRadius !== "0px") chips.push("radius: " + el.styles.borderRadius);
      previewElementStyles.innerHTML = chips.map(c =>
        `<span class="preview-style-chip">${c}</span>`
      ).join("");
    }

    previewPopover.classList.remove("hidden");
  }

  function editSelectedElement() {
    if (!selectedElement) return;
    const el = selectedElement;
    let prompt = `Edit the \`${el.selector}\` element`;
    if (el.text) {
      const shortText = el.text.length > 60 ? el.text.slice(0, 60) + "..." : el.text;
      prompt += ` (currently says "${shortText}")`;
    }
    prompt += " \u2014 ";

    // Pre-fill the chat input
    if (input) {
      input.value = prompt;
      input.focus();
      // Place cursor at end
      input.setSelectionRange(prompt.length, prompt.length);
      // Trigger auto-resize
      input.dispatchEvent(new Event("input"));
    }
    dismissPopover();
  }

  // Listen for element selections from inspector inside iframe
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "delt-element-selected" && e.data.element) {
      showElementPopover(e.data.element);
    }
  });

  // Preview event listeners
  if (previewBtn) previewBtn.addEventListener("click", togglePreview);
  if (previewCloseBtn) previewCloseBtn.addEventListener("click", togglePreview);
  if (previewGoBtn) previewGoBtn.addEventListener("click", () => loadPreview(previewUrlInput?.value));
  if (previewUrlInput) previewUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPreview(previewUrlInput.value);
  });
  if (previewInspectorBtn) previewInspectorBtn.addEventListener("click", () => setInspector(!inspectorActive));
  if (previewReloadBtn) previewReloadBtn.addEventListener("click", () => {
    if (previewIframe && !previewIframe.classList.contains("hidden")) {
      previewIframe.src = previewIframe.src;
    }
  });
  if (previewEditBtn) previewEditBtn.addEventListener("click", editSelectedElement);
  if (previewPopoverDismiss) previewPopoverDismiss.addEventListener("click", dismissPopover);
  if (previewRetryBtn) previewRetryBtn.addEventListener("click", () => loadPreview(previewUrlInput?.value));

  function executeAction(actionId, params) {
    const handler = ACTION_HANDLERS[actionId];
    if (handler) {
      try { handler(params || {}); } catch (e) { console.warn("Action failed:", actionId, e); }
      return true;
    }
    return false;
  }

  // --- Fast-path: obvious commands, zero latency ---
  // Only for things so obvious you shouldn't wait 2 seconds for Claude.
  const FAST_ACTIONS = [
    { test: /^(clear|reset|wipe|erase)\b/i, action: "clear-chat" },
    { test: /^start\s*(over|fresh)/i, action: "clear-chat" },
    { test: /^(stop|cancel|nevermind|never\s*mind|shut\s*up)$/i, action: "stop" },
  ];

  function fastMatch(text) {
    const t = text.trim();
    for (const f of FAST_ACTIONS) {
      if (f.test.test(t)) return f.action;
    }
    return null;
  }

  // --- Confetti ---
  function spawnConfetti() {
    const colors = ["#3B82F6", "#00CEC9", "#FD79A8", "#FDCB6E", "#55EFC4", "#E17055", "#0984E3"];
    const container = document.createElement("div");
    container.className = "delt-confetti-container";
    document.body.appendChild(container);
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement("div");
      piece.className = "delt-confetti";
      piece.style.left = Math.random() * 100 + "%";
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = Math.random() * 0.5 + "s";
      piece.style.animationDuration = (1.5 + Math.random() * 1.5) + "s";
      container.appendChild(piece);
    }
    setTimeout(() => container.remove(), 3500);
  }

  // --- Toast notification ---
  function showToast(text) {
    const toast = document.createElement("div");
    toast.className = "delt-toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- HTML sandbox renderer ---
  function renderHtmlBlock(html) {
    if (!currentAssistantEl) currentAssistantEl = addMessage("assistant", "");
    const wrapper = document.createElement("div");
    wrapper.className = "delt-html-block";
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts allow-same-origin";
    iframe.srcdoc = html;
    iframe.style.width = "100%";
    iframe.style.border = "none";
    iframe.style.borderRadius = "12px";
    iframe.style.minHeight = "200px";
    iframe.style.background = "#fff";
    // Auto-resize iframe to fit content
    iframe.onload = () => {
      try {
        const h = iframe.contentDocument.documentElement.scrollHeight;
        iframe.style.height = Math.min(h + 20, 600) + "px";
      } catch {}
    };
    wrapper.appendChild(iframe);
    const body = currentAssistantEl.querySelector(".message-body");
    if (body) body.appendChild(wrapper);
    scrollDown();
  }

  // --- Restore persisted UI preferences ---
  function restoreUiPrefs() {
    const theme = localStorage.getItem("delt-theme");
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    const fontSize = localStorage.getItem("delt-font-size");
    if (fontSize) document.documentElement.style.setProperty("--msg-font-size", fontSize + "px");
    const accent = localStorage.getItem("delt-accent");
    if (accent) {
      document.documentElement.style.setProperty("--accent", accent);
      document.documentElement.style.setProperty("--accent-hover", accent + "dd");
      document.documentElement.style.setProperty("--accent-soft", accent + "14");
      document.documentElement.style.setProperty("--accent-softer", accent + "0a");
    }
    const bg = localStorage.getItem("delt-bg");
    if (bg) document.documentElement.style.setProperty("--bg-page", bg);
  }
  restoreUiPrefs();

  // --- Message Queue ---
  const messageQueue = [];

  // --- Chat ---
  function sendMessage(text) {
    text = text || input.value.trim();
    if ((!text && !attachedFiles.length) || !connected) return;

    // Fast-path: obvious commands execute instantly, no Claude round-trip
    const fastAction = fastMatch(text);
    if (fastAction) {
      addMessage("user", text);
      input.value = "";
      autoResize();
      executeAction(fastAction);
      return;
    }

    if (!text && attachedFiles.length) {
      text = "Take a look at what I uploaded and tell me what you see.";
    }

    // Stop mic if listening
    if (micListening && recognition) recognition.stop();

    const files = attachedFiles.length ? [...attachedFiles] : null;

    addMessage("user", text, files);
    input.value = "";
    autoResize();
    attachedFiles = [];
    renderAttached();

    if (busy) {
      // Queue it with a visible indicator
      const note = document.createElement("div");
      note.className = "queued-indicator";
      note.textContent = "Queued — will run next";
      messagesEl.appendChild(note);
      scrollDown();
      messageQueue.push({ text, files, noteEl: note });
      return;
    }

    dispatchMessage(text, files);
  }

  function dispatchMessage(text, files) {
    ws.send(JSON.stringify({
      type: "chat",
      message: text,
      filePaths: files || undefined,
    }));

    setBusy(true);
    currentAssistantEl = null;
    lastTextContent = "";
    seenTools.clear();
    checklistEl = null;
    completedSteps = [];
    activeStep = null;

    // Refresh sidebar immediately so new convo appears on send
    setTimeout(loadSidebarHistory, 300);
  }

  function processQueue() {
    if (!messageQueue.length) return;
    const next = messageQueue.shift();
    if (next.noteEl) next.noteEl.remove();
    dispatchMessage(next.text, next.files);
  }

  function finishResponse() {
    finalizeChecklist();
    currentAssistantEl = null;
    lastTextContent = "";
    setBusy(false);
    setStatus("connected", "Ready");
    saveSession();
    loadSidebarHistory();
    processQueue();
  }

  function clearChat() {
    messagesEl.innerHTML = "";
    welcome.classList.remove("hidden");
    sessionId = null;
    clearSavedSession();
    currentAssistantEl = null;
    lastTextContent = "";
    seenTools.clear();
    checklistEl = null;
    completedSteps = [];
    activeStep = null;
    attachedFiles = [];
    // Clear queued messages
    for (const q of messageQueue) { if (q.noteEl) q.noteEl.remove(); }
    messageQueue.length = 0;
    renderAttached();
    setBusy(false);
    setStatus("connected", "Ready");
  }

  // ============================================
  // Shared ChatPane factory — eliminates duplicated
  // chat logic between Pane 2 and BTW
  // ============================================
  function createChatPane(opts) {
    // opts:
    //   messagesEl    - container for messages
    //   inputEl       - textarea input
    //   sendBtnEl     - send button
    //   stopBtnEl     - stop button
    //   welcomeEl     - welcome/empty element (optional, hidden on first msg)
    //   scrollFn      - function to scroll down
    //   wsPrefix      - "pane2" or "btw"
    //   wsChatType    - ws type for sending chat, e.g. "pane2-chat" or "btw"
    //   wsStopType    - ws type for stop, e.g. "pane2-stop" or "btw-stop"
    //   addMsgFn      - function(role, text) to add a message, returns the element
    //   showTypingFn  - function() to show typing indicator (optional)
    //   hideTypingFn  - function() to hide typing indicator (optional)
    //   showActivityFn - function(tool) to show tool activity (optional)
    //   finalizeActivityFn - function() to finalize activities on done (optional)
    //   getContentEl  - function(msgEl) to get the content element from a msg el
    //   onDone        - callback on done (optional)
    //   onSend        - callback on send (optional)
    //   sessionIdKey  - if truthy, manages its own sessionId (string key for server msg)
    //   hasQueue      - whether to support message queue

    let paneBusy = false;
    let paneCurrentEl = null;
    let paneLastText = "";
    let paneSessionId = null;
    const paneQueue = [];

    const prefix = opts.wsPrefix; // e.g. "pane2" or "btw"

    function setPaneBusy(val) {
      paneBusy = val;
      if (opts.sendBtnEl) opts.sendBtnEl.classList.toggle("hidden", val);
      if (opts.stopBtnEl) opts.stopBtnEl.classList.toggle("hidden", !val);
      if (!val && opts.inputEl) opts.inputEl.focus();
    }

    function send(text) {
      text = text || (opts.inputEl ? opts.inputEl.value.trim() : "");
      if (!text || !connected) return;

      // Hide welcome/empty
      if (opts.welcomeEl) opts.welcomeEl.classList.add("hidden");

      opts.addMsgFn("user", text);
      if (opts.inputEl) { opts.inputEl.value = ""; opts.inputEl.style.height = "auto"; }
      if (opts.sendBtnEl) opts.sendBtnEl.disabled = true;

      if (paneBusy && opts.hasQueue) {
        const note = document.createElement("div");
        note.className = prefix === "btw" ? "btw-activity" : "queued-indicator";
        note.innerHTML = prefix === "btw"
          ? `<span class="btw-activity-dot active"></span><span class="btw-activity-label">Queued — will run next</span>`
          : "Queued — will run next";
        if (prefix !== "btw") note.textContent = "Queued — will run next";
        opts.messagesEl.appendChild(note);
        opts.scrollFn();
        paneQueue.push({ text, noteEl: note });
        return;
      }

      if (paneBusy) return; // no queue, just drop

      dispatch(text);
    }

    function dispatch(text) {
      const payload = { type: opts.wsChatType, message: text };
      if (paneSessionId) payload.sessionId = paneSessionId;
      ws.send(JSON.stringify(payload));
      setPaneBusy(true);
      paneCurrentEl = null;
      paneLastText = "";
      if (opts.finalizeActivityFn) opts.finalizeActivityFn(true); // reset state
      if (opts.onSend) opts.onSend();
      setTimeout(loadSidebarHistory, 300);
    }

    function processQueue() {
      if (!paneQueue.length) return;
      const next = paneQueue.shift();
      if (next.noteEl) next.noteEl.remove();
      dispatch(next.text);
    }

    function handleStream(data) {
      if (!data || !data.type) return;

      if (data.type === "assistant") {
        if (opts.hideTypingFn) opts.hideTypingFn();
        const content = data.message?.content;
        if (!content || !Array.isArray(content)) return;

        if (!paneCurrentEl) {
          paneCurrentEl = opts.addMsgFn("assistant", "");
        }

        let text = "";
        const tools = [];
        for (const b of content) {
          if (b.type === "text") text += b.text;
          else if (b.type === "tool_use") tools.push(b);
        }

        if (text && text !== paneLastText) {
          paneLastText = text;
          const el = opts.getContentEl(paneCurrentEl);
          if (el) {
            // For BTW, preserve activity elements appended to the body
            if (prefix === "btw") {
              const activities = el.querySelectorAll(".btw-activity");
              el.innerHTML = renderMd(text);
              activities.forEach((a) => el.appendChild(a));
            } else {
              el.innerHTML = renderMd(text);
            }
          }
          opts.scrollFn();
        }

        if (opts.showActivityFn) {
          for (const t of tools) opts.showActivityFn(t, paneCurrentEl);
        }
      }

      if (data.type === "result") {
        if (opts.hideTypingFn) opts.hideTypingFn();
        if (!paneCurrentEl && data.result) {
          paneCurrentEl = opts.addMsgFn("assistant", "");
          const el = opts.getContentEl(paneCurrentEl);
          if (el) el.innerHTML = renderMd(data.result);
        }
        opts.scrollFn();
      }
    }

    function handleServerMsg(msg) {
      switch (msg.type) {
        case prefix + "-session":
          paneSessionId = msg.sessionId;
          break;
        case prefix + "-thinking":
          if (opts.showTypingFn) opts.showTypingFn();
          break;
        case prefix + "-stream":
          handleStream(msg.data);
          break;
        case prefix + "-done":
          if (opts.hideTypingFn) opts.hideTypingFn();
          if (opts.finalizeActivityFn) opts.finalizeActivityFn();
          paneCurrentEl = null;
          paneLastText = "";
          setPaneBusy(false);
          if (opts.onDone) opts.onDone();
          loadSidebarHistory();
          if (opts.hasQueue) processQueue();
          break;
        case prefix + "-stopped":
          if (opts.hideTypingFn) opts.hideTypingFn();
          setPaneBusy(false);
          break;
        case prefix + "-error":
          if (opts.hideTypingFn) opts.hideTypingFn();
          if (msg.message) {
            const errEl = document.createElement("div");
            errEl.className = "error-banner";
            if (prefix === "btw") errEl.style.fontSize = "12px";
            errEl.textContent = msg.message;
            opts.messagesEl.appendChild(errEl);
            opts.scrollFn();
          }
          setPaneBusy(false);
          break;
        case prefix + "-cleared":
          opts.messagesEl.innerHTML = "";
          if (opts.welcomeEl) {
            opts.messagesEl.appendChild(opts.welcomeEl);
            opts.welcomeEl.style.display = "";
          }
          paneCurrentEl = null;
          paneLastText = "";
          setPaneBusy(false);
          break;
      }
    }

    function reset() {
      paneSessionId = null;
      paneBusy = false;
      paneCurrentEl = null;
      paneLastText = "";
      paneQueue.length = 0;
    }

    function stop() {
      if (ws && paneBusy) ws.send(JSON.stringify({ type: opts.wsStopType }));
    }

    function getSessionId() { return paneSessionId; }
    function isBusy() { return paneBusy; }

    return {
      send,
      handleServer: handleServerMsg,
      handleStream,
      reset,
      stop,
      getSessionId,
      isBusy,
      setPaneBusy,
    };
  }

  // --- Pane 2 (second chat session) ---
  const pane2 = document.getElementById("pane-2");
  const pane2Close = document.getElementById("pane-2-close");
  const pane2Messages = document.getElementById("pane-2-messages");
  const pane2Welcome = document.getElementById("pane-2-welcome");
  const pane2Input = document.getElementById("pane-2-input");
  const pane2Send = document.getElementById("pane-2-send");
  const pane2Stop = document.getElementById("pane-2-stop");
  const pane2ToolsGrid = document.getElementById("pane-2-tools-grid");
  const pane2ScrollAnchor = document.getElementById("pane-2-scroll-anchor");

  let pane2Open = false;

  function pane2ScrollDown() {
    requestAnimationFrame(() => {
      if (pane2ScrollAnchor) pane2ScrollAnchor.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }

  function pane2AddMsg(role, text) {
    if (pane2Welcome) pane2Welcome.classList.add("hidden");
    const biz = config?.business || {};
    const avatar = role === "user" ? "Y" : (biz.name || "A").charAt(0);
    const sender = role === "user" ? "You" : (biz.name || "Assistant");
    const el = document.createElement("div");
    el.className = `message ${role}`;
    if (role === "user") {
      el.innerHTML = `
        <div class="message-avatar" style="background:var(--accent);color:white;">${avatar}</div>
        <div class="message-body">
          <div class="message-sender">${sender}</div>
          <div class="message-content" style="background:var(--accent-soft);padding:12px 18px;border-radius:var(--r-lg) var(--r-lg) 4px var(--r-lg);display:inline-block;">${escapeHtml(text)}</div>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="message-avatar" style="background:var(--accent-soft);color:var(--accent);font-weight:700;">${avatar}</div>
        <div class="message-body">
          <div class="message-sender">${sender}</div>
          <div class="message-content"></div>
        </div>
      `;
    }
    pane2Messages.appendChild(el);
    pane2ScrollDown();
    return el;
  }

  const pane2Pane = createChatPane({
    messagesEl: pane2Messages,
    inputEl: pane2Input,
    sendBtnEl: pane2Send,
    stopBtnEl: pane2Stop,
    welcomeEl: pane2Welcome,
    scrollFn: pane2ScrollDown,
    wsPrefix: "pane2",
    wsChatType: "pane2-chat",
    wsStopType: "pane2-stop",
    addMsgFn: pane2AddMsg,
    getContentEl: (msgEl) => msgEl ? msgEl.querySelector(".message-content") : null,
    hasQueue: false,
    onDone: () => {
      if (pane2Input) pane2Input.focus();
    },
  });

  function openPane2() {
    if (pane2Open || !pane2) return;
    pane2Open = true;
    pane2.classList.remove("hidden");
    const p1Header = document.getElementById("pane-1-header");
    if (p1Header) p1Header.classList.remove("hidden");
    pane2Messages.innerHTML = "";
    pane2Welcome.classList.remove("hidden");
    pane2Pane.reset();
    // Tell server to kill any stale pane2 process and reset its state
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pane2-new" }));
    }
    // Render tools in pane 2
    if (config?.tools) {
      renderPane2Tools(config.tools);
    }
    // Update greeting
    const g = pane2.querySelector(".pane-2-greeting");
    const s = pane2.querySelector(".pane-2-subtitle");
    if (g && config?.business?.greeting) g.textContent = config.business.greeting;
    if (s) s.textContent = "What else do you need?";
    pane2Input.focus();
  }

  function closePane2() {
    if (!pane2) return;
    pane2Open = false;
    pane2.classList.add("hidden");
    const p1Header = document.getElementById("pane-1-header");
    if (p1Header) p1Header.classList.add("hidden");
    pane2Pane.reset();
    input.focus();
  }

  function renderPane2Tools(tools) {
    if (!pane2ToolsGrid) return;
    pane2ToolsGrid.innerHTML = tools.map((t) => `
      <button class="tool-card" data-tool-id="${t.id}">
        <div class="tool-icon">${ICONS[t.icon] || ICONS.lightbulb}</div>
        <div class="tool-info">
          <span class="tool-name">${escapeHtml(t.name)}</span>
          <span class="tool-desc">${escapeHtml(t.desc)}</span>
        </div>
      </button>
    `).join("");
    pane2ToolsGrid.querySelectorAll(".tool-card").forEach((card) => {
      card.addEventListener("click", () => {
        const tool = (config.tools || []).find((t) => t.id === card.dataset.toolId);
        if (tool) pane2Pane.send(tool.prompt);
      });
    });
  }

  if (pane2Close) pane2Close.addEventListener("click", closePane2);
  const pane1Close = document.getElementById("pane-1-close");
  if (pane1Close) pane1Close.addEventListener("click", closePane2);
  if (pane2Input) {
    pane2Input.addEventListener("input", () => {
      pane2Input.style.height = "auto";
      pane2Input.style.height = Math.min(pane2Input.scrollHeight, 160) + "px";
      pane2Send.disabled = !pane2Input.value.trim();
    });
    pane2Input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pane2Pane.send(); }
    });
  }
  if (pane2Send) pane2Send.addEventListener("click", () => pane2Pane.send());
  if (pane2Stop) pane2Stop.addEventListener("click", () => pane2Pane.stop());

  function setBusy(val) {
    busy = val;
    sendBtn.classList.toggle("hidden", val);
    stopBtn.classList.toggle("hidden", !val);
    if (!val) input.focus();
  }

  function updateSendBtn() {
    sendBtn.disabled = !input.value.trim() && !attachedFiles.length;
  }

  // --- Helpers ---
  function scrollDown() {
    requestAnimationFrame(() => {
      scrollAnchor.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function shortPath(p) {
    if (!p) return "";
    const parts = p.split("/");
    return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    updateSendBtn();
  }

  // --- Left Sidebar (History) ---
  const sidebar = document.getElementById('sidebar');
  const sidebarList = document.getElementById('sidebar-list');
  const sidebarNewChat = document.getElementById('sidebar-new-chat');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const appBody = document.querySelector('.app-body');

  function toggleSidebar() {
    if (!sidebar || !appBody) return;
    sidebar.classList.toggle('collapsed');
    appBody.classList.toggle('sidebar-hidden');
  }

  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);

  if (sidebarNewChat) {
    sidebarNewChat.addEventListener('click', () => {
      openPane2();
    });
  }

  async function loadSidebarHistory() {
    if (!sidebarList) return;
    try {
      const res = await fetch('/history');
      const data = await res.json();
      const convos = data.conversations || [];

      if (!convos.length) {
        sidebarList.innerHTML = '<div class="sidebar-empty">No conversations yet</div>';
        return;
      }

      sidebarList.innerHTML = convos.map((c) => {
        const time = formatRelativeTime(c.updatedAt);
        const isActive = c.sessionId === sessionId;
        const tagLabel = c.tag === "multitask" ? '<span class="sidebar-tag multitask">MT</span>' : '';
        return `
          <div class="sidebar-item${isActive ? ' active' : ''}" data-session="${c.sessionId}" data-tag="${c.tag || 'chat'}">
            <div class="sidebar-item-title">${tagLabel}${escapeHtml(c.title)}</div>
            <div class="sidebar-item-meta">
              <span>${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</span>
              <span>${time}</span>
            </div>
          </div>
        `;
      }).join('');

    } catch {}
  }

  // Delegated click handler for sidebar (set once, no listener leaks)
  if (sidebarList) {
    sidebarList.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (item && item.dataset.session) resumeConversation(item.dataset.session);
    });
  }

  async function resumeConversation(sid) {
    messagesEl.innerHTML = '';
    welcome.classList.add('hidden');
    currentAssistantEl = null;
    lastTextContent = '';
    seenTools.clear();
    checklistEl = null;
    completedSteps = [];
    activeStep = null;

    try {
      const res = await fetch(`/history/${sid}`);
      const convo = await res.json();
      if (convo.messages) {
        for (const msg of convo.messages) {
          addMessage(msg.role, msg.text);
        }
      }
    } catch {}

    sessionId = sid;
    if (ws) ws.send(JSON.stringify({ type: 'resume-session', sessionId: sid }));
    scrollDown();
    loadSidebarHistory();
    input.focus();
  }

  function formatRelativeTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(isoStr).toLocaleDateString();
  }

  // --- Events ---
  input.addEventListener("input", autoResize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener("click", () => sendMessage());
  stopBtn.addEventListener("click", () => {
    if (ws && busy) ws.send(JSON.stringify({ type: "stop" }));
  });
  newChatBtn.addEventListener("click", () => {
    openPane2();
  });

  // Logo click → fresh session + home
  const logoLink = document.getElementById("logo-link");
  if (logoLink) {
    logoLink.addEventListener("click", (e) => {
      e.preventDefault();
      closePane2();
      clearChat();
    });
  }

  // Activity summary removed — welcome screen no longer has those elements


  // ============================================
  // BTW — Side Panel (uses shared ChatPane)
  // ============================================
  const btwFab = document.getElementById("btw-fab");
  const btwPanel = document.getElementById("btw-panel");
  const btwCloseBtn = document.getElementById("btw-close");
  const btwMessagesEl = document.getElementById("btw-messages");
  const btwEmpty = document.getElementById("btw-empty");
  const btwInputEl = document.getElementById("btw-input");
  const btwSendBtn = document.getElementById("btw-send");
  const btwStopBtn = document.getElementById("btw-stop");

  let btwTypingEl = null;
  let btwActiveActivity = null;

  const chatColumn = document.querySelector(".chat-column");

  function openBtw() {
    btwPanel.classList.remove("hidden");
    btwFab.classList.add("panel-open");
    if (chatColumn) chatColumn.classList.add("multitask-open");
    btwInputEl.focus();
  }

  function closeBtw() {
    btwPanel.classList.add("hidden");
    btwFab.classList.remove("panel-open");
    if (chatColumn) chatColumn.classList.remove("multitask-open");
  }

  if (btwFab) btwFab.addEventListener("click", openBtw);
  if (btwCloseBtn) btwCloseBtn.addEventListener("click", closeBtw);

  function btwScrollDown() {
    requestAnimationFrame(() => {
      if (btwMessagesEl) btwMessagesEl.scrollTop = btwMessagesEl.scrollHeight;
    });
  }

  function btwAddMsg(role, text) {
    if (btwEmpty) btwEmpty.style.display = "none";
    const el = document.createElement("div");
    el.className = `btw-msg ${role}`;
    const sender = role === "user" ? "You" : "Multitask";
    el.innerHTML = `
      <div class="btw-msg-sender">${sender}</div>
      <div class="btw-msg-body">${role === "user" ? escapeHtml(text) : renderMd(text)}</div>
    `;
    btwMessagesEl.appendChild(el);
    btwScrollDown();
    return el;
  }

  function btwShowTyping() {
    if (btwTypingEl) return;
    btwTypingEl = document.createElement("div");
    btwTypingEl.className = "btw-typing";
    btwTypingEl.innerHTML = `<div class="btw-typing-dots"><span></span><span></span><span></span></div>`;
    btwMessagesEl.appendChild(btwTypingEl);
    btwScrollDown();
  }

  function btwHideTyping() {
    if (btwTypingEl) { btwTypingEl.remove(); btwTypingEl = null; }
  }

  // Shared seenTools set for BTW activity dedup — cleared on each new dispatch
  const btwSeenToolsSet = new Set();

  function btwShowActivity(tool, currentEl) {
    if (btwSeenToolsSet.has(tool.id)) return;
    btwSeenToolsSet.add(tool.id);
    const d = descTool(tool);
    if (btwActiveActivity) {
      const dot = btwActiveActivity.querySelector(".btw-activity-dot");
      if (dot) dot.className = "btw-activity-dot done";
    }
    const el = document.createElement("div");
    el.className = "btw-activity";
    el.innerHTML = `
      <span class="btw-activity-dot active"></span>
      <span class="btw-activity-label">${escapeHtml(d.label)}</span>
      ${d.detail ? `<span class="btw-activity-detail">${escapeHtml(d.detail)}</span>` : ""}
    `;
    if (currentEl) {
      currentEl.querySelector(".btw-msg-body").appendChild(el);
    } else {
      btwMessagesEl.appendChild(el);
    }
    btwActiveActivity = el;
    btwScrollDown();
  }

  function btwFinalizeActivities(resetOnly) {
    if (!resetOnly) {
      if (btwActiveActivity) {
        const dot = btwActiveActivity.querySelector(".btw-activity-dot");
        if (dot) dot.className = "btw-activity-dot done";
      }
    }
    btwActiveActivity = null;
  }

  function btwUpdateSend() {
    if (btwSendBtn) btwSendBtn.disabled = !btwInputEl.value.trim();
  }

  const btwPaneOpts = {
    messagesEl: btwMessagesEl,
    inputEl: btwInputEl,
    sendBtnEl: btwSendBtn,
    stopBtnEl: btwStopBtn,
    welcomeEl: btwEmpty,
    scrollFn: btwScrollDown,
    wsPrefix: "btw",
    wsChatType: "btw",
    wsStopType: "btw-stop",
    addMsgFn: btwAddMsg,
    showTypingFn: btwShowTyping,
    hideTypingFn: btwHideTyping,
    showActivityFn: btwShowActivity,
    finalizeActivityFn: btwFinalizeActivities,
    getContentEl: (msgEl) => msgEl ? msgEl.querySelector(".btw-msg-body") : null,
    hasQueue: true,
    onSend: () => { btwSeenToolsSet.clear(); },
  };

  const btwPane = createChatPane(btwPaneOpts);

  if (btwInputEl) {
    btwInputEl.addEventListener("input", () => {
      btwInputEl.style.height = "auto";
      btwInputEl.style.height = Math.min(btwInputEl.scrollHeight, 120) + "px";
      btwUpdateSend();
    });
    btwInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); btwPane.send(); }
    });
  }
  if (btwSendBtn) btwSendBtn.addEventListener("click", () => btwPane.send());
  if (btwStopBtn) btwStopBtn.addEventListener("click", () => btwPane.stop());

  // --- Crons Panel ---
  const cronsBtn = document.getElementById("crons-btn");
  const cronsPanel = document.getElementById("crons-panel");
  const cronsOverlay = document.getElementById("crons-overlay");
  const cronsClose = document.getElementById("crons-close");
  const cronsBody = document.getElementById("crons-body");
  let cronsOpen = false;
  let cronsData = [];

  function openCrons() {
    cronsOpen = true;
    cronsPanel.classList.remove("hidden");
    cronsOverlay.classList.remove("hidden");
    loadCronsPanel();
  }
  function closeCrons() {
    cronsOpen = false;
    cronsPanel.classList.add("hidden");
    cronsOverlay.classList.add("hidden");
  }
  if (cronsBtn) cronsBtn.addEventListener("click", openCrons);
  if (cronsClose) cronsClose.addEventListener("click", closeCrons);
  if (cronsOverlay) cronsOverlay.addEventListener("click", closeCrons);

  function formatSchedule(s) {
    if (!s) return "Unknown";
    if (s.type === "interval") return `Every ${s.minutes} min`;
    const h = String(s.hour || 0).padStart(2, "0");
    const m = String(s.minute || 0).padStart(2, "0");
    const label = s.type === "weekday" ? "Weekdays" : "Daily";
    return `${label} at ${h}:${m}`;
  }

  function timeAgo(ts) {
    if (!ts) return "Never";
    const diff = Date.now() - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function renderCronsPanel(crons, showForm) {
    let html = "";

    if (showForm) {
      html += `<div class="cron-create-form" id="cron-form">
        <p class="cron-form-title">New scheduled task</p>
        <div class="cron-form-field">
          <label>Name</label>
          <input type="text" id="cf-name" placeholder="Morning briefing" maxlength="80">
        </div>
        <div class="cron-form-field">
          <label>Prompt</label>
          <textarea id="cf-prompt" placeholder="Check my email and summarize what needs attention today"></textarea>
        </div>
        <div class="cron-form-field">
          <label>Schedule</label>
          <div class="cron-schedule-row">
            <select id="cf-type">
              <option value="interval">Every N minutes</option>
              <option value="daily">Daily at time</option>
              <option value="weekday">Weekdays at time</option>
            </select>
            <input type="number" id="cf-minutes" min="1" max="10080" value="30" placeholder="30">
            <input type="time" id="cf-time" value="09:00" style="display:none">
          </div>
        </div>
        <div class="cron-form-actions">
          <button class="cron-cancel-btn" id="cf-cancel">Cancel</button>
          <button class="cron-save-btn" id="cf-save">Save</button>
        </div>
      </div>`;
    } else {
      html += `<button class="cron-add-btn" id="cron-add-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New scheduled task
      </button>`;
    }

    if (!crons.length && !showForm) {
      html += `<div class="cron-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 12px;display:block;opacity:0.3"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        No scheduled tasks yet.<br>Create one to automate recurring prompts.
      </div>`;
    }

    for (const cron of crons) {
      html += `<div class="cron-item" data-id="${cron.id}">
        <div class="cron-item-header">
          <span class="cron-name">${escapeHtmlStr(cron.name)}</span>
          <button class="cron-run-btn" data-run="${cron.id}" title="Run now">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run
          </button>
          <label class="cron-toggle" title="${cron.enabled ? "Enabled" : "Disabled"}">
            <input type="checkbox" data-toggle="${cron.id}" ${cron.enabled ? "checked" : ""}>
            <span class="cron-toggle-slider"></span>
          </label>
          <button class="cron-delete-btn" data-delete="${cron.id}" title="Delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
        <div class="cron-meta">
          <span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${escapeHtmlStr(formatSchedule(cron.schedule))}
          </span>
          <span>Last: ${timeAgo(cron.lastRun)}</span>
        </div>
        <div class="cron-prompt-preview">${escapeHtmlStr(cron.prompt)}</div>
        <button class="cron-runs-toggle" data-runs="${cron.id}">View history</button>
        <div class="cron-runs-list hidden" id="runs-${cron.id}"></div>
      </div>`;
    }

    cronsBody.innerHTML = html;

    // Form interactions
    const cfType = document.getElementById("cf-type");
    const cfMinutes = document.getElementById("cf-minutes");
    const cfTime = document.getElementById("cf-time");
    if (cfType) {
      cfType.addEventListener("change", () => {
        const isInterval = cfType.value === "interval";
        cfMinutes.style.display = isInterval ? "" : "none";
        cfTime.style.display = isInterval ? "none" : "";
      });
    }
    const cfCancel = document.getElementById("cf-cancel");
    if (cfCancel) cfCancel.addEventListener("click", () => renderCronsPanel(cronsData, false));
    const cfSave = document.getElementById("cf-save");
    if (cfSave) cfSave.addEventListener("click", saveCron);
    const addBtn = document.getElementById("cron-add-btn");
    if (addBtn) addBtn.addEventListener("click", () => renderCronsPanel(cronsData, true));

    // Item interactions
    cronsBody.querySelectorAll("[data-toggle]").forEach(el => {
      el.addEventListener("change", async () => {
        await fetch(`/crons/${el.dataset.toggle}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: el.checked }),
        });
        const idx = cronsData.findIndex(c => c.id === el.dataset.toggle);
        if (idx >= 0) cronsData[idx].enabled = el.checked;
      });
    });

    cronsBody.querySelectorAll("[data-delete]").forEach(el => {
      el.addEventListener("click", async () => {
        if (!confirm("Delete this scheduled task?")) return;
        await fetch(`/crons/${el.dataset.delete}`, { method: "DELETE" });
        cronsData = cronsData.filter(c => c.id !== el.dataset.delete);
        renderCronsPanel(cronsData, false);
      });
    });

    cronsBody.querySelectorAll("[data-run]").forEach(el => {
      el.addEventListener("click", async () => {
        el.innerHTML = "Running\u2026";
        el.disabled = true;
        await fetch(`/crons/${el.dataset.run}/run`, { method: "POST" });
        setTimeout(() => {
          el.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run`;
          el.disabled = false;
        }, 1500);
      });
    });

    cronsBody.querySelectorAll("[data-runs]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.runs;
        const runsEl = document.getElementById(`runs-${id}`);
        if (!runsEl.classList.contains("hidden")) {
          runsEl.classList.add("hidden");
          btn.textContent = "View history";
          return;
        }
        btn.textContent = "Loading\u2026";
        const res = await fetch(`/crons/${id}/runs`);
        const runs = await res.json();
        if (!runs.length) {
          runsEl.innerHTML = `<div style="font-size:12px;color:var(--text-faint);padding:4px 0">No runs yet</div>`;
        } else {
          runsEl.innerHTML = runs.map(r => `
            <div class="cron-run-entry">
              <div class="cron-run-time">${new Date(r.timestamp).toLocaleString()} \u2014 ${(r.duration/1000).toFixed(1)}s</div>
              ${r.error ? `<div class="cron-run-error">${escapeHtmlStr(r.error)}</div>` : `<div class="cron-run-output">${escapeHtmlStr(r.output || "(no output)")}</div>`}
            </div>`).join("");
        }
        runsEl.classList.remove("hidden");
        btn.textContent = "Hide history";
      });
    });
  }

  async function loadCronsPanel() {
    cronsBody.innerHTML = `<div class="integrations-loading">Loading...</div>`;
    try {
      const res = await fetch("/crons");
      cronsData = await res.json();
      renderCronsPanel(cronsData, false);
    } catch {
      cronsBody.innerHTML = `<div class="integrations-loading">Failed to load</div>`;
    }
  }

  async function saveCron() {
    const name = document.getElementById("cf-name")?.value.trim();
    const prompt = document.getElementById("cf-prompt")?.value.trim();
    const type = document.getElementById("cf-type")?.value;
    const minutes = parseInt(document.getElementById("cf-minutes")?.value || "30", 10);
    const time = document.getElementById("cf-time")?.value || "09:00";
    if (!name || !prompt) { alert("Name and prompt are required"); return; }

    let schedule;
    if (type === "interval") {
      schedule = { type: "interval", minutes: Math.max(1, minutes) };
    } else {
      const [hour, minute] = time.split(":").map(Number);
      schedule = { type, hour, minute };
    }

    const res = await fetch("/crons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt, schedule }),
    });
    const cron = await res.json();
    cronsData.unshift(cron);
    renderCronsPanel(cronsData, false);
  }

  function showCronNotification(msg) {
    const el = document.createElement("div");
    el.className = "cron-notification";
    el.innerHTML = `<div class="cron-notification-title">\u23F0 ${escapeHtmlStr(msg.cronName || "Cron")}</div>
      <div class="cron-notification-body">${msg.error ? "Error: " + escapeHtmlStr(msg.error) : escapeHtmlStr(msg.output || "Done")}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
    if (cronsOpen) loadCronsPanel();
  }

  function escapeHtmlStr(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // --- Integrations Panel ---
  const integrationsBtn = document.getElementById("integrations-btn");
  const integrationsPanel = document.getElementById("integrations-panel");
  const integrationsOverlay = document.getElementById("integrations-overlay");
  const integrationsClose = document.getElementById("integrations-close");
  const integrationsBody = document.getElementById("integrations-body");

  // Category metadata for the Command Center
  const CATEGORY_META = {
    system:        { label: "System",        color: "#64748B", icon: "computer" },
    productivity:  { label: "Productivity",  color: "#3B82F6", icon: "layers" },
    communication: { label: "Communication", color: "#0EA5E9", icon: "message" },
    development:   { label: "Development",   color: "#10B981", icon: "code" },
    commerce:      { label: "Commerce",      color: "#F59E0B", icon: "cart" },
    finance:       { label: "Finance",       color: "#8B5CF6", icon: "dollar" },
    crm:           { label: "CRM",           color: "#EC4899", icon: "users" },
    design:        { label: "Design",        color: "#F43F5E", icon: "palette" },
    storage:       { label: "Storage",       color: "#0891B2", icon: "folder" },
    support:       { label: "Support",       color: "#14B8A6", icon: "headset" },
  };

  const INTEGRATION_ICONS = {
    google: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`,
    github: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#181717"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.8.2 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.2.9 2.4v3.5c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>`,
    slack: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M5.04 15.16a2.53 2.53 0 0 1-2.52 2.53A2.53 2.53 0 0 1 0 15.16a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.32A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.32z" fill="#E01E5A"/><path d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31z" fill="#36C5F0"/><path d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31z" fill="#2EB67D"/><path d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52h-6.31z" fill="#ECB22E"/></svg>`,
    notion: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4.5 3.5l10.3-.7c.3 0 .4 0 .5.1l2.6 1.8c.2.1.3.2.3.4v13.1c0 .4-.2.7-.6.7l-12.5.7c-.4 0-.5 0-.7-.3l-2.2-2.8c-.2-.3-.3-.5-.3-.8V4.3c0-.4.2-.7.6-.8z" fill="white" stroke="#000" stroke-width="1"/><path d="M14.5 6.5V18c0 .3-.1.4-.4.4l-7.1.4c-.3 0-.4-.1-.4-.4V7.1c0-.2.1-.4.4-.4l7.1-.4c.3 0 .4.1.4.2z" fill="none" stroke="#000" stroke-width=".7"/><line x1="9" y1="9.5" x2="12.5" y2="9.5" stroke="#000" stroke-width=".8"/><line x1="9" y1="11.5" x2="12.5" y2="11.5" stroke="#000" stroke-width=".8"/><line x1="9" y1="13.5" x2="11" y2="13.5" stroke="#000" stroke-width=".8"/></svg>`,
    linear: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M2.77 17.72a11.94 11.94 0 0 1-.72-2.26L11.52 24c.8-.14 1.56-.38 2.27-.72L2.77 17.72zm-1.5-4.5a12.08 12.08 0 0 1 .27-2.72L13.46 22.41c.93-.38 1.8-.88 2.59-1.48L1.78 8.66A12.04 12.04 0 0 0 .58 11.5l8.35 11.94a11.93 11.93 0 0 1-2.38-.44L1.27 13.22zm2.02-6.2L19 22.73a12.05 12.05 0 0 0 2.1-2.1L5.38 4.92A12.02 12.02 0 0 0 3.3 7.02zm4.1-3.58l15.17 11.55c.15-.63.26-1.28.32-1.94L9.35 1.98a12 12 0 0 0-1.96.46zM12 0C9.97 0 8.07.52 6.4 1.42L22.58 17.6A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z" fill="#5E6AD2"/></svg>`,
    stripe: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#635BFF"><path d="M13.48 8.82c0-.7.58-1 1.53-1a10 10 0 0 1 4.42 1.14V5.19a11.82 11.82 0 0 0-4.42-.82c-3.63 0-6.04 1.9-6.04 5.06 0 4.94 6.8 4.15 6.8 6.28 0 .83-.72 1.1-1.73 1.1a11.58 11.58 0 0 1-4.83-1.33v3.82a12.26 12.26 0 0 0 4.83 1.02c3.72 0 6.27-1.84 6.27-5.05 0-5.33-6.83-4.38-6.83-6.45z"/></svg>`,
    shopify: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M16.1 4.5c0-.1-.1-.1-.2-.1s-1.1-.1-1.1-.1-.7-.7-.8-.8c-.1-.1-.2-.1-.3 0l-.4.1c-.2-.7-.6-1.3-1.3-1.3h-.1c-.2-.3-.5-.4-.7-.4-1.7 0-2.6 2.2-2.8 3.3l-1.6.5c-.5.2-.5.2-.6.6L4.8 18.2l8.8 1.6 4.8-1L16.1 4.5z" fill="#95BF47"/><path d="M15.9 4.4s-1.1-.1-1.1-.1-.7-.7-.8-.8v15.3l4.8-1L16.1 4.5c0-.1-.1-.1-.2-.1z" fill="#5E8E3E"/><path d="M12 8.4l-.5 1.9s-.6-.3-1.2-.3c-1 0-1 .6-1 .8 0 .9 2.3 1.2 2.3 3.2 0 1.6-1 2.6-2.4 2.6-1.6 0-2.5-1-2.5-1l.4-1.5s.9.7 1.6.7c.5 0 .7-.4.7-.7 0-1.1-1.9-1.2-1.9-3 0-1.6 1.1-3.1 3.3-3.1.9 0 1.2.3 1.2.3z" fill="white"/></svg>`,
    hubspot: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#FF7A59"><path d="M18.16 7.58V4.95a2.24 2.24 0 0 0 1.3-2.02 2.26 2.26 0 1 0-4.51 0c0 .87.5 1.62 1.22 2v2.65a5.76 5.76 0 0 0-2.8 1.34L6.42 3.9a2.6 2.6 0 0 0 .09-.64 2.54 2.54 0 1 0-2.55 2.54c.5 0 .97-.15 1.37-.42l6.82 4.92a5.72 5.72 0 0 0-.03 7.24l-2.1 2.1a2.13 2.13 0 0 0-.63-.1 2.15 2.15 0 1 0 2.15 2.15c0-.22-.04-.43-.1-.63l2.07-2.07A5.76 5.76 0 1 0 18.16 7.58zm-1 9.87a3.42 3.42 0 1 1 0-6.84 3.42 3.42 0 0 1 0 6.84z"/></svg>`,
    trello: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#0052CC"><rect x="1" y="1" width="22" height="22" rx="3.5"/><rect x="3.5" y="3.5" width="7" height="15" rx="1.5" fill="white"/><rect x="13.5" y="3.5" width="7" height="9" rx="1.5" fill="white"/></svg>`,
    asana: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#F06A6A"><circle cx="12" cy="6.5" r="4.5"/><circle cx="5" cy="17" r="4.5"/><circle cx="19" cy="17" r="4.5"/></svg>`,
    figma: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M8 24a4 4 0 0 0 4-4v-4H8a4 4 0 0 0 0 8z" fill="#0ACF83"/><path d="M4 12a4 4 0 0 1 4-4h4v8H8a4 4 0 0 1-4-4z" fill="#A259FF"/><path d="M4 4a4 4 0 0 1 4-4h4v8H8a4 4 0 0 1-4-4z" fill="#F24E1E"/><path d="M12 0h4a4 4 0 0 1 0 8h-4V0z" fill="#FF7262"/><path d="M20 12a4 4 0 0 1-4 4h-4V8h4a4 4 0 0 1 4 4z" fill="#1ABCFE"/></svg>`,
    quickbooks: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#2CA01C"><circle cx="12" cy="12" r="11"/><path d="M7.5 8v8h1.8v-2.4H11c1.7 0 2.8-1 2.8-2.8S12.7 8 11 8H7.5zm1.8 1.5h1.5c.8 0 1.2.4 1.2 1.3 0 .8-.4 1.3-1.2 1.3H9.3V9.5z" fill="white"/></svg>`,
    microsoft: `<svg width="20" height="20" viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>`,
    apple: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#000"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>`,
    canva: `<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#00C4CC"/><path d="M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm0 8.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" fill="white"/></svg>`,
    dropbox: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#0061FF"><path d="M7.1 1.1L1 5.5l5 3.7 6-3.8-4.9-4.3zm-6.1 9l5 3.6 5-3.7-5-3.8-5 3.9zm11.1-4.3l5 3.8 4.9-3.5-5-3.7-4.9 3.4zm5 8.1l-5-3.8-5 3.7 5 3.6 5-3.5zm-5-2.3l-5-3.7-1.1.8 5 3.8 6.1-4.1-5-3.6-5 3.8 5 3z"/></svg>`,
    airtable: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M11.5 2.3L3 5.8v.4l8.5 3.3.5.1.5-.1L21 6.2v-.4l-8.5-3.5h-1z" fill="#FCB400"/><path d="M12.5 11v10.6l8.3-3.4c.1 0 .2-.2.2-.3V7.5l-8.5 3.5z" fill="#18BFFF"/><path d="M11.5 11L3 7.5v10.4c0 .1.1.3.2.3l8.3 3.4V11z" fill="#F82B60"/></svg>`,
    mailchimp: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#FFE01B"><circle cx="12" cy="12" r="11"/><path d="M12 6c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6-2.7-6-6-6zm0 10c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z" fill="#241C15"/></svg>`,
    twilio: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#F22F46"><circle cx="12" cy="12" r="11"/><circle cx="9.5" cy="9.5" r="2" fill="white"/><circle cx="14.5" cy="9.5" r="2" fill="white"/><circle cx="9.5" cy="14.5" r="2" fill="white"/><circle cx="14.5" cy="14.5" r="2" fill="white"/></svg>`,
    sendgrid: `<svg width="20" height="20" viewBox="0 0 24 24"><rect x="1" y="1" width="7.3" height="7.3" fill="#9DE1F3"/><rect x="8.3" y="1" width="7.3" height="7.3" fill="#27B4E1"/><rect x="15.6" y="1" width="7.3" height="7.3" fill="#1A82E2"/><rect x="1" y="8.3" width="7.3" height="7.3" fill="#27B4E1"/><rect x="8.3" y="8.3" width="7.3" height="7.3" fill="#1A82E2"/><rect x="1" y="15.6" width="7.3" height="7.3" fill="#1A82E2"/></svg>`,
    salesforce: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M10.1 4.4c.8-1.3 2.2-2.1 3.8-2.1 1.8 0 3.3 1 4.1 2.4a5.2 5.2 0 0 1 1.7-.3c2.9 0 5.3 2.4 5.3 5.3 0 2.9-2.4 5.3-5.3 5.3-.5 0-.9-.1-1.4-.2a4.6 4.6 0 0 1-3.8 2c-.9 0-1.7-.3-2.4-.7a5 5 0 0 1-4.1 2.2c-2.1 0-3.9-1.3-4.6-3.2-.4.1-.8.1-1.2.1C.9 15.2-.7 13.1.3 11c-.6-.9-1-2-1-3.1 0-3 2.5-5.4 5.5-5.4 1.3 0 2.5.5 3.5 1.3.5-.6 1.1-1 1.8-1.4z" fill="#00A1E0"/></svg>`,
    zoom: `<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#2D8CFF"/><path d="M6 8.5h7.5c.6 0 1 .4 1 1V15L17.5 17V7L14.5 9H7c-.6 0-1 .4-1 1v3.5c0 .6.4 1 1 1h7" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    vscode: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M17.58 2L7.72 10.16 3.87 7.17 2 8.04v7.92l1.87.87 3.85-2.99L17.58 22 22 20.08V3.92L17.58 2zM7.72 14.17L5.04 12l2.68-2.17v4.34zm9.86 3.93L12.7 12l4.88-6.1v12.2z" fill="#007ACC"/></svg>`,
    computer: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    api: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    todoist: `<svg width="20" height="20" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#E44332"/><path d="M6.4 7.2c4.3-2.5 6-1 9.4.6.2.1.2.3 0 .5L14.1 9.5c-.2.1-.3.1-.5 0-2.7-1.3-4.2-2.5-7.7-.4-.2.1-.3.1-.5 0L4 8c-.2-.2-.2-.4 0-.5l2.4-1.3zm0 4.4c4.3-2.5 6-1 9.4.6.2.1.2.3 0 .5l-1.7 1.2c-.2.1-.3.1-.5 0-2.7-1.3-4.2-2.5-7.7-.4-.2.1-.3.1-.5 0L4 12.4c-.2-.2-.2-.4 0-.5l2.4-1.3zm0 4.4c4.3-2.5 6-1 9.4.6.2.1.2.3 0 .5l-1.7 1.2c-.2.1-.3.1-.5 0-2.7-1.3-4.2-2.5-7.7-.4-.2.1-.3.1-.5 0L4 16.8c-.2-.2-.2-.4 0-.5l2.4-1.3z" fill="white"/></svg>`,
    jira: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53z" fill="#2684FF"/><path d="M8.77 4.79c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V5.63a.84.84 0 0 0-.84-.84H8.77z" fill="url(#jg1)" opacity=".7"/><path d="M6 7.57c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.35 4.34 4.35V8.41a.84.84 0 0 0-.84-.84H6z" fill="url(#jg2)" opacity=".5"/><defs><linearGradient id="jg1" x1="12" y1="5" x2="16" y2="15"><stop stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient><linearGradient id="jg2" x1="9" y1="8" x2="14" y2="18"><stop stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient></defs></svg>`,
    discord: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#5865F2"><path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.36-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"/></svg>`,
    calendly: `<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#006BFF"/><path d="M15.8 8.2a5.4 5.4 0 1 0 0 7.6" stroke="white" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="15.8" cy="8.2" r="1.3" fill="#00D4AA"/><circle cx="15.8" cy="15.8" r="1.3" fill="#FF6A00"/></svg>`,
    intercom: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#1F8DED"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M7 8v5M10 7v7M13.5 7v7M17 8v5" stroke="white" stroke-width="1.8" stroke-linecap="round"/><path d="M7 16s2 2 5 2 5-2 5-2" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`,
    confluence: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M3.3 16.5c-.3.5-.6 1-.8 1.4-.2.3-.1.8.3 1l3.6 2.1c.4.2.8.1 1-.2.2-.4.5-.9.8-1.4 1.9-3.2 3.9-2.8 7.6-1.1l3.4 1.5c.4.2.8 0 1-.4l1.6-3.8c.2-.4 0-.8-.4-1l-3.2-1.5C12.1 10.7 7.7 9.7 3.3 16.5z" fill="#1868DB"/><path d="M20.7 7.5c.3-.5.6-1 .8-1.4.2-.3.1-.8-.3-1L17.6 3c-.4-.2-.8-.1-1 .2-.2.4-.5.9-.8 1.4-1.9 3.2-3.9 2.8-7.6 1.1L4.8 4.2c-.4-.2-.8 0-1 .4L2.2 8.4c-.2.4 0 .8.4 1l3.2 1.5c6.1 2.4 10.5 3.4 14.9-3.4z" fill="#205DC5"/></svg>`,
    supabase: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M13.7 21.8c-.4.5-1.3.2-1.3-.5V13h8.6c.9 0 1.4 1 .8 1.7l-8.1 7.1z" fill="#3ECF8E"/><path d="M13.7 21.8c-.4.5-1.3.2-1.3-.5V13h8.6c.9 0 1.4 1 .8 1.7l-8.1 7.1z" fill="url(#sg)" fill-opacity=".2"/><path d="M10.3 2.2c.4-.5 1.3-.2 1.3.5V11H3c-.9 0-1.4-1-.8-1.7l8.1-7.1z" fill="#3ECF8E"/><defs><linearGradient id="sg" x1="12.5" y1="14" x2="19" y2="22"><stop stop-color="#249361"/><stop offset="1" stop-color="#3ECF8E" stop-opacity="0"/></linearGradient></defs></svg>`,
    vercel: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#000"><path d="M12 2L2 20h20L12 2z"/></svg>`,
    database: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    zendesk: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M11.2 3v14.2L2 3h9.2z" fill="#03363D"/><path d="M11.2 18.8H2l9.2-14.2v14.2z" fill="#03363D" opacity=".5"/><path d="M12.8 5.2c0 2.5 2 4.6 4.6 4.6S22 7.7 22 5.2H12.8z" fill="#03363D"/><path d="M12.8 21h9.2L12.8 6.8V21z" fill="#03363D"/></svg>`,
    clickup: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 16.5l3.6-2.8c1.8 2.3 3 3 4.4 3 1.4 0 2.6-.8 4.4-3l3.6 2.8c-2.4 3.2-4.8 4.7-8 4.7s-5.6-1.5-8-4.7z" fill="#8930FD"/><path d="M12 7.5l-6.5 5.3-2.5-3L12 3l9 6.8-2.5 3L12 7.5z" fill="#49CCF9"/></svg>`,
    monday: `<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="5" cy="15" r="3" fill="#FF3D57"/><circle cx="12" cy="12" r="3" fill="#FFCB00"/><circle cx="19" cy="9" r="3" fill="#00D647"/><rect x="3" y="15" width="4" height="5" rx="2" fill="#FF3D57"/><rect x="10" y="12" width="4" height="8" rx="2" fill="#FFCB00"/><rect x="17" y="9" width="4" height="11" rx="2" fill="#00D647"/></svg>`,
  };

  function openIntegrations() {
    integrationsPanel.classList.remove("hidden");
    integrationsOverlay.classList.remove("hidden");
    loadIntegrations();
  }

  function closeIntegrations() {
    integrationsPanel.classList.add("hidden");
    integrationsOverlay.classList.add("hidden");
  }

  if (integrationsBtn) integrationsBtn.addEventListener("click", openIntegrations);
  if (integrationsClose) integrationsClose.addEventListener("click", closeIntegrations);
  if (integrationsOverlay) integrationsOverlay.addEventListener("click", closeIntegrations);

  // --- Wiki Knowledge Base Panel ---
  const memoryBtn = document.getElementById("memory-btn");
  const memoryPanel = document.getElementById("memory-panel");
  const memoryOverlay = document.getElementById("memory-overlay");
  const memoryClose = document.getElementById("memory-close");
  const memoryBody = document.getElementById("memory-body");

  let wikiActiveCategory = "all";

  function openMemory() { memoryPanel.classList.remove("hidden"); memoryOverlay.classList.remove("hidden"); loadWiki(); }
  function closeMemory() { memoryPanel.classList.add("hidden"); memoryOverlay.classList.add("hidden"); }
  if (memoryBtn) memoryBtn.addEventListener("click", openMemory);
  if (memoryClose) memoryClose.addEventListener("click", closeMemory);
  if (memoryOverlay) memoryOverlay.addEventListener("click", closeMemory);

  const wikiCategoryLabels = { user: "You", project: "Projects", decision: "Decisions", preference: "Preferences", reference: "References", fact: "Facts" };
  const wikiCategoryIcons = {
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    project: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    decision: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    preference: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    reference: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    fact: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  async function loadWiki() {
    memoryBody.innerHTML = '<div class="integrations-loading">Loading...</div>';
    try {
      const res = await fetch("/wiki");
      const data = await res.json();
      renderWikiPanel(data.pages || [], data.stats || {});
    } catch { memoryBody.innerHTML = '<div class="integrations-loading">Could not load knowledge base.</div>'; }
  }

  function renderWikiPanel(pages, stats) {
    const totalPages = stats.totalPages || 0;
    const byCategory = stats.byCategory || {};

    // Category tabs
    let tabsHtml = '<div class="wiki-tabs"><button class="wiki-tab' + (wikiActiveCategory === "all" ? " active" : "") + '" data-cat="all">All <span class="wiki-tab-count">' + totalPages + '</span></button>';
    for (const cat of ["user", "project", "decision", "preference", "reference", "fact"]) {
      const count = byCategory[cat] || 0;
      if (count > 0 || cat === "user") {
        tabsHtml += '<button class="wiki-tab' + (wikiActiveCategory === cat ? " active" : "") + '" data-cat="' + cat + '">' + (wikiCategoryIcons[cat] || "") + ' ' + wikiCategoryLabels[cat] + ' <span class="wiki-tab-count">' + count + '</span></button>';
      }
    }
    tabsHtml += '</div>';

    // Filter pages
    const filtered = wikiActiveCategory === "all" ? pages : pages.filter(p => p.category === wikiActiveCategory);
    // Sort: most recently updated first
    filtered.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));

    // Page cards
    let cardsHtml = "";
    if (!filtered.length) {
      cardsHtml = '<div class="wiki-empty">' +
        '<div class="wiki-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div>' +
        '<p class="wiki-empty-title">No pages yet</p>' +
        '<p class="wiki-empty-sub">Delt learns from your conversations and saves lasting facts here. The more you chat, the smarter it gets.</p>' +
        '</div>';
    } else {
      cardsHtml = '<div class="wiki-cards">';
      for (const page of filtered) {
        const catIcon = wikiCategoryIcons[page.category] || "";
        const catLabel = wikiCategoryLabels[page.category] || page.category;
        const updated = page.updated ? new Date(page.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        const tags = (page.tags || []).map(t => '<span class="wiki-tag">' + escapeHtml(t) + '</span>').join("");
        cardsHtml += '<div class="wiki-card" data-page-id="' + escapeHtml(page.id) + '">' +
          '<div class="wiki-card-header">' +
            '<span class="wiki-card-category">' + catIcon + ' ' + escapeHtml(catLabel) + '</span>' +
            '<span class="wiki-card-date">' + escapeHtml(updated) + '</span>' +
          '</div>' +
          '<div class="wiki-card-title">' + escapeHtml(page.title) + '</div>' +
          '<div class="wiki-card-summary">' + escapeHtml(page.summary || "") + '</div>' +
          (tags ? '<div class="wiki-card-tags">' + tags + '</div>' : "") +
        '</div>';
      }
      cardsHtml += '</div>';
    }

    // Add page button + info
    const addBtn = '<div class="wiki-actions"><button class="memory-edit-btn" id="wiki-add-btn">Add a page</button></div>';
    const infoHtml = '<div class="memory-info-section"><div class="memory-info-card"><strong>How does this work?</strong><p>After each conversation, Delt extracts lasting facts into wiki pages organized by topic. This knowledge base is loaded into every new chat so Delt remembers you across sessions.</p><p style="margin-top:8px;"><strong>This data never leaves your computer.</strong> Stored at <code>~/.delt/wiki/</code>.</p></div></div>';

    memoryBody.innerHTML = tabsHtml + cardsHtml + addBtn + infoHtml;

    // Tab click handlers
    memoryBody.querySelectorAll(".wiki-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        wikiActiveCategory = tab.dataset.cat;
        renderWikiPanel(pages, stats);
      });
    });

    // Card click → expand page
    memoryBody.querySelectorAll(".wiki-card").forEach(card => {
      card.addEventListener("click", () => openWikiPage(card.dataset.pageId));
    });

    // Add page button
    const addBtnEl = memoryBody.querySelector("#wiki-add-btn");
    if (addBtnEl) addBtnEl.addEventListener("click", () => showWikiEditor(null));
  }

  async function openWikiPage(pageId) {
    memoryBody.innerHTML = '<div class="integrations-loading">Loading...</div>';
    try {
      const parts = pageId.split("/");
      const res = await fetch("/wiki/page/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]));
      const page = await res.json();
      renderWikiPageView(page);
    } catch { memoryBody.innerHTML = '<div class="integrations-loading">Could not load page.</div>'; }
  }

  function renderWikiPageView(page) {
    const catIcon = wikiCategoryIcons[page.category] || "";
    const catLabel = wikiCategoryLabels[page.category] || page.category;
    const updated = page.updated ? new Date(page.updated).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const created = page.created ? new Date(page.created).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    const tags = (page.tags || []).map(t => '<span class="wiki-tag">' + escapeHtml(t) + '</span>').join("");

    memoryBody.innerHTML =
      '<div class="wiki-page-view">' +
        '<button class="wiki-back-btn" id="wiki-back-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Back</button>' +
        '<div class="wiki-page-header">' +
          '<span class="wiki-card-category">' + catIcon + ' ' + escapeHtml(catLabel) + '</span>' +
          '<h3 class="wiki-page-title">' + escapeHtml(page.title) + '</h3>' +
          '<div class="wiki-page-meta">' +
            (created ? '<span>Created ' + escapeHtml(created) + '</span>' : '') +
            (updated ? '<span>Updated ' + escapeHtml(updated) + '</span>' : '') +
          '</div>' +
          (tags ? '<div class="wiki-card-tags">' + tags + '</div>' : '') +
        '</div>' +
        '<div class="memory-content-display">' + renderMd(page.content || "") + '</div>' +
        '<div class="wiki-page-actions">' +
          '<button class="memory-edit-btn" id="wiki-edit-page-btn">Edit</button>' +
          '<button class="memory-clear-btn" id="wiki-delete-page-btn">Delete</button>' +
        '</div>' +
        '<div class="memory-editor hidden" id="wiki-page-editor">' +
          '<textarea class="memory-textarea" id="wiki-page-textarea" rows="12">' + escapeHtml(page.content || "") + '</textarea>' +
          '<div class="memory-editor-actions">' +
            '<button class="memory-save-btn" id="wiki-page-save">Save</button>' +
            '<button class="memory-cancel-btn" id="wiki-page-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    memoryBody.querySelector("#wiki-back-btn").addEventListener("click", loadWiki);

    const editBtn = memoryBody.querySelector("#wiki-edit-page-btn");
    const deleteBtn = memoryBody.querySelector("#wiki-delete-page-btn");
    const editor = memoryBody.querySelector("#wiki-page-editor");
    const display = memoryBody.querySelector(".memory-content-display");
    const textarea = memoryBody.querySelector("#wiki-page-textarea");
    const saveBtn = memoryBody.querySelector("#wiki-page-save");
    const cancelBtn = memoryBody.querySelector("#wiki-page-cancel");

    editBtn.addEventListener("click", () => {
      editor.classList.remove("hidden");
      display.classList.add("hidden");
      editBtn.classList.add("hidden");
      deleteBtn.classList.add("hidden");
      textarea.focus();
    });

    cancelBtn.addEventListener("click", () => {
      editor.classList.add("hidden");
      display.classList.remove("hidden");
      editBtn.classList.remove("hidden");
      deleteBtn.classList.remove("hidden");
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.textContent = "Saving..."; saveBtn.disabled = true;
      try {
        const parts = page.id.split("/");
        await fetch("/wiki/page/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: textarea.value }),
        });
        openWikiPage(page.id);
      } catch { saveBtn.textContent = "Failed"; saveBtn.disabled = false; }
    });

    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Delete this page? This can't be undone.")) return;
      try {
        const parts = page.id.split("/");
        await fetch("/wiki/page/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]), { method: "DELETE" });
        loadWiki();
      } catch {}
    });
  }

  function showWikiEditor(page) {
    const isNew = !page;
    memoryBody.innerHTML =
      '<div class="wiki-page-view">' +
        '<button class="wiki-back-btn" id="wiki-back-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Back</button>' +
        '<h3 class="wiki-page-title" style="margin:12px 0 16px">' + (isNew ? "New Page" : "Edit Page") + '</h3>' +
        '<div class="wiki-editor-form">' +
          '<input class="wiki-input" id="wiki-new-title" placeholder="Page title" value="' + escapeHtml(page ? page.title : "") + '" />' +
          '<select class="wiki-input" id="wiki-new-category">' +
            '<option value="user"' + (!page || page.category === "user" ? " selected" : "") + '>You</option>' +
            '<option value="project"' + (page && page.category === "project" ? " selected" : "") + '>Project</option>' +
            '<option value="decision"' + (page && page.category === "decision" ? " selected" : "") + '>Decision</option>' +
            '<option value="preference"' + (page && page.category === "preference" ? " selected" : "") + '>Preference</option>' +
            '<option value="reference"' + (page && page.category === "reference" ? " selected" : "") + '>Reference</option>' +
            '<option value="fact"' + (page && page.category === "fact" ? " selected" : "") + '>Fact</option>' +
          '</select>' +
          '<input class="wiki-input" id="wiki-new-tags" placeholder="Tags (comma separated)" value="' + escapeHtml(page ? (page.tags || []).join(", ") : "") + '" />' +
          '<textarea class="memory-textarea" id="wiki-new-content" rows="10" placeholder="What should Delt remember?">' + escapeHtml(page ? page.content : "") + '</textarea>' +
          '<div class="memory-editor-actions">' +
            '<button class="memory-save-btn" id="wiki-new-save">Save</button>' +
            '<button class="memory-cancel-btn" id="wiki-new-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    memoryBody.querySelector("#wiki-back-btn").addEventListener("click", loadWiki);
    memoryBody.querySelector("#wiki-new-cancel").addEventListener("click", loadWiki);
    memoryBody.querySelector("#wiki-new-save").addEventListener("click", async () => {
      const title = memoryBody.querySelector("#wiki-new-title").value.trim();
      const category = memoryBody.querySelector("#wiki-new-category").value;
      const tags = memoryBody.querySelector("#wiki-new-tags").value.split(",").map(t => t.trim()).filter(Boolean);
      const content = memoryBody.querySelector("#wiki-new-content").value.trim();
      if (!title || !content) return;
      const saveBtn = memoryBody.querySelector("#wiki-new-save");
      saveBtn.textContent = "Saving..."; saveBtn.disabled = true;
      try {
        await fetch("/wiki/page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, title, content, tags }),
        });
        loadWiki();
      } catch { saveBtn.textContent = "Failed"; saveBtn.disabled = false; }
    });
  }

  async function loadIntegrations() {
    integrationsBody.innerHTML = '<div class="integrations-loading">Loading...</div>';
    try {
      const res = await fetch("/integrations");
      const data = await res.json();
      renderIntegrations(data.integrations || []);
    } catch {
      integrationsBody.innerHTML = '<div class="integrations-loading">Failed to load integrations.</div>';
    }
    // Always refresh header chips after integration list changes
    refreshIntegrationChips();
  }

  // Integration search state
  let integrationSearchQuery = "";

  function renderIntegrations(integrations) {
    const allItems = integrations.filter(i => i.id !== "custom-api");
    const connected = allItems.filter(i => i.connected);
    const total = allItems.length;
    const connectedCount = connected.length;
    const pct = total ? Math.round((connectedCount / total) * 100) : 0;

    // Group by category
    const byCategory = {};
    for (const i of allItems) {
      const cat = i.category || "other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(i);
    }

    // Category display order
    const catOrder = ["system", "productivity", "communication", "development", "commerce", "finance", "crm", "design", "storage", "support"];

    let html = "";

    // --- Progress header ---
    html += `<div class="cc-progress-bar">
      <div class="cc-progress-info">
        <span class="cc-progress-count">${connectedCount} of ${total} connected</span>
        <span class="cc-progress-pct">${pct}%</span>
      </div>
      <div class="cc-progress-track"><div class="cc-progress-fill" style="width:${pct}%"></div></div>
    </div>`;

    // --- Search ---
    html += `<div class="cc-search-wrap">
      <svg class="cc-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input class="cc-search" id="cc-search" type="text" placeholder="Search integrations..." autocomplete="off" value="${escapeHtml(integrationSearchQuery)}">
      ${integrationSearchQuery ? '<button class="cc-search-clear" id="cc-search-clear" title="Clear">&times;</button>' : ""}
    </div>`;

    // --- Category filter pills ---
    html += `<div class="cc-category-pills" id="cc-category-pills">
      <button class="cc-pill active" data-cat="all">All</button>
      <button class="cc-pill" data-cat="connected">Connected (${connectedCount})</button>
      ${catOrder.filter(c => byCategory[c]).map(c => {
        const meta = CATEGORY_META[c] || { label: c, color: "#888" };
        return `<button class="cc-pill" data-cat="${c}"><span class="cc-pill-dot" style="background:${meta.color}"></span>${meta.label}</button>`;
      }).join("")}
    </div>`;

    // --- Integration cards by category ---
    for (const cat of catOrder) {
      if (!byCategory[cat]) continue;
      const meta = CATEGORY_META[cat] || { label: cat, color: "#888" };
      const items = byCategory[cat];
      const catConnected = items.filter(i => i.connected).length;

      html += `<div class="cc-category" data-category="${cat}">
        <div class="cc-category-header">
          <span class="cc-category-dot" style="background:${meta.color}"></span>
          <span class="cc-category-name">${meta.label}</span>
          <span class="cc-category-count">${catConnected}/${items.length}</span>
        </div>
        <div class="cc-category-grid">
          ${items.map(i => renderIntegrationCard(i, meta.color)).join("")}
        </div>
      </div>`;
    }

    // --- Custom APIs ---
    html += `<div class="cc-category" data-category="custom">
      <div class="cc-category-header">
        <span class="cc-category-dot" style="background:#6366F1"></span>
        <span class="cc-category-name">Custom APIs</span>
        <button id="add-custom-api-btn" class="cc-add-api-btn">+ Add</button>
      </div>
      <div id="custom-apis-list"></div>
      <div id="custom-api-form-container"></div>
    </div>`;

    integrationsBody.innerHTML = html;

    // --- Bind search ---
    const searchEl = document.getElementById("cc-search");
    if (searchEl) {
      searchEl.addEventListener("input", (e) => {
        integrationSearchQuery = e.target.value;
        filterIntegrations();
      });
      if (integrationSearchQuery) filterIntegrations();
    }
    const clearBtn = document.getElementById("cc-search-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      integrationSearchQuery = "";
      if (searchEl) searchEl.value = "";
      filterIntegrations();
      clearBtn.remove();
    });

    // --- Bind category pills ---
    const pills = document.querySelectorAll(".cc-pill");
    pills.forEach(pill => {
      pill.addEventListener("click", () => {
        pills.forEach(p => p.classList.remove("active"));
        pill.classList.add("active");
        const cat = pill.dataset.cat;
        document.querySelectorAll(".cc-category").forEach(el => {
          if (cat === "all") {
            el.style.display = "";
            el.querySelectorAll(".cc-card").forEach(c => c.style.display = "");
          } else if (cat === "connected") {
            // Show categories that have connected items, hide cards that aren't connected
            const cards = el.querySelectorAll(".cc-card");
            let hasVisible = false;
            cards.forEach(c => {
              if (c.classList.contains("connected")) { c.style.display = ""; hasVisible = true; }
              else c.style.display = "none";
            });
            el.style.display = hasVisible ? "" : "none";
          } else {
            el.style.display = el.dataset.category === cat || el.dataset.category === "custom" ? "" : "none";
          }
        });
      });
    });

    // Bind events via delegation
    integrationsBody.removeEventListener("click", handleIntegrationClick);
    integrationsBody.addEventListener("click", handleIntegrationClick);

    // Load custom APIs
    loadCustomApis();
    const addBtn = document.getElementById("add-custom-api-btn");
    if (addBtn) addBtn.addEventListener("click", showAddCustomApiForm);
  }

  function filterIntegrations() {
    const q = integrationSearchQuery.toLowerCase().trim();
    document.querySelectorAll(".cc-card").forEach(card => {
      if (!q) { card.style.display = ""; return; }
      const name = (card.dataset.name || "").toLowerCase();
      const desc = (card.dataset.desc || "").toLowerCase();
      card.style.display = (name.includes(q) || desc.includes(q)) ? "" : "none";
    });
    // Hide empty categories
    document.querySelectorAll(".cc-category").forEach(cat => {
      const visibleCards = cat.querySelectorAll('.cc-card:not([style*="display: none"])');
      // Don't hide custom category
      if (cat.dataset.category === "custom") return;
      cat.style.display = visibleCards.length ? "" : "none";
    });
  }

  // --- Custom API Hub ---
  async function loadCustomApis() {
    const listEl = document.getElementById("custom-apis-list");
    if (!listEl) return;
    try {
      const res = await fetch("/custom-apis");
      const data = await res.json();
      if (!data.apis || !data.apis.length) {
        listEl.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No custom APIs added yet. Click + Add API to connect any service.</div>';
        return;
      }
      listEl.innerHTML = data.apis.map(api => `
        <div class="custom-api-card" data-api-id="${api.id}">
          <div class="custom-api-info">
            <span class="custom-api-name">${escapeHtml(api.name)}</span>
            <span class="custom-api-url">${escapeHtml(api.baseUrl)}</span>
            ${api.description ? `<span class="custom-api-desc">${escapeHtml(api.description)}</span>` : ""}
          </div>
          <div class="custom-api-actions">
            <span style="font-size:10px;color:var(--text-faint);">${escapeHtml(api.authType)}</span>
            <button class="custom-api-test-btn" data-api-id="${api.id}" style="padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:11px;cursor:pointer;">Test</button>
            <button class="custom-api-delete-btn" data-api-id="${api.id}" style="padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--error);font-size:11px;cursor:pointer;">Remove</button>
          </div>
        </div>
      `).join("");

      // Wire up test/delete buttons
      listEl.querySelectorAll(".custom-api-test-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.textContent = "Testing...";
          btn.disabled = true;
          try {
            const r = await fetch(`/custom-apis/${btn.dataset.apiId}/test`, { method: "POST" });
            const d = await r.json();
            btn.textContent = d.ok ? `${d.status} OK ✓` : `${d.status || "Failed"} ✗`;
            btn.style.color = d.ok ? "var(--success)" : "var(--error)";
          } catch { btn.textContent = "Error"; btn.style.color = "var(--error)"; }
          setTimeout(() => { btn.textContent = "Test"; btn.disabled = false; btn.style.color = ""; }, 3000);
        });
      });
      listEl.querySelectorAll(".custom-api-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.textContent = "Removing...";
          await fetch(`/custom-apis/${btn.dataset.apiId}`, { method: "DELETE" });
          loadCustomApis();
          refreshIntegrationChips();
        });
      });
    } catch {
      listEl.innerHTML = '<div style="color:var(--error);font-size:12px;">Failed to load custom APIs</div>';
    }
  }

  async function showAddCustomApiForm() {
    const container = document.getElementById("custom-api-form-container");
    if (!container) return;
    if (container.querySelector(".custom-api-form")) { container.innerHTML = ""; return; }

    // Load templates
    let templates = [];
    try {
      const r = await fetch("/custom-apis/templates");
      const d = await r.json();
      templates = d.templates || [];
    } catch {}

    const form = document.createElement("div");
    form.className = "custom-api-form";
    form.innerHTML = `
      <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Add a Custom API</div>
      ${templates.length ? `
        <select id="api-template-select" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-primary);font-size:12px;margin-bottom:8px;">
          <option value="">Choose a template or enter manually...</option>
          ${templates.map(t => `<option value="${escapeHtml(JSON.stringify(t))}">${escapeHtml(t.name)} — ${escapeHtml(t.description)}</option>`).join("")}
        </select>
      ` : ""}
      <div id="capi-setup-guide" style="display:none;"></div>
      <input class="capi-input" id="capi-name" type="text" placeholder="Name (e.g. Stripe, My CRM)" autocomplete="off">
      <input class="capi-input" id="capi-url" type="url" placeholder="Base URL (e.g. https://api.example.com/v1)" autocomplete="off">
      <select class="capi-input" id="capi-auth" style="padding:8px;">
        <option value="bearer">Bearer Token</option>
        <option value="api-key">API Key (custom header)</option>
        <option value="basic">Basic Auth</option>
        <option value="none">No Auth</option>
      </select>
      <div id="capi-auth-fields">
        <input class="capi-input" id="capi-key" type="password" placeholder="API key or token" autocomplete="off">
      </div>
      <input class="capi-input" id="capi-desc" type="text" placeholder="What does this API do? (optional)" autocomplete="off">
      <div style="display:flex;gap:8px;margin-top:4px;">
        <button id="capi-submit" class="token-wizard-submit" style="flex:1" disabled>Add API</button>
        <button id="capi-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:12px;cursor:pointer;">Cancel</button>
      </div>
    `;
    container.appendChild(form);

    const nameEl = form.querySelector("#capi-name");
    const urlEl = form.querySelector("#capi-url");
    const authEl = form.querySelector("#capi-auth");
    const keyEl = form.querySelector("#capi-key");
    const descEl = form.querySelector("#capi-desc");
    const submitBtn = form.querySelector("#capi-submit");
    const cancelBtn = form.querySelector("#capi-cancel");
    const authFields = form.querySelector("#capi-auth-fields");
    const templateSelect = form.querySelector("#api-template-select");

    // Template selector
    const guideEl = form.querySelector("#capi-setup-guide");
    if (templateSelect) {
      templateSelect.addEventListener("change", () => {
        if (!templateSelect.value) {
          if (guideEl) { guideEl.style.display = "none"; guideEl.innerHTML = ""; }
          return;
        }
        try {
          const t = JSON.parse(templateSelect.value);
          nameEl.value = t.name || "";
          urlEl.value = t.baseUrl || "";
          authEl.value = t.authType || "bearer";
          descEl.value = t.description || "";
          if (t.headerName) {
            updateAuthFields();
            const headerEl = form.querySelector("#capi-header");
            if (headerEl) headerEl.value = t.headerName;
          }
          updateAuthFields();
          checkValid();

          // Show setup guide if available
          if (guideEl && t.setupGuide) {
            const g = t.setupGuide;
            const stepsHtml = (g.steps || []).map((s, i) => `<li>${escapeHtml(s)}</li>`).join("");
            guideEl.innerHTML = `
              <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <span style="font-weight:600;font-size:12px;color:var(--text-primary);">How to get your ${escapeHtml(t.name)} key</span>
                  ${g.time ? `<span style="font-size:11px;color:var(--text-faint);">${escapeHtml(g.time)}</span>` : ""}
                </div>
                <ol style="margin:0;padding-left:20px;font-size:12px;color:var(--text-muted);line-height:1.7;">${stepsHtml}</ol>
                ${g.helpUrl ? `<a href="${g.helpUrl}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;">Open ${escapeHtml(t.name)} settings &rarr;</a>` : ""}
              </div>
            `;
            guideEl.style.display = "block";
          } else if (guideEl) {
            guideEl.style.display = "none";
            guideEl.innerHTML = "";
          }

          const firstKey = form.querySelector("#capi-key");
          if (firstKey) firstKey.focus(); else nameEl.focus();
        } catch {}
      });
    }

    function updateAuthFields() {
      const type = authEl.value;
      if (type === "api-key") {
        authFields.innerHTML = `
          <input class="capi-input" id="capi-header" type="text" placeholder="Header name (e.g. X-API-Key)" value="X-API-Key" autocomplete="off">
          <input class="capi-input" id="capi-key" type="password" placeholder="API key" autocomplete="off">
        `;
      } else if (type === "basic") {
        authFields.innerHTML = `
          <input class="capi-input" id="capi-username" type="text" placeholder="Username" autocomplete="off">
          <input class="capi-input" id="capi-password" type="password" placeholder="Password" autocomplete="off">
        `;
      } else if (type === "none") {
        authFields.innerHTML = "";
      } else {
        authFields.innerHTML = `<input class="capi-input" id="capi-key" type="password" placeholder="Bearer token" autocomplete="off">`;
      }
      // Re-wire validation
      authFields.querySelectorAll("input").forEach(i => i.addEventListener("input", checkValid));
    }

    function checkValid() {
      submitBtn.disabled = !nameEl.value.trim() || !urlEl.value.trim();
    }

    [nameEl, urlEl, descEl].forEach(el => el.addEventListener("input", checkValid));
    authEl.addEventListener("change", () => { updateAuthFields(); checkValid(); });
    cancelBtn.addEventListener("click", () => form.remove());

    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Adding...";
      const body = {
        name: nameEl.value.trim(),
        baseUrl: urlEl.value.trim(),
        authType: authEl.value,
        description: descEl.value.trim(),
      };
      const keyInput = form.querySelector("#capi-key");
      const headerInput = form.querySelector("#capi-header");
      const usernameInput = form.querySelector("#capi-username");
      const passwordInput = form.querySelector("#capi-password");
      if (keyInput) body.apiKey = keyInput.value.trim();
      if (headerInput) body.headerName = headerInput.value.trim();
      if (usernameInput) body.username = usernameInput.value.trim();
      if (passwordInput) body.password = passwordInput.value.trim();

      try {
        const r = await fetch("/custom-apis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.ok) {
          form.remove();
          loadCustomApis();
          refreshIntegrationChips();
        } else {
          submitBtn.textContent = d.error || "Failed";
          submitBtn.disabled = false;
        }
      } catch {
        submitBtn.textContent = "Failed — try again";
        submitBtn.disabled = false;
      }
    });

    nameEl.focus();
  }

  function renderIntegrationCard(i, catColor) {
    const icon = INTEGRATION_ICONS[i.icon] || i.name.charAt(0);
    const authType = i.effectiveAuthType || i.authType;

    // Button label
    let btnLabel = "Connect";
    if (i.authType === "local-access") btnLabel = "Configure";
    else if (authType === "oauth2") btnLabel = "Sign in";
    else if (authType === "enable") btnLabel = "Enable";
    else if (authType === "unavailable") btnLabel = "Coming soon";

    if (i.connected) {
      const statusLabel = i.authType === "local-access"
        ? (i.accessLevel === "full" ? "Full Access" : "Limited")
        : "Connected";
      return `
        <div class="cc-card connected" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-desc="${escapeHtml(i.description)}">
          <div class="cc-card-top">
            <div class="cc-card-icon" style="background:${catColor}15;color:${catColor}">${icon}</div>
            <div class="cc-card-status connected">
              <span class="cc-status-dot"></span>${statusLabel}
            </div>
          </div>
          <div class="cc-card-name">${escapeHtml(i.name)}</div>
          <div class="cc-card-desc">${escapeHtml(i.description)}</div>
          ${i.tryIt ? `<button class="cc-tryit" data-action="tryit" data-prompt="${escapeHtml(i.tryIt)}">Try it</button>` : ""}
          <div class="cc-card-actions">
            <button class="cc-action-btn" data-action="verify" data-id="${i.id}">Test</button>
            ${i.authType === "local-access" ? `<button class="cc-action-btn" data-action="connect" data-id="${i.id}" data-auth="local-access">Edit</button>` : ""}
            <button class="cc-action-btn danger" data-action="disconnect" data-id="${i.id}">Remove</button>
          </div>
          <div class="cc-card-expand" id="cc-expand-${i.id}"></div>
        </div>`;
    }

    return `
      <div class="cc-card" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-desc="${escapeHtml(i.description)}">
        <div class="cc-card-top">
          <div class="cc-card-icon" style="background:${catColor}15;color:${catColor}">${icon}</div>
        </div>
        <div class="cc-card-name">${escapeHtml(i.name)}</div>
        <div class="cc-card-desc">${escapeHtml(i.description)}</div>
        <button class="cc-connect-btn" data-action="connect" data-id="${i.id}" data-auth="${authType}" style="--cat-color:${catColor}">${btnLabel}</button>
        <div class="cc-card-expand" id="cc-expand-${i.id}"></div>
      </div>`;
  }

  async function handleIntegrationClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const id = btn.dataset.id;
    const action = btn.dataset.action;

    // "Try it" — inject prompt and close panel
    if (action === "tryit") {
      const prompt = btn.dataset.prompt;
      if (prompt) {
        closeIntegrations();
        sendMessage(prompt);
      }
      return;
    }

    if (action === "verify") {
      btn.textContent = "Testing...";
      btn.disabled = true;
      try {
        const res = await fetch(`/integrations/${id}/test`, { method: "POST" });
        const data = await res.json();
        if (data.ok) {
          btn.textContent = "OK";
          btn.classList.add("success");
        } else {
          btn.textContent = "Fail";
          btn.classList.add("error");
          btn.title = data.error || "MCP server failed to start";
        }
      } catch {
        btn.textContent = "Err";
        btn.classList.add("error");
      }
      setTimeout(() => { btn.textContent = "Test"; btn.disabled = false; btn.classList.remove("success", "error"); btn.title = ""; }, 3000);
      return;
    }

    if (action === "disconnect") {
      btn.textContent = "...";
      try {
        await fetch(`/integrations/${id}/disconnect`, { method: "POST" });
        loadIntegrations();
      } catch {}
      return;
    }

    if (action === "connect") {
      const authType = btn.dataset.auth;
      const card = btn.closest(".cc-card");

      if (authType === "enable") {
        btn.textContent = "Enabling...";
        btn.disabled = true;
        try {
          const enableRes = await fetch(`/integrations/${id}/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const enableData = await enableRes.json();
          if (enableData.warning) {
            btn.textContent = "Check setup";
            btn.style.background = "#f59e0b";
            btn.title = enableData.warning;
            setTimeout(() => loadIntegrations(), 2000);
          } else {
            loadIntegrations();
          }
        } catch { btn.textContent = "Failed"; btn.disabled = false; }

      } else if (authType === "local-access") {
        showLocalAccessWizard(id, card || btn.closest(".cc-card"));

      } else if (authType === "oauth2") {
        showOAuthInlineSteps(id, card || btn.closest(".cc-card"));

      } else if (authType === "token") {
        // Try auto-detect first
        btn.textContent = "Detecting...";
        btn.disabled = true;
        try {
          const detectRes = await fetch(`/integrations/${id}/auto-detect`, { method: "POST" });
          const detectData = await detectRes.json();
          if (detectData.detected && detectData.connected) {
            loadIntegrations();
            return;
          }
        } catch {}
        btn.textContent = "Connect";
        btn.disabled = false;

        // Show inline expansion instead of modal popup
        showInlineConnect(id, card);

      } else {
        alert("This integration isn't available yet.");
      }
    }
  }

  // --- Inline Connect (replaces modal popup) ---
  async function showInlineConnect(integrationId, cardEl) {
    const expandEl = document.getElementById(`cc-expand-${integrationId}`);
    if (!expandEl) {
      // Fallback to old modal if no expand area
      showTokenWizard(integrationId, cardEl);
      return;
    }
    // Toggle off if already open
    if (expandEl.classList.contains("open")) {
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
      return;
    }

    // Show loading state immediately so it's visible before any async work
    expandEl.innerHTML = `<div class="cc-inline-connect"><div class="cc-inline-loading-row"><span class="cc-inline-spinner"></span><span style="font-size:12px;color:var(--text-muted)">Loading…</span></div></div>`;
    expandEl.classList.add("open");
    expandEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Fetch integration details
    const intData = await fetch("/integrations").then(r => r.json());
    const integration = (intData.integrations || []).find(i => i.id === integrationId);
    if (!integration) {
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
      return;
    }

    const tc = integration.tokenConfig || {};
    const hasFields = tc.fields && tc.fields.length > 0;
    const helpUrl = tc.helpUrl;

    // Open help URL as a positioned side popup so Delt instructions stay visible alongside it
    let helpPopup = null;
    if (helpUrl) {
      const popW = Math.round(screen.width * 0.48);
      const popH = Math.round(screen.height * 0.9);
      helpPopup = window.open(helpUrl, "delt-help", `width=${popW},height=${popH},left=0,top=0,resizable=yes,scrollbars=yes`);
      window.focus();
    }

    // Always show floating guide with setup steps while connecting
    let connectGuide = showFloatingGuide(integrationId, integration.name);

    // Build inline form
    const inputsHtml = hasFields
      ? tc.fields.map(f => `
        <div class="cc-inline-field">
          <label>${escapeHtml(f.label)}</label>
          <div class="cc-inline-input-wrap">
            <input class="cc-inline-input" data-key="${escapeHtml(f.key)}" type="password" placeholder="${escapeHtml(f.placeholder || '')}" autocomplete="off" spellcheck="false">
            <button type="button" class="cc-inline-toggle" tabindex="-1">Show</button>
          </div>
        </div>`).join("")
      : `<div class="cc-inline-field">
          <label>${escapeHtml(tc.label || "API Key")}</label>
          <div class="cc-inline-input-wrap">
            <input class="cc-inline-input" type="password" placeholder="${escapeHtml(tc.placeholder || 'Paste your token here')}" autocomplete="off" spellcheck="false">
            <button type="button" class="cc-inline-toggle" tabindex="-1">Show</button>
          </div>
        </div>`;

    expandEl.innerHTML = `
      <div class="cc-inline-connect">
        ${helpUrl ? `<div class="cc-inline-hint"><span class="cc-inline-hint-arrow">&#x2190;</span> A page opened to the left — follow the steps there to get your key, then paste it here.</div>` : ""}
        ${helpUrl ? `<a class="cc-inline-reopen" href="${escapeHtml(helpUrl)}" target="_blank" rel="noopener">Page didn't open? Click here to try again</a>` : ""}
        ${inputsHtml}
        <div class="cc-inline-actions">
          <button class="cc-inline-submit" disabled>Connect</button>
          <button class="cc-inline-cancel">Cancel</button>
        </div>
        <div class="cc-inline-error" style="display:none"></div>
      </div>
    `;
    expandEl.classList.add("open");

    // Bind show/hide toggles
    expandEl.querySelectorAll(".cc-inline-toggle").forEach(btn => {
      btn.onclick = () => {
        const inp = btn.parentElement.querySelector("input");
        if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
        else { inp.type = "password"; btn.textContent = "Show"; }
      };
    });

    const inputs = expandEl.querySelectorAll(".cc-inline-input");
    const submit = expandEl.querySelector(".cc-inline-submit");
    const cancel = expandEl.querySelector(".cc-inline-cancel");
    const errorEl = expandEl.querySelector(".cc-inline-error");

    function checkFilled() {
      submit.disabled = ![...inputs].every(inp => inp.value.trim());
    }
    inputs.forEach(inp => {
      inp.addEventListener("input", () => { errorEl.style.display = "none"; checkFilled(); });
      inp.addEventListener("keydown", e => { if (e.key === "Enter" && !submit.disabled) doConnect(); });
    });

    cancel.addEventListener("click", () => {
      if (connectGuide) { connectGuide.close(); connectGuide = null; }
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
    });

    submit.addEventListener("click", doConnect);

    async function doConnect() {
      submit.disabled = true;
      submit.textContent = "Connecting...";
      errorEl.style.display = "none";
      let body;
      if (hasFields) {
        const fields = {};
        inputs.forEach(inp => { fields[inp.dataset.key] = inp.value.trim(); });
        body = { fields };
      } else {
        body = { token: inputs[0].value.trim() };
      }
      try {
        const res = await fetch(`/integrations/${integrationId}/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await res.json();
        if (result.ok) {
          try { if (helpPopup && !helpPopup.closed) helpPopup.close(); } catch {}
          if (connectGuide) { connectGuide.close(); connectGuide = null; }
          submit.textContent = "Connected!";
          submit.classList.add("success");
          setTimeout(() => loadIntegrations(), 600);
        } else {
          errorEl.textContent = result.error || "Connection failed. Check your credentials.";
          errorEl.style.display = "block";
          submit.textContent = "Connect";
          submit.disabled = false;
        }
      } catch {
        errorEl.textContent = "Network error. Try again.";
        errorEl.style.display = "block";
        submit.textContent = "Connect";
        submit.disabled = false;
      }
    }

    // Focus first input
    inputs[0]?.focus();
    // Scroll card into view
    expandEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // --- Service-specific connect steps — written for total clarity ---
  const CONNECT_STEPS = {
    "github": [
      { title: `Scroll to the bottom and click the green "Generate token" button`, detail: `` },
      { title: "You'll see a code that starts with ghp_ — copy it right away", detail: "It disappears if you leave this page!" },
      { title: "Come back here, paste it in the box, and click Connect", detail: "" },
    ],
    "slack": [
      { title: `Click "Create New App", then pick "From scratch"`, detail: `Name it anything you want (like "Delt") and choose your workspace` },
      { title: `On the left side, click "OAuth & Permissions"`, detail: `` },
      { title: `Scroll down to "Bot Token Scopes" and add these three: channels:read, chat:write, users:read`, detail: `Just type each one and select it` },
      { title: `Scroll back up and click "Install to Workspace", then click Allow`, detail: `` },
      { title: "You'll see a token that starts with xoxb- — copy it and paste it here", detail: "" },
    ],
    "notion": [
      { title: `Click the "New integration" button`, detail: `` },
      { title: `Name it anything (like "Delt") and click Submit`, detail: `` },
      { title: `You'll see your secret key — click "Show" to reveal it`, detail: `It starts with secret_` },
      { title: "Copy it, paste it here, and click Connect", detail: "" },
    ],
    "linear": [
      { title: `Click "Create new API key"`, detail: `` },
      { title: `Name it anything (like "Delt") and click Create`, detail: `` },
      { title: "Copy the key right away — you won't be able to see it again!", detail: "" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "stripe": [
      { title: `Look for "Secret key" on this page`, detail: `` },
      { title: `Click "Reveal test key" to see it`, detail: `It starts with sk_test_ (or sk_live_ if you want to use your real account)` },
      { title: "Copy the key, paste it here, and click Connect", detail: "" },
    ],
    "shopify": [
      { title: `Click "Create an app" and name it "Delt"`, detail: `` },
      { title: `Click "Configure Admin API scopes"`, detail: `` },
      { title: "Check these boxes: read_products, write_products, read_orders — then click Save", detail: "" },
      { title: `Click "Install app" at the top of the page`, detail: `` },
      { title: "You'll see an access token — copy it right away (it only shows once!)", detail: "Paste it here and click Connect" },
    ],
    "hubspot": [
      { title: `Click "Create a private app"`, detail: `` },
      { title: `Name it "Delt", then click the "Scopes" tab at the top`, detail: `` },
      { title: "Search for and add: crm.objects.contacts.read and crm.objects.deals.read", detail: "Just type in the search box and check the boxes" },
      { title: `Click "Create app" and then "Continue creating"`, detail: `` },
      { title: "Copy the access token, paste it here, and click Connect", detail: "" },
    ],
    "trello": [
      { title: `Click "Create" to make a new Power-Up (use any name)`, detail: `` },
      { title: `On the left side, click "API key" and copy the key you see`, detail: `` },
      { title: `Next to the key, click the blue word "Token"`, detail: `` },
      { title: `Click "Allow" — then copy the long token that appears`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "figma": [
      { title: `Scroll down to "Personal access tokens"`, detail: `` },
      { title: `Click "Generate new token" and name it "Delt"`, detail: `` },
      { title: "Press Enter — then copy the token right away", detail: "It disappears if you leave this page!" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "airtable": [
      { title: `Click the blue "Create token" button (top right)`, detail: `` },
      { title: `Name it "Delt" — then add these scopes: data.records:read and data.records:write`, detail: `` },
      { title: `Under "Access", click "Add a base" and pick the ones you want Delt to use`, detail: `` },
      { title: `Click "Create token" and copy it right away (you only see it once!)`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "microsoft-365": [
      { title: `Click "New registration" — name it "Delt" — click Register`, detail: `` },
      { title: `Copy the "Application (client) ID" and paste it in the first box below`, detail: `` },
      { title: `Copy the "Directory (tenant) ID" and paste it in the second box`, detail: `` },
      { title: `Click "Certificates & secrets" on the left, then "New client secret", then Add`, detail: `Copy the Value (not the Secret ID!) and paste it in the third box` },
    ],
    "twilio": [
      { title: `At the top of the page, find "Account SID" and copy it`, detail: `It starts with AC` },
      { title: `Next to "Auth Token", click the eye icon to reveal it — then copy it`, detail: `` },
      { title: "Get your Twilio phone number ready too", detail: "Looks like +15551234567" },
      { title: "Paste all three into the boxes below and click Connect", detail: "" },
    ],
    "sendgrid": [
      { title: `Click "Create API Key"`, detail: `` },
      { title: `Name it "Delt" and choose "Restricted Access"`, detail: `` },
      { title: `Find "Mail Send" in the list and set it to "Full Access"`, detail: `` },
      { title: `Click "Create & View" — copy the key right away!`, detail: `SendGrid only shows this once — don't close the page yet` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "zoom": [
      { title: `Click "Create" and pick "Server-to-Server OAuth"`, detail: `` },
      { title: `Name it "Delt" and click Create`, detail: `` },
      { title: "You'll see three things on the same page: Account ID, Client ID, and Client Secret", detail: "Copy each one" },
      { title: "Paste all three into the boxes below and click Connect", detail: "" },
    ],
    "todoist": [
      { title: "Scroll down — you'll see your API token on this page", detail: "It's a long string of letters and numbers" },
      { title: "Copy it and paste it here", detail: "" },
      { title: "Click Connect — that's it!", detail: "" },
    ],
    "jira": [
      { title: `Click "Create API token"`, detail: `` },
      { title: `Name it "Delt" and click Create — copy the token right away!`, detail: `You won't be able to see it again` },
      { title: "Type in your Atlassian email address below", detail: "" },
      { title: "Type in your Jira domain (like yourcompany.atlassian.net)", detail: "" },
      { title: "Paste the token and click Connect", detail: "" },
    ],
    "asana": [
      { title: `Click "Create new token"`, detail: `` },
      { title: `Name it "Delt" and click Create token`, detail: `` },
      { title: "Copy the token, paste it here, and click Connect", detail: "" },
    ],
    "discord": [
      { title: `Click "New Application" — name it "Delt" — click Create`, detail: `` },
      { title: `On the left side, click "Bot" — then click "Add Bot" and confirm`, detail: `` },
      { title: `Click "Reset Token" and copy the new token`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "dropbox": [
      { title: `Click "Create app" — pick "Scoped access" then "Full Dropbox"`, detail: `` },
      { title: `Name it "Delt" and click Create app`, detail: `` },
      { title: `Click the "Permissions" tab — check files.content.read and files.content.write — then click Submit`, detail: `` },
      { title: `Go back to the "Settings" tab, scroll to "Generated access token", click Generate, and copy it`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "calendly": [
      { title: `Scroll down to "Personal access tokens"`, detail: `` },
      { title: `Click "Generate New Token" and name it "Delt"`, detail: `` },
      { title: "Click Create Token — then copy it", detail: "" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "intercom": [
      { title: `Click "New app" — name it "Delt" — click Create app`, detail: `` },
      { title: `On the left side, click "Authentication"`, detail: `` },
      { title: `Copy the "Access token" you see there`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "confluence": [
      { title: `Click "Create API token" and name it "Delt"`, detail: `` },
      { title: "Click Create — copy the token right away (you won't see it again!)", detail: "" },
      { title: "Type in your Atlassian email below", detail: "" },
      { title: "Type in your Confluence domain (like yourcompany.atlassian.net)", detail: "" },
      { title: "Paste the token and click Connect", detail: "" },
    ],
    "supabase": [
      { title: "You should see your project's API Settings page", detail: "" },
      { title: `Copy the "Project URL" (looks like https://abcdef.supabase.co)`, detail: `` },
      { title: `Scroll down to "Project API keys" and copy the "service_role" key`, detail: `Important: use service_role, not the anon key` },
      { title: "Paste both into the boxes below and click Connect", detail: "" },
    ],
    "vercel": [
      { title: `Click "Create Token"`, detail: `` },
      { title: `Name it "Delt" — leave everything else as-is`, detail: `` },
      { title: `Set expiration to "No Expiration" so it doesn't stop working later`, detail: `` },
      { title: "Click Create — copy the token", detail: "" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "postgres": [
      { title: "Find your database connection string", detail: "Check your database dashboard, or ask whoever set it up" },
      { title: "It looks something like: postgresql://user:password@host:5432/dbname", detail: "" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "zendesk": [
      { title: `Click "Add API token" and name it "Delt"`, detail: `` },
      { title: "Copy the token that appears (it only shows once!)", detail: "" },
      { title: "Type in your admin email address below", detail: "" },
      { title: "Type in your subdomain (like yourcompany.zendesk.com)", detail: "" },
      { title: "Paste the token and click Connect", detail: "" },
    ],
    "clickup": [
      { title: `Click "Generate" to create a new token`, detail: `` },
      { title: "Copy the token that appears", detail: "" },
      { title: "Paste it here and click Connect", detail: "" },
    ],
    "monday": [
      { title: `Scroll down to find "API v2 Token"`, detail: `` },
      { title: `Click "Generate" and copy the token`, detail: `` },
      { title: "Paste it here and click Connect", detail: "" },
    ],
  };

  // --- Floating guide panel (shown while a help popup is open) ---
  function showFloatingGuide(integrationId, serviceName) {
    const steps = CONNECT_STEPS[integrationId] || [
      { title: "Follow the instructions on the page that opened", detail: "It'll walk you through creating a key or token" },
      { title: "When you see your key or token, copy it", detail: "Select it and press Ctrl+C (or Cmd+C on Mac)" },
      { title: "Come back here, paste it in the box, and click Connect", detail: "" },
    ];
    // Remove any existing guide
    document.querySelectorAll(".connect-guide-backdrop").forEach(el => el.remove());
    document.querySelectorAll(".connect-guide-panel").forEach(el => el.remove());

    // Backdrop so it's unmissable
    const backdrop = document.createElement("div");
    backdrop.className = "connect-guide-backdrop";
    document.body.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "connect-guide-panel";
    panel.innerHTML = `
      <div class="connect-guide-header">
        <span class="connect-guide-title">How to connect ${escapeHtml(serviceName)}</span>
        <button class="connect-guide-dismiss" title="Got it">&times;</button>
      </div>
      <div class="connect-guide-steps">
        ${steps.map((s, i) => `
          <div class="connect-guide-step">
            <span class="connect-guide-step-num">${i + 1}</span>
            <div>
              <strong>${escapeHtml(s.title)}</strong>
              ${s.detail ? `<span class="connect-guide-detail">${escapeHtml(s.detail)}</span>` : ""}
            </div>
          </div>`).join("")}
      </div>
      <div class="connect-guide-footer">Follow these steps, then come back here to paste your key.</div>
    `;
    function dismiss() { backdrop.remove(); panel.remove(); }
    panel.querySelector(".connect-guide-dismiss").onclick = dismiss;
    backdrop.addEventListener("click", dismiss);
    document.body.appendChild(panel);
    return { close: dismiss };
  }

  // --- Inline OAuth steps (shown inside card expand area before sign-in) ---
  async function showOAuthInlineSteps(integrationId, cardEl) {
    const expandEl = document.getElementById(`cc-expand-${integrationId}`);
    if (!expandEl) { startOAuthFlow(integrationId); return; }

    // Toggle off if already open
    if (expandEl.classList.contains("open")) {
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
      return;
    }

    // Fetch setup steps from integration data
    const intData = await fetch("/integrations").then(r => r.json()).catch(() => ({ integrations: [] }));
    const integration = (intData.integrations || []).find(i => i.id === integrationId);
    const steps = integration?.setupSteps || [];

    const stepsHtml = steps.length
      ? `<ol class="cc-oauth-steps">${steps.map(s => `<li>${s}</li>`).join("")}</ol>`
      : `<p class="cc-oauth-steps-note">A sign-in window will open. If you see a warning, don't worry — just click <strong>Advanced</strong> (small text at the bottom), then <strong>Go to Delt (unsafe)</strong>. It's safe — "unsafe" just means the app is new.</p>`;

    expandEl.innerHTML = `
      <div class="cc-inline-connect">
        <div class="cc-oauth-info">
          <div class="cc-oauth-info-title">Before you sign in</div>
          ${stepsHtml}
        </div>
        <div class="cc-inline-actions" style="margin-top:12px">
          <button class="cc-inline-submit cc-oauth-go-btn">Continue to Sign in</button>
          <button class="cc-inline-cancel">Cancel</button>
        </div>
      </div>`;
    expandEl.classList.add("open");
    expandEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

    expandEl.querySelector(".cc-inline-cancel").onclick = () => {
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
    };
    expandEl.querySelector(".cc-oauth-go-btn").onclick = () => {
      expandEl.classList.remove("open");
      expandEl.innerHTML = "";
      startOAuthFlow(integrationId);
    };
  }

  // OAuth flow — open popup + poll fallback for PWA/desktop
  // Unverified OAuth apps that need the "Advanced" bypass guidance
  const UNVERIFIED_OAUTH_IDS = new Set(["google-workspace"]);

  async function startOAuthFlow(integrationId) {
    try {
      const res = await fetch(`/integrations/${integrationId}/auth-url`);
      const data = await res.json();
      if (!data.url) {
        alert(data.error || "OAuth not available for this service yet.");
        return;
      }

      // For unverified OAuth apps, show guidance before opening the popup
      if (UNVERIFIED_OAUTH_IDS.has(integrationId)) {
        showOAuthGuidance(integrationId, data.url);
      } else {
        openOAuthPopup(integrationId, data.url);
      }
    } catch {
      alert("Failed to start authentication.");
    }
  }

  function showOAuthGuidance(integrationId, authUrl) {
    // Remove any existing guidance overlay
    document.querySelectorAll(".oauth-guidance-overlay").forEach((el) => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "oauth-guidance-overlay";
    overlay.innerHTML = `
      <div class="oauth-guidance-card">
        <div class="oauth-guidance-header">
          <span style="font-size:20px;">&#x1f512;</span>
          <h3>Quick heads-up before you sign in</h3>
        </div>
        <p class="oauth-guidance-subtitle">Google will show a scary-looking warning — don't worry! Delt is new so Google hasn't reviewed it yet. Your data never leaves your computer.</p>
        <div class="oauth-guidance-steps">
          <div class="oauth-guidance-step">
            <span class="oauth-guidance-step-num">1</span>
            <div>
              <strong>Pick your Google account</strong>
              <span class="oauth-guidance-step-detail">Choose the one you want to connect to Delt</span>
            </div>
          </div>
          <div class="oauth-guidance-step">
            <span class="oauth-guidance-step-num">2</span>
            <div>
              <strong>Click the small "Advanced" text at the bottom left</strong>
              <span class="oauth-guidance-step-detail">It's easy to miss — look near the bottom of the warning page</span>
            </div>
          </div>
          <div class="oauth-guidance-step">
            <span class="oauth-guidance-step-num">3</span>
            <div>
              <strong>Click "Go to Delt (unsafe)"</strong>
              <span class="oauth-guidance-step-detail">It says "unsafe" but that just means Google hasn't checked the app yet — totally safe</span>
            </div>
          </div>
          <div class="oauth-guidance-step">
            <span class="oauth-guidance-step-num">4</span>
            <div>
              <strong>Click "Continue" to allow access</strong>
              <span class="oauth-guidance-step-detail">This lets Delt read your email, calendar, and sheets so it can help you</span>
            </div>
          </div>
        </div>
        <div class="oauth-guidance-actions">
          <button class="oauth-guidance-continue">Got it — open Google Sign-in</button>
          <button class="oauth-guidance-cancel">Cancel</button>
        </div>
        <p class="oauth-guidance-footer">Everything stays on your computer. Your login info is encrypted and stored locally in <code>~/.delt/</code></p>
      </div>
    `;

    overlay.querySelector(".oauth-guidance-cancel").onclick = () => overlay.remove();
    overlay.querySelector(".oauth-guidance-continue").onclick = () => {
      // Collapse overlay to compact floating card so steps stay visible during sign-in
      overlay.classList.add("oauth-guidance-collapsed");
      overlay.querySelector(".oauth-guidance-actions").remove();
      overlay.querySelector(".oauth-guidance-footer").remove();
      overlay.querySelector(".oauth-guidance-subtitle").remove();
      const hdr = overlay.querySelector(".oauth-guidance-header");
      if (hdr) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "oauth-guidance-dismiss";
        closeBtn.textContent = "\u2715";
        closeBtn.onclick = () => overlay.remove();
        hdr.appendChild(closeBtn);
      }
      overlay.removeEventListener("click", clickOutside);
      openOAuthPopup(integrationId, authUrl);
    };
    function clickOutside(e) {
      if (e.target === overlay) overlay.remove();
    }
    overlay.addEventListener("click", clickOutside);

    document.body.appendChild(overlay);
  }

  function openOAuthPopup(integrationId, authUrl) {
    const popW = Math.min(520, Math.round(screen.width * 0.45));
    const popH = Math.round(screen.height * 0.85);
    const popup = window.open(authUrl, "oauth", `width=${popW},height=${popH},left=0,top=0,resizable=yes,scrollbars=yes`);

    // If popup was blocked, open in current tab as fallback
    if (!popup || popup.closed) {
      window.location.href = authUrl;
      return;
    }

    let resolved = false;
    function done() {
      if (resolved) return;
      resolved = true;
      document.querySelectorAll(".oauth-waiting-indicator").forEach((el) => el.remove());
      document.querySelectorAll(".oauth-guidance-overlay").forEach((el) => el.remove());
      document.querySelectorAll(".connect-guide-panel").forEach((el) => el.remove());
      loadIntegrations();
    }

    // Show a subtle waiting indicator in the main window
    showOAuthWaitingIndicator();

    function closePopup() {
      try { if (popup && !popup.closed) popup.close(); } catch {}
    }

    // Method 1: postMessage from popup (works in regular browser)
    window.addEventListener("message", function handler(e) {
      if (e.data?.type === "oauth-complete" && e.data?.integrationId === integrationId) {
        window.removeEventListener("message", handler);
        closePopup();
        done();
      }
    });

    // Method 2: poll server for connection status (works in PWA/desktop where window.opener is null)
    let attempts = 0;
    const poll = setInterval(async () => {
      if (resolved) { clearInterval(poll); return; }
      attempts++;
      try {
        const check = await fetch("/integrations");
        const status = await check.json();
        const integration = (status.integrations || []).find((i) => i.id === integrationId);
        if (integration && integration.connected) {
          clearInterval(poll);
          closePopup();
          done();
        }
      } catch {}
      if (attempts > 120) { // 2 min timeout
        clearInterval(poll);
        document.querySelectorAll(".oauth-waiting-indicator").forEach((el) => el.remove());
      }
    }, 2000);
  }

  function showOAuthWaitingIndicator() {
    document.querySelectorAll(".oauth-waiting-indicator").forEach((el) => el.remove());
    const indicator = document.createElement("div");
    indicator.className = "oauth-waiting-indicator";
    indicator.innerHTML = `
      <div class="oauth-waiting-content">
        <div class="oauth-waiting-dot"></div>
        <span>Waiting for Google sign-in to complete...</span>
      </div>
      <span class="oauth-waiting-hint">Remember: click <strong>Advanced</strong> → <strong>Go to Delt (unsafe)</strong> if you see a warning</span>
      <button class="oauth-waiting-dismiss" title="Dismiss">&times;</button>
    `;
    indicator.querySelector(".oauth-waiting-dismiss").onclick = () => indicator.remove();
    document.body.appendChild(indicator);
  }


  // "Requires setup" message for OAuth services without credentials
  function showSetupRequiredMessage(integrationId, cardEl, integration) {
    const existing = document.querySelector(".connect-modal-overlay");
    if (existing) existing.remove();
    const icon = INTEGRATION_ICONS[integration.icon] || integration.name.charAt(0);
    const overlay = document.createElement("div");
    overlay.className = "connect-modal-overlay";
    overlay.innerHTML = `
      <div class="connect-modal-card" style="text-align:center;">
        <button class="connect-modal-close" title="Close">&times;</button>
        <div class="connect-modal-header">
          <div class="connect-modal-icon">${icon}</div>
          <div class="connect-modal-name">${escapeHtml(integration.name)}</div>
        </div>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin:16px 0 0;">
          ${escapeHtml(integration.name)} sign-in is being set up. Once it's ready, you'll just click <strong>Sign in</strong> and you're connected — no keys or setup needed.
        </p>
        <p style="color:var(--text-faint);font-size:12px;margin-top:12px;">
          If you're the admin, set the OAuth credentials via environment variables to enable this.
        </p>
      </div>
    `;
    overlay.querySelector(".connect-modal-close").onclick = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // Token wizard — full-screen modal for connecting integrations
  function showTokenWizard(integrationId, cardEl) {
    // Remove any existing modal
    const existing = document.querySelector(".connect-modal-overlay");
    if (existing) existing.remove();

    fetch("/integrations").then((r) => r.json()).then((data) => {
      const integration = (data.integrations || []).find((i) => i.id === integrationId);
      if (!integration) return;

      const tc = integration.tokenConfig || {};
      const icon = INTEGRATION_ICONS[integration.icon] || integration.name.charAt(0);
      const hasFields = tc.fields && tc.fields.length > 0;

      // Build labeled inputs with show/hide toggles
      const inputsHtml = hasFields
        ? tc.fields.map((f) => `
          <div class="connect-field">
            <label class="connect-field-label">${escapeHtml(f.label)}</label>
            <div class="connect-field-wrap">
              <input class="connect-field-input" data-key="${escapeHtml(f.key)}" type="password" placeholder="${escapeHtml(f.placeholder || '')}" autocomplete="off" spellcheck="false">
              <button type="button" class="connect-field-toggle" tabindex="-1">Show</button>
            </div>
          </div>`).join("")
        : `
          <div class="connect-field">
            <label class="connect-field-label">${escapeHtml(tc.label || "API Key")}</label>
            <div class="connect-field-wrap">
              <input class="connect-field-input" type="password" placeholder="${escapeHtml(tc.placeholder || 'Paste your token here')}" autocomplete="off" spellcheck="false">
              <button type="button" class="connect-field-toggle" tabindex="-1">Show</button>
            </div>
          </div>`;

      // Simple prompt — browser already opened to the right page
      const helpUrl = tc.helpUrl;
      const promptText = helpUrl
        ? `A browser tab opened to <strong>${escapeHtml(integration.name)}</strong>. Create your token there, then paste it here.`
        : `Paste your <strong>${escapeHtml(integration.name)}</strong> token below.`;

      const overlay = document.createElement("div");
      overlay.className = "connect-modal-overlay";
      overlay.innerHTML = `
        <div class="connect-modal-card">
          <button class="connect-modal-close" title="Close">&times;</button>
          <div class="connect-modal-header">
            <div class="connect-modal-icon">${icon}</div>
            <div class="connect-modal-name">${escapeHtml(integration.name)}</div>
          </div>
          <p class="connect-modal-prompt">${promptText}</p>
          ${helpUrl ? `<a class="connect-modal-reopen" href="${escapeHtml(helpUrl)}" target="_blank">Didn't open? Click here.</a>` : ""}
          <div class="connect-modal-fields">
            ${inputsHtml}
          </div>
          <button class="connect-modal-submit" disabled>Connect</button>
          <div class="connect-modal-error" style="display:none"></div>
        </div>
      `;

      // Close handlers
      overlay.querySelector(".connect-modal-close").onclick = () => overlay.remove();
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

      // Show/hide toggle
      overlay.querySelectorAll(".connect-field-toggle").forEach((btn) => {
        btn.onclick = () => {
          const inp = btn.parentElement.querySelector("input");
          if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
          else { inp.type = "password"; btn.textContent = "Show"; }
        };
      });

      const inputs = overlay.querySelectorAll(".connect-field-input");
      const submit = overlay.querySelector(".connect-modal-submit");
      const errorEl = overlay.querySelector(".connect-modal-error");

      function checkAllFilled() {
        submit.disabled = ![...inputs].every((inp) => inp.value.trim());
      }
      inputs.forEach((inp) => {
        inp.addEventListener("input", () => { errorEl.style.display = "none"; checkAllFilled(); });
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !submit.disabled) doConnect();
        });
      });
      submit.addEventListener("click", doConnect);

      async function doConnect() {
        submit.disabled = true;
        submit.textContent = "Connecting...";
        errorEl.style.display = "none";
        let body;
        if (hasFields) {
          const fields = {};
          inputs.forEach((inp) => { fields[inp.dataset.key] = inp.value.trim(); });
          body = { fields };
        } else {
          body = { token: inputs[0].value.trim() };
        }
        try {
          const res = await fetch(`/integrations/${integrationId}/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const result = await res.json();
          if (result.ok) {
            submit.textContent = "Connected";
            submit.style.background = "#10b981";
            setTimeout(() => { overlay.remove(); loadIntegrations(); }, 800);
          } else {
            errorEl.textContent = result.error || "Connection failed. Check your credentials.";
            errorEl.style.display = "block";
            submit.textContent = "Connect";
            submit.disabled = false;
          }
        } catch {
          errorEl.textContent = "Network error. Try again.";
          errorEl.style.display = "block";
          submit.textContent = "Connect";
          submit.disabled = false;
        }
      }

      document.body.appendChild(overlay);
      inputs[0].focus();
    });
  }

  function showLocalAccessWizard(integrationId, cardEl) {
    const existingWizard = cardEl.querySelector(".local-access-panel");
    if (existingWizard) { existingWizard.remove(); return; }

    fetch("/integrations").then((r) => r.json()).then((data) => {
      const integration = (data.integrations || []).find((i) => i.id === integrationId);
      if (!integration) return;

      const currentLevel = integration.accessLevel || "none";
      const currentDirs = (integration.directories || []).join("\n");

      const panel = document.createElement("div");
      panel.className = "local-access-panel";
      panel.innerHTML = `
        <div class="local-access-options">
          <button class="local-access-btn${currentLevel === "none" ? " active" : ""}" data-level="none">
            <div class="local-access-btn-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            </div>
            <div class="local-access-btn-text">
              <strong>No Access</strong>
              <span>Cannot read or write any files on this computer</span>
            </div>
          </button>
          <button class="local-access-btn${currentLevel === "limited" ? " active" : ""}" data-level="limited">
            <div class="local-access-btn-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <div class="local-access-btn-text">
              <strong>Limited Access</strong>
              <span>Only folders you approve — you choose exactly what's accessible</span>
            </div>
          </button>
          <button class="local-access-btn${currentLevel === "full" ? " active" : ""}" data-level="full">
            <div class="local-access-btn-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div class="local-access-btn-text">
              <strong>Full Access</strong>
              <span>Unrestricted access to all files in your home directory</span>
            </div>
          </button>
        </div>
        <div class="local-access-dirs" style="display:${currentLevel === "limited" ? "block" : "none"}">
          <label class="local-access-dirs-label">Allowed folders <span style="color:var(--text-faint)">(one per line)</span></label>
          <textarea class="local-access-dirs-input" rows="3" placeholder="/Users/you/Documents&#10;/Users/you/Projects">${escapeHtml(currentDirs)}</textarea>
          <button class="local-access-dirs-save">Save folders</button>
        </div>
      `;

      const btns = panel.querySelectorAll(".local-access-btn");
      const dirsSection = panel.querySelector(".local-access-dirs");
      const dirsInput = panel.querySelector(".local-access-dirs-input");
      const dirsSave = panel.querySelector(".local-access-dirs-save");

      async function setLevel(level, directories) {
        try {
          await fetch(`/integrations/${integrationId}/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level, directories: directories || [] }),
          });
          loadIntegrations();
        } catch {}
      }

      btns.forEach((btn) => btn.addEventListener("click", () => {
        const level = btn.dataset.level;
        btns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        if (level === "limited") {
          dirsSection.style.display = "block";
          dirsInput.focus();
        } else {
          dirsSection.style.display = "none";
          setLevel(level);
        }
      }));

      dirsSave.addEventListener("click", () => {
        const dirs = dirsInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!dirs.length) { dirsInput.focus(); return; }
        dirsSave.textContent = "Saving...";
        dirsSave.disabled = true;
        setLevel("limited", dirs);
      });

      cardEl.appendChild(panel);
    });
  }

  // --- Onboarding (first-time setup) ---
  const onboardingEl = document.getElementById("onboarding");
  const setupName = document.getElementById("setup-name");
  const setupBot = document.getElementById("setup-bot");
  const setupGo = document.getElementById("setup-go");

  function checkOnboarding() {
    if (!config?.business?.setupComplete) {
      showOnboarding();
    }
  }

  function showOnboarding() {
    if (!onboardingEl) return;
    onboardingEl.classList.remove("hidden");
    welcome.classList.add("hidden");
    if (setupName) setupName.focus();
  }

  function hideOnboarding() {
    if (onboardingEl) onboardingEl.classList.add("hidden");
    welcome.classList.remove("hidden");
    input.focus();
  }

  function updateSetupBtn() {
    if (!setupGo || !setupName || !setupBot) return;
    setupGo.disabled = !setupName.value.trim() || !setupBot.value.trim();
  }

  if (setupName) setupName.addEventListener("input", updateSetupBtn);
  if (setupBot) setupBot.addEventListener("input", updateSetupBtn);

  // Enter key on inputs moves forward / submits
  if (setupName) setupName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); setupBot.focus(); }
  });
  if (setupBot) setupBot.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !setupGo.disabled) { e.preventDefault(); submitSetup(); }
  });

  if (setupGo) setupGo.addEventListener("click", submitSetup);

  async function submitSetup() {
    const ownerName = setupName.value.trim();
    const botName = setupBot.value.trim();
    if (!ownerName || !botName) return;

    setupGo.disabled = true;
    setupGo.textContent = "Setting up...";

    try {
      const res = await fetch("/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerName, botName }),
      });
      const data = await res.json();
      if (data.ok && data.config) {
        config = data.config;
        applyConfig();
        hideOnboarding();
      } else {
        setupGo.textContent = "Something went wrong. Try again.";
        setupGo.disabled = false;
      }
    } catch {
      setupGo.textContent = "Connection failed. Try again.";
      setupGo.disabled = false;
    }
  }

  // ============================================
  // Voice Input — Web Speech API
  // Privacy-first, WhisperFlow-inspired
  // ============================================
  const micBtn = document.getElementById("mic-btn");
  const micIconIdle = micBtn?.querySelector(".mic-icon-idle");
  const micIconActive = micBtn?.querySelector(".mic-icon-active");
  const micConsentOverlay = document.getElementById("mic-consent-overlay");
  const micConsentAllow = document.getElementById("mic-consent-allow");
  const micConsentDeny = document.getElementById("mic-consent-deny");

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let micBadgeEl = null;
  let micTimerInterval = null;
  let micSecondsLeft = 0;
  const MIC_MAX_SECONDS = 60;
  const MIC_CONSENT_KEY = "delt-mic-consent";

  function initSpeech() {
    if (!SpeechRecognition || !micBtn) return;

    // Show the mic button — browser supports speech recognition
    micBtn.classList.remove("hidden");

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;

    // Track pre-existing text and committed speech
    let preExistingText = "";
    let committedTranscript = "";

    recognition.onstart = () => {
      micListening = true;
      micBtn.classList.add("listening");
      if (micIconIdle) micIconIdle.classList.add("hidden");
      if (micIconActive) micIconActive.classList.remove("hidden");
      micBtn.title = "Click to stop listening";

      preExistingText = input.value;
      committedTranscript = "";

      // Show the listening badge with shield + countdown
      showMicBadge();
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }

      if (finalText) {
        committedTranscript += (committedTranscript ? " " : "") + finalText.trim();
      }

      const separator = preExistingText && (committedTranscript || interim) ? " " : "";
      const interimSeparator = committedTranscript && interim ? " " : "";
      input.value = preExistingText + separator + committedTranscript + interimSeparator + interim;
      autoResize();
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        stopMic(true);
        return;
      }
      if (event.error === "not-allowed") {
        // User denied — hide mic, clear consent so they get the card again if they re-enable
        localStorage.removeItem(MIC_CONSENT_KEY);
        micBtn.classList.add("hidden");
        stopMic(false);
        return;
      }
      stopMic(true);
    };

    recognition.onend = () => {
      stopMic(true);
    };

    micBtn.addEventListener("click", handleMicClick);
  }

  // --- First-use consent flow ---
  function handleMicClick() {
    if (micListening) {
      recognition.stop();
      return;
    }

    // Check if user has already consented
    if (localStorage.getItem(MIC_CONSENT_KEY) === "granted") {
      startMic();
      return;
    }

    // Show consent card
    if (micConsentOverlay) micConsentOverlay.classList.remove("hidden");
  }

  if (micConsentAllow) {
    micConsentAllow.addEventListener("click", () => {
      localStorage.setItem(MIC_CONSENT_KEY, "granted");
      if (micConsentOverlay) micConsentOverlay.classList.add("hidden");
      startMic();
    });
  }

  if (micConsentDeny) {
    micConsentDeny.addEventListener("click", () => {
      localStorage.setItem(MIC_CONSENT_KEY, "denied");
      if (micConsentOverlay) micConsentOverlay.classList.add("hidden");
      // Hide the mic button entirely — user said no
      if (micBtn) micBtn.classList.add("hidden");
    });
  }

  // Close consent on overlay click (treat as dismiss, not deny)
  if (micConsentOverlay) {
    micConsentOverlay.addEventListener("click", (e) => {
      if (e.target === micConsentOverlay) {
        micConsentOverlay.classList.add("hidden");
      }
    });
  }

  function startMic() {
    if (!recognition || micListening) return;
    try {
      recognition.start();
    } catch (e) {
      // Already started
    }
  }

  // --- Listening badge with shield + countdown ---
  function showMicBadge() {
    removeMicBadge();
    micSecondsLeft = MIC_MAX_SECONDS;

    micBadgeEl = document.createElement("div");
    micBadgeEl.className = "mic-listening-badge";
    micBadgeEl.innerHTML = `
      <span class="mic-badge-shield">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
      </span>
      <span>Not recorded</span>
      <span class="mic-badge-sep"></span>
      <span class="mic-badge-timer">${micSecondsLeft}s</span>
    `;
    micBtn.appendChild(micBadgeEl);

    const timerEl = micBadgeEl.querySelector(".mic-badge-timer");
    micTimerInterval = setInterval(() => {
      micSecondsLeft--;
      if (timerEl) timerEl.textContent = micSecondsLeft + "s";
      if (micSecondsLeft <= 0) {
        // Auto-stop — safety cutoff
        if (recognition && micListening) recognition.stop();
      }
    }, 1000);
  }

  function removeMicBadge() {
    if (micTimerInterval) { clearInterval(micTimerInterval); micTimerInterval = null; }
    if (micBadgeEl) { micBadgeEl.remove(); micBadgeEl = null; }
  }

  // --- Stop mic with optional "Mic off" toast ---
  function stopMic(showToast) {
    const wasListening = micListening;
    micListening = false;

    if (micBtn) {
      micBtn.classList.remove("listening");
      micBtn.title = "Voice input \u2014 audio stays in your browser";
    }
    if (micIconIdle) micIconIdle.classList.remove("hidden");
    if (micIconActive) micIconActive.classList.add("hidden");

    removeMicBadge();
    updateSendBtn();
    input.focus();

    // Show "Mic off" confirmation toast
    if (showToast && wasListening) {
      showMicOffToast();
    }
  }

  function showMicOffToast() {
    const existing = document.querySelector(".mic-off-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "mic-off-toast";
    toast.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      Mic off \u2014 nothing was recorded
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("fade-out");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ============================================
  // Phone QR Handoff
  // ============================================
  const phoneToggle = document.getElementById("phone-toggle");
  const qrModalOverlay = document.getElementById("qr-modal-overlay");
  const qrModal = document.getElementById("qr-modal");
  const qrModalClose = document.getElementById("qr-modal-close");
  const qrImage = document.getElementById("qr-image");
  const qrLoading = document.getElementById("qr-loading");
  const qrStatusText = document.getElementById("qr-status-text");
  const qrUrlRow = document.getElementById("qr-url-row");
  const qrUrlInput = document.getElementById("qr-url-input");
  const qrUrlCopy = document.getElementById("qr-url-copy");
  const qrStopBtn = document.getElementById("qr-stop-btn");

  let qrTunnelRunning = false;

  function openQrModal() {
    if (!qrModalOverlay) return;
    qrModalOverlay.classList.remove("hidden");
    // Check if tunnel already running
    fetchMobileStatus().then((status) => {
      if (status && status.running) {
        // Tunnel already running — refresh with new token
        startMobileTunnel();
      } else {
        startMobileTunnel();
      }
    });
  }

  function closeQrModal() {
    if (qrModalOverlay) qrModalOverlay.classList.add("hidden");
  }

  async function fetchMobileStatus() {
    try {
      const res = await fetch("/mobile/status");
      return await res.json();
    } catch {
      return null;
    }
  }

  async function startMobileTunnel() {
    // Reset UI
    if (qrLoading) qrLoading.classList.remove("hidden");
    if (qrImage) qrImage.classList.add("hidden");
    if (qrUrlRow) qrUrlRow.classList.add("hidden");
    if (qrStopBtn) qrStopBtn.classList.add("hidden");
    if (qrStatusText) qrStatusText.textContent = "Starting secure tunnel...";

    try {
      const res = await fetch("/mobile/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId || null }),
      });
      const data = await res.json();

      if (data.error) {
        if (qrLoading) qrLoading.classList.add("hidden");
        if (qrStatusText) qrStatusText.textContent = data.error;
        return;
      }

      qrTunnelRunning = true;

      // Show QR code
      if (qrImage) {
        qrImage.src = data.qrImage;
        qrImage.classList.remove("hidden");
      }
      if (qrLoading) qrLoading.classList.add("hidden");
      if (qrStatusText) {
        qrStatusText.textContent = data.mode === "lan"
          ? "Scan with your phone (same WiFi network)"
          : "Scan with your phone camera";
      }
      if (qrUrlRow) qrUrlRow.classList.remove("hidden");
      if (qrUrlInput) qrUrlInput.value = data.qrData;
      if (qrStopBtn && data.mode !== "lan") qrStopBtn.classList.remove("hidden");
    } catch (err) {
      if (qrLoading) qrLoading.classList.add("hidden");
      if (qrStatusText) qrStatusText.textContent = "Failed to start tunnel. Is cloudflared installed?";
    }
  }

  async function stopMobileTunnel() {
    try {
      await fetch("/mobile/stop", { method: "POST" });
    } catch {}
    qrTunnelRunning = false;
    closeQrModal();
  }

  if (phoneToggle) phoneToggle.addEventListener("click", openQrModal);
  if (qrModalClose) qrModalClose.addEventListener("click", closeQrModal);
  if (qrStopBtn) qrStopBtn.addEventListener("click", stopMobileTunnel);

  // Close modal on overlay click
  if (qrModalOverlay) {
    qrModalOverlay.addEventListener("click", (e) => {
      if (e.target === qrModalOverlay) closeQrModal();
    });
  }

  // Copy URL button
  if (qrUrlCopy) {
    qrUrlCopy.addEventListener("click", () => {
      if (qrUrlInput) {
        navigator.clipboard.writeText(qrUrlInput.value);
        qrUrlCopy.textContent = "Copied!";
        setTimeout(() => (qrUrlCopy.textContent = "Copy"), 1500);
      }
    });
  }

  // Register service worker for PWA (auto-update logic is in index.html <head>)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // ============================================
  // PWA Install Prompt
  // ============================================
  let deferredInstallPrompt = null;
  const PWA_DISMISS_KEY = "delt-pwa-dismissed";

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    // Don't show if user dismissed recently (7 days)
    const dismissed = localStorage.getItem(PWA_DISMISS_KEY);
    if (dismissed && Date.now() - parseInt(dismissed) < 7 * 86400000) return;
    // Don't show if already in standalone mode
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    showInstallBanner();
  });

  function showInstallBanner() {
    if (document.getElementById("pwa-install-banner")) return;
    const banner = document.createElement("div");
    banner.id = "pwa-install-banner";
    banner.innerHTML = `
      <div class="pwa-banner-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
      <div class="pwa-banner-text">
        <strong>Install Delt</strong>
        <span>Get a desktop app — faster, no browser chrome</span>
      </div>
      <button class="pwa-banner-install" id="pwa-install-btn">Install</button>
      <button class="pwa-banner-close" id="pwa-dismiss-btn">&times;</button>
    `;
    document.body.appendChild(banner);
    // Animate in
    requestAnimationFrame(() => banner.classList.add("visible"));

    document.getElementById("pwa-install-btn").addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      if (result.outcome === "accepted") {
        banner.classList.remove("visible");
        setTimeout(() => banner.remove(), 300);
      }
      deferredInstallPrompt = null;
    });

    document.getElementById("pwa-dismiss-btn").addEventListener("click", () => {
      localStorage.setItem(PWA_DISMISS_KEY, Date.now().toString());
      banner.classList.remove("visible");
      setTimeout(() => banner.remove(), 300);
    });
  }

  // Badge API — show unread count on app icon
  let unreadCount = 0;

  function incrementBadge() {
    if (document.visibilityState === "visible") return;
    unreadCount++;
    if ("setAppBadge" in navigator) {
      navigator.setAppBadge(unreadCount).catch(() => {});
    }
  }

  function clearBadge() {
    unreadCount = 0;
    if ("clearAppBadge" in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") clearBadge();
  });

  // ============================================
  // Onboarding — first-time setup
  // ============================================
  const installGate = document.getElementById("install-gate");
  const appEl = document.getElementById("app");

  const obWelcome = document.getElementById("ob-welcome");
  const obAccount = document.getElementById("ob-account");
  const obSignin = document.getElementById("ob-signin");
  const obReady = document.getElementById("ob-ready");

  const obInstallBar = document.getElementById("ob-install-bar");
  const obInstallFill = document.getElementById("ob-install-fill");
  const obInstallLabel = document.getElementById("ob-install-label");
  const obAuthDot = document.getElementById("ob-auth-dot");
  const obAuthText = document.getElementById("ob-auth-text");

  let installPollTimer = null;
  let authPollTimer = null;

  function showObStep(step) {
    [obWelcome, obAccount, obSignin, obReady].forEach(s => {
      if (s) s.classList.add("hidden");
    });
    if (step) step.classList.remove("hidden");
  }

  async function checkClaude() {
    try {
      const res = await fetch("/health");
      return await res.json();
    } catch {
      return { installed: false, version: null, authed: false };
    }
  }

  // Silent install — runs npm in background on server
  async function startSilentInstall() {
    try {
      const res = await fetch("/install-silent", { method: "POST" });
      const data = await res.json();
      if (data.error === "node_required") {
        if (obInstallLabel) obInstallLabel.innerHTML = 'Node.js required — <a href="https://nodejs.org" target="_blank" style="color:#3B82F6">install it</a>, then refresh';
        if (obInstallBar) obInstallBar.classList.add("error");
        return;
      }
      if (obInstallFill) obInstallFill.classList.add("indeterminate");
      pollInstallStatus();
    } catch {
      if (obInstallLabel) obInstallLabel.textContent = "Could not reach server — try refreshing";
      if (obInstallBar) obInstallBar.classList.add("error");
    }
  }

  window.retryInstall = retryInstall;
  function retryInstall() {
    if (obInstallBar) obInstallBar.classList.remove("error");
    if (obInstallFill) obInstallFill.classList.remove("indeterminate");
    if (obInstallLabel) obInstallLabel.textContent = "Retrying...";
    // Reset server state
    fetch("/install-silent", { method: "POST" }).then(() => {
      if (obInstallFill) obInstallFill.classList.add("indeterminate");
      pollInstallStatus();
    }).catch(() => {
      if (obInstallLabel) obInstallLabel.textContent = "Could not reach server";
    });
  }

  function pollInstallStatus() {
    if (installPollTimer) clearInterval(installPollTimer);
    installPollTimer = setInterval(async () => {
      try {
        const res = await fetch("/install-status");
        const data = await res.json();
        if (data.status === "installed") {
          clearInterval(installPollTimer);
          if (obInstallFill) obInstallFill.classList.remove("indeterminate");
          if (obInstallBar) obInstallBar.classList.add("done");
          if (obInstallLabel) obInstallLabel.textContent = "Engine installed — ready to connect";
        } else if (data.status === "failed") {
          clearInterval(installPollTimer);
          if (obInstallFill) obInstallFill.classList.remove("indeterminate");
          if (obInstallBar) obInstallBar.classList.add("error");
          if (obInstallLabel) obInstallLabel.innerHTML = 'Install failed — <button onclick="retryInstall()" style="background:none;border:none;color:#3B82F6;cursor:pointer;text-decoration:underline;font:inherit">try again</button>';
        }
      } catch {}
    }, 2000);
  }

  async function checkAuthNow() {
    if (!authPollActive) return;
    try {
      const res = await fetch("/verify-auth", { method: "POST" });
      const data = await res.json();
      if (data.authed) {
        clearInterval(authPollTimer);
        authPollActive = false;
        if (obAuthDot) obAuthDot.className = "ob-auth-dot ok";
        if (obAuthText) obAuthText.textContent = "Connected!";
        setTimeout(() => showObStep(obReady), 800);
      }
    } catch {}
  }

  let authPollActive = false;

  function startAuthPoll() {
    authPollActive = true;
    if (authPollTimer) clearInterval(authPollTimer);
    authPollTimer = setInterval(checkAuthNow, 5000);
  }

  // Instant check the moment the user returns to this window after signing in
  function onWindowRefocus() {
    if (authPollActive) checkAuthNow();
  }
  window.addEventListener("focus", onWindowRefocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onWindowRefocus();
  });

  async function advanceToSignin() {
    const health = await checkClaude();
    if (health.installed && health.authed) {
      showObStep(obReady);
      return;
    }
    if (health.installed) {
      showObStep(obSignin);
      startAuthPoll();
      return;
    }
    // Not installed yet — wait for install
    if (obInstallLabel) obInstallLabel.textContent = "Almost ready...";
    const waitTimer = setInterval(async () => {
      try {
        const s = await fetch("/install-status").then(r => r.json());
        if (s.status === "installed") {
          clearInterval(waitTimer);
          showObStep(obSignin);
          startAuthPoll();
        } else if (s.status === "failed") {
          clearInterval(waitTimer);
          if (obInstallBar) obInstallBar.classList.add("error");
          if (obInstallLabel) obInstallLabel.innerHTML = 'Install failed — <button onclick="retryInstall()" style="background:none;border:none;color:#3B82F6;cursor:pointer;text-decoration:underline;font:inherit">try again</button>';
        }
      } catch {}
    }, 1500);
  }

  function showApp() {
    if (installGate) installGate.classList.add("hidden");
    if (appEl) appEl.classList.remove("hidden");
    if (installPollTimer) clearInterval(installPollTimer);
    if (authPollTimer) clearInterval(authPollTimer);

    let restored = restoreSession();

    loadConfig().then(async () => {
      checkOnboarding();
      wsConnect();

      // If no local session, try auto-resuming the last conversation from server
      if (!restored) {
        restored = await autoResumeFromHistory();
      }

      // Auto-detect and connect integrations on first load
      fetch("/integrations/auto-detect-all", { method: "POST" })
        .then(r => r.json())
        .then(data => {
          if (data.detected && data.detected.length) {
            console.log("[Delt] Auto-connected:", data.detected.map(d => d.id).join(", "));
          }
          refreshIntegrationChips();
        })
        .catch(() => refreshIntegrationChips());

      if (restored && sessionId && ws) {
        const waitForOpen = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resume-session", sessionId }));
          } else {
            ws.addEventListener("open", () => {
              ws.send(JSON.stringify({ type: "resume-session", sessionId }));
            }, { once: true });
          }
        };
        waitForOpen();
      }
    });
    initSpeech();
    if (localStorage.getItem(MIC_CONSENT_KEY) === "denied" && micBtn) {
      micBtn.classList.add("hidden");
    }
    input.focus();
  }

  // Step 1: Get Started — kick off silent install + show account step
  const obStartBtn = document.getElementById("ob-start");
  if (obStartBtn) {
    obStartBtn.addEventListener("click", async () => {
      showObStep(obAccount);
      const health = await checkClaude();
      if (health.installed) {
        if (obInstallBar) obInstallBar.classList.add("done");
        if (obInstallFill) obInstallFill.style.width = "100%";
        if (obInstallLabel) obInstallLabel.textContent = "Engine ready!";
      } else {
        startSilentInstall();
      }
    });
  }

  // "I already have an account" — advance past account creation
  const obHaveAccount = document.getElementById("ob-have-account");
  if (obHaveAccount) {
    obHaveAccount.addEventListener("click", () => advanceToSignin());
  }

  // Account link click — user opens claude.ai, they'll click "I have an account" when done
  const obCreateLink = document.getElementById("ob-create-link");
  if (obCreateLink) {
    obCreateLink.addEventListener("click", () => {
      // After clicking, reveal a "Done" button variant
      setTimeout(() => {
        if (obHaveAccount) obHaveAccount.textContent = "I've created my account — next step";
      }, 1000);
    });
  }

  // Copy auth command
  const obAuthCopy = document.getElementById("ob-auth-copy");
  if (obAuthCopy) {
    obAuthCopy.addEventListener("click", () => {
      navigator.clipboard.writeText("claude");
      obAuthCopy.textContent = "Copied!";
      setTimeout(() => (obAuthCopy.textContent = "Copy"), 1500);
      // Start polling as soon as they copy — they're about to run it
      startAuthPoll();
    });
  }

  // Sign in button — opens terminal for auth (cross-platform)
  const obSigninBtn = document.getElementById("ob-signin-btn");
  if (obSigninBtn) {
    obSigninBtn.addEventListener("click", () => {
      fetch("/run-auth", { method: "POST" }).catch(() => {});
      if (obAuthDot) obAuthDot.className = "ob-auth-dot checking";
      if (obAuthText) obAuthText.textContent = "Waiting for sign in...";
      // Show the hint telling them to look at Terminal
      const hint = document.getElementById("ob-auth-hint");
      if (hint) hint.classList.remove("hidden");
      startAuthPoll();
    });
  }

  // Auth retry — uses deep check
  const obAuthRetry = document.getElementById("ob-auth-retry");
  if (obAuthRetry) {
    obAuthRetry.addEventListener("click", async () => {
      if (obAuthDot) obAuthDot.className = "ob-auth-dot checking";
      if (obAuthText) obAuthText.textContent = "Verifying...";
      try {
        const res = await fetch("/verify-auth", { method: "POST" });
        const data = await res.json();
        if (data.authed) {
          if (obAuthDot) obAuthDot.className = "ob-auth-dot ok";
          if (obAuthText) obAuthText.textContent = "Connected!";
          setTimeout(() => showObStep(obReady), 800);
        } else {
          if (obAuthDot) obAuthDot.className = "ob-auth-dot checking";
          if (obAuthText) obAuthText.textContent = "Not connected yet — try signing in again";
        }
      } catch {
        if (obAuthDot) obAuthDot.className = "ob-auth-dot checking";
        if (obAuthText) obAuthText.textContent = "Check failed — try again";
      }
    });
  }

  // Launch — enter the app
  const obLaunchBtn = document.getElementById("ob-launch");
  if (obLaunchBtn) {
    obLaunchBtn.addEventListener("click", showApp);
  }

  // --- Boot ---
  // install-gate is visible by default (no blank page ever).
  // If user is fully authed, we hide it and show the app.
  (async () => {
    try {
      const health = await checkClaude();
      if (health.installed && health.authed) {
        showApp();
      } else if (health.installed && !health.authed) {
        showObStep(obSignin);
        startAuthPoll();
      } else {
        showObStep(obAccount);
        startSilentInstall();
      }
    } catch (e) {
      showObStep(obWelcome);
    }
  })();
})();
