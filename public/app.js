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
      // Skip if older than 24 hours
      if (Date.now() - data.ts > 86400000) {
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
        setStatus("busy", "Thinking...");
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
        const el = currentAssistantEl.querySelector(".message-content");
        if (el) {
          el.innerHTML = renderMd(text);
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

  function descTool(tool) {
    const n = tool.name || "";
    const inp = tool.input || {};
    if (n === "Read" || n.includes("Read"))
      return { label: "Reading a file", detail: shortPath(inp.file_path) };
    if (n === "Write" || n.includes("Write"))
      return { label: "Creating a file", detail: shortPath(inp.file_path) };
    if (n === "Edit")
      return { label: "Editing", detail: shortPath(inp.file_path) };
    if (n === "Bash")
      return { label: "Running a task", detail: (inp.command || "").slice(0, 60) };
    if (n === "Glob" || n === "Grep" || n.includes("Search"))
      return { label: "Searching", detail: inp.pattern || inp.query || "" };
    if (n === "Agent")
      return { label: "Working on a subtask", detail: inp.description || "" };
    if (n === "WebSearch" || n === "WebFetch")
      return { label: "Looking something up", detail: "" };
    return { label: "Working...", detail: "" };
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

  // --- Error ---
  function showError(text) {
    const el = document.createElement("div");
    el.className = "error-banner";
    el.textContent = text;
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

  // --- Message Queue ---
  const messageQueue = [];

  // --- Chat ---
  function sendMessage(text) {
    text = text || input.value.trim();
    if ((!text && !attachedFiles.length) || !connected) return;

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

  // --- Integrations Panel ---
  const integrationsBtn = document.getElementById("integrations-btn");
  const integrationsPanel = document.getElementById("integrations-panel");
  const integrationsOverlay = document.getElementById("integrations-overlay");
  const integrationsClose = document.getElementById("integrations-close");
  const integrationsBody = document.getElementById("integrations-body");

  const INTEGRATION_ICONS = {
    google: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`,
    github: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#181717"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.8.2 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.2.9 2.4v3.5c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>`,
    slack: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M5.04 15.16a2.53 2.53 0 0 1-2.52 2.53A2.53 2.53 0 0 1 0 15.16a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.32A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.32z" fill="#E01E5A"/><path d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31z" fill="#36C5F0"/><path d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31z" fill="#2EB67D"/><path d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52h-6.31z" fill="#ECB22E"/></svg>`,
    notion: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#000"><path d="M4.46 4.63l10.08-.73c.25-.02.3-.01.46.12l2.1 1.47c.17.12.22.15.22.28v12.65c0 .37-.14.58-.57.61l-12.1.7c-.32.02-.48-.03-.64-.24L2.16 17.1c-.18-.24-.25-.42-.25-.63V5.33c0-.27.14-.54.55-.58l2-.12zm10.3 1.75c.05.24 0 .47 0 .72l-8.5.5v8.85c0 .37.2.53.46.51l7.74-.45c.27-.02.37-.16.37-.42V7.7c0-.24.25-.36.47-.34l1.16.08c.22.02.25.15.25.36v9c0 .68-.34 1.07-1.05 1.11l-9.6.55c-.7.04-1.06-.13-1.42-.58l-1.8-2.37c-.22-.3-.36-.52-.36-.86V6.83c0-.55.22-.9.73-.94l11.55-.67v1.16z"/></svg>`,
    linear: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M2.77 17.72a11.94 11.94 0 0 1-.72-2.26L11.52 24c.8-.14 1.56-.38 2.27-.72L2.77 17.72zm-1.5-4.5a12.08 12.08 0 0 1 .27-2.72L13.46 22.41c.93-.38 1.8-.88 2.59-1.48L1.78 8.66A12.04 12.04 0 0 0 .58 11.5l8.35 11.94a11.93 11.93 0 0 1-2.38-.44L1.27 13.22zm2.02-6.2L19 22.73a12.05 12.05 0 0 0 2.1-2.1L5.38 4.92A12.02 12.02 0 0 0 3.3 7.02zm4.1-3.58l15.17 11.55c.15-.63.26-1.28.32-1.94L9.35 1.98a12 12 0 0 0-1.96.46zM12 0C9.97 0 8.07.52 6.4 1.42L22.58 17.6A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z" fill="#5E6AD2"/></svg>`,
    stripe: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#635BFF"><path d="M13.98 11.01c0-1.47-.68-2.04-1.78-2.04-.75 0-1.58.28-2.2.74v5.58H7.5V7.54h2.5v.86c.8-.67 1.85-1.06 2.97-1.06 2.36 0 3.51 1.37 3.51 3.74v5.21h-2.5v-5.28zM4.5 7.34c.85 0 1.54-.7 1.54-1.56A1.55 1.55 0 0 0 4.5 4.22c-.86 0-1.55.7-1.55 1.56 0 .86.7 1.56 1.55 1.56zm1.25.2H3.24v8.75h2.5V7.54z"/></svg>`,
    shopify: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#95BF47"><path d="M15.34 3.84a.12.12 0 0 0-.1-.1 1.78 1.78 0 0 0-.5-.04s-1.06.03-1.76.08c-.12-.65-.52-1.8-1.74-1.8h-.08A1.43 1.43 0 0 0 10 2.5c-1.67.34-2.48 2.12-2.74 3.2l-1.9.59s-.56.18-.58.2A.87.87 0 0 0 4.2 7l-2.4 18.5L15.67 28l7.13-1.54S15.4 4.02 15.34 3.84zM11.4 5.2l-1.24.38c.25-.96.72-1.92 1.62-2.27A3.6 3.6 0 0 1 11.4 5.2zm-1.83.57L7.72 6.4A4.35 4.35 0 0 1 9.56 3.2zm.87-2.64c.1 0 .2.04.28.1-.97.46-2 1.62-2.44 3.93l-2 .62c.42-1.4 1.42-4.67 4.16-4.67v.02z"/></svg>`,
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
    sendgrid: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#1A82E2"><path d="M1 8h7v7H1V8zm7-7h7v7H8V1zm7 7h8v7h-8V8zm0 7h-7v7h7v-7z"/></svg>`,
    salesforce: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#00A1E0"><path d="M10 4.5a4.5 4.5 0 0 1 7.6-2 5 5 0 0 1 5.4 6 4.5 4.5 0 0 1-2 8.5H5a4 4 0 0 1-1-7.9A5.5 5.5 0 0 1 10 4.5z"/></svg>`,
    zoom: `<svg width="20" height="20" viewBox="0 0 24 24" fill="#2D8CFF"><rect x="1" y="4" width="22" height="16" rx="4"/><path d="M5 8h9v5.5c0 .8-.7 1.5-1.5 1.5H5V8z" fill="white"/><path d="M15 10l4-2.5v9L15 14v-4z" fill="white"/></svg>`,
    vscode: `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M17.58 2L7.72 10.16 3.87 7.17 2 8.04v7.92l1.87.87 3.85-2.99L17.58 22 22 20.08V3.92L17.58 2zM7.72 14.17L5.04 12l2.68-2.17v4.34zm9.86 3.93L12.7 12l4.88-6.1v12.2z" fill="#007ACC"/></svg>`,
    computer: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    api: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
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

  function renderIntegrations(integrations) {
    // Group by category
    const categories = {};
    for (const i of integrations) {
      const cat = i.category || "other";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(i);
    }

    // Connected first
    const connected = integrations.filter((i) => i.connected);
    const disconnected = integrations.filter((i) => !i.connected);

    let html = "";

    if (connected.length) {
      html += '<div class="integration-category-label">Connected</div>';
      html += '<div class="integrations-grid">';
      html += connected.map(renderIntegrationCard).join("");
      html += '</div>';
    }

    if (disconnected.length) {
      html += '<div class="integration-category-label">Available</div>';
      html += '<div class="integrations-grid">';
      html += disconnected.map(renderIntegrationCard).join("");
      html += '</div>';
    }

    // Custom APIs section
    html += '<div class="integration-category-label" style="margin-top:16px;">Custom APIs <button id="add-custom-api-btn" style="margin-left:8px;padding:2px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--accent);font-size:11px;cursor:pointer;font-weight:600;">+ Add API</button></div>';
    html += '<div id="custom-apis-list"></div>';
    html += '<div id="custom-api-form-container"></div>';

    integrationsBody.innerHTML = html;

    // Bind events via delegation — remove old listener first to prevent leak
    integrationsBody.removeEventListener("click", handleIntegrationClick);
    integrationsBody.addEventListener("click", handleIntegrationClick);

    // Load custom APIs list
    loadCustomApis();

    // Add API button
    const addBtn = document.getElementById("add-custom-api-btn");
    if (addBtn) addBtn.addEventListener("click", showAddCustomApiForm);
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
    if (templateSelect) {
      templateSelect.addEventListener("change", () => {
        if (!templateSelect.value) return;
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
          keyEl.focus();
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

  function renderIntegrationCard(i) {
    const icon = INTEGRATION_ICONS[i.icon] || i.name.charAt(0);
    if (i.connected) {
      // Build capabilities summary
      const caps = i.capabilities || {};
      let capsHtml = "";
      if (caps.creates && caps.creates.length) {
        capsHtml += `<span class="integration-caps">Can create: ${caps.creates.join(", ")}</span>`;
      }
      if (caps.limitations && caps.limitations.length) {
        capsHtml += `<span class="integration-caps limitation">${caps.limitations[0]}</span>`;
      }
      return `
        <div class="integration-card connected" data-id="${i.id}">
          <div class="integration-icon-box">${icon}</div>
          <div class="integration-info">
            <span class="integration-name">${escapeHtml(i.name)}</span>
            <span class="integration-desc">${escapeHtml(i.description)}</span>
            ${capsHtml}
            ${i.tryIt ? `<span class="integration-tryit">Try: &ldquo;${escapeHtml(i.tryIt)}&rdquo;</span>` : ""}
          </div>
          <div class="integration-actions">
            <span class="integration-status"><span class="integration-status-dot"></span> ${i.authType === "local-access" ? (i.accessLevel === "full" ? "Full Access" : "Limited Access") : "Connected"}</span>
            <button class="integration-verify-btn" data-action="verify" data-id="${i.id}" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-muted);cursor:pointer;">Verify</button>
            ${i.authType === "local-access"
              ? `<button class="integration-connect-btn" data-action="connect" data-id="${i.id}" data-auth="local-access" style="font-size:12px">Change</button>`
              : ""}
            <button class="integration-disconnect-btn" data-action="disconnect" data-id="${i.id}">Remove</button>
          </div>
        </div>`;
    }
    return `
      <div class="integration-card" data-id="${i.id}">
        <div class="integration-icon-box">${icon}</div>
        <div class="integration-info">
          <span class="integration-name">${escapeHtml(i.name)}</span>
          <span class="integration-desc">${escapeHtml(i.description)}</span>
        </div>
        <div class="integration-actions">
          ${i.setupTime ? `<span class="integration-setup-time">${escapeHtml(i.setupTime)}</span>` : ""}
          <button class="integration-connect-btn" data-action="connect" data-id="${i.id}" data-auth="${i.authType}">${i.authType === "oauth2" ? (i.oauthConfigured ? "Sign in" : "Set up") : i.authType === "enable" ? "Enable" : i.authType === "local-access" ? "Configure" : "Connect"}</button>
        </div>
      </div>`;
  }

  async function handleIntegrationClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === "verify") {
      btn.textContent = "Testing...";
      btn.disabled = true;
      try {
        const res = await fetch(`/integrations/${id}/test`, { method: "POST" });
        const data = await res.json();
        if (data.ok) {
          btn.textContent = "Working ✓";
          btn.style.color = "var(--success)";
          btn.style.borderColor = "var(--success)";
        } else {
          btn.textContent = "Failed ✗";
          btn.style.color = "var(--error)";
          btn.style.borderColor = "var(--error)";
          btn.title = data.error || "MCP server failed to start";
        }
      } catch {
        btn.textContent = "Error";
        btn.style.color = "var(--error)";
      }
      setTimeout(() => { btn.textContent = "Verify"; btn.disabled = false; btn.style.color = ""; btn.style.borderColor = ""; btn.title = ""; }, 3000);
      return;
    }

    if (action === "disconnect") {
      btn.textContent = "Removing...";
      try {
        await fetch(`/integrations/${id}/disconnect`, { method: "POST" });
        loadIntegrations();
      } catch {}
      return;
    }

    if (action === "connect") {
      const authType = btn.dataset.auth;
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
            btn.textContent = "Enabled (check setup)";
            btn.style.background = "#f59e0b";
            btn.title = enableData.warning;
            setTimeout(() => loadIntegrations(), 2000);
          } else {
            loadIntegrations();
          }
        } catch { btn.textContent = "Failed"; btn.disabled = false; }
      } else if (authType === "local-access") {
        showLocalAccessWizard(id, btn.closest(".integration-card"));
      } else if (authType === "oauth2") {
        startOAuthFlow(id);
      } else {
        // Try auto-detect first (e.g., gh CLI for GitHub)
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
        // Auto-detect failed — fall back to manual token wizard
        btn.textContent = "Connect";
        btn.disabled = false;
        showTokenWizard(id, btn.closest(".integration-card"));
      }
    }
  }

  // OAuth flow — open popup + poll fallback for PWA/desktop
  async function startOAuthFlow(integrationId) {
    try {
      const res = await fetch(`/integrations/${integrationId}/auth-url`);
      const data = await res.json();
      if (data.url) {
        const popup = window.open(data.url, "oauth", "width=500,height=700,left=200,top=100");

        // If popup was blocked, open in current tab as fallback
        if (!popup || popup.closed) {
          window.location.href = data.url;
          return;
        }

        let resolved = false;
        function done() {
          if (resolved) return;
          resolved = true;
          loadIntegrations();
        }

        // Method 1: postMessage from popup (works in regular browser)
        window.addEventListener("message", function handler(e) {
          if (e.data?.type === "oauth-complete" && e.data?.integrationId === integrationId) {
            window.removeEventListener("message", handler);
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
              done();
            }
          } catch {}
          if (attempts > 120) { // 2 min timeout
            clearInterval(poll);
          }
        }, 2000);
      } else if (data.needsSetup) {
        // OAuth not configured — show setup wizard on the card
        const card = document.querySelector(`.integration-card[data-id="${integrationId}"]`);
        if (card) showOAuthSetupWizard(integrationId, card);
      } else {
        alert(data.error || "OAuth not available for this service yet.");
      }
    } catch {
      alert("Failed to start authentication.");
    }
  }

  // OAuth setup wizard — shown when OAuth client isn't configured yet
  function showOAuthSetupWizard(integrationId, cardEl) {
    const existing = cardEl.querySelector(".oauth-setup-wizard");
    if (existing) { existing.remove(); return; }

    const wizard = document.createElement("div");
    wizard.className = "oauth-setup-wizard token-wizard";
    wizard.innerHTML = `
      <div class="token-wizard-header">
        <div class="token-wizard-title">Connect Google Account</div>
        <span class="token-wizard-time">One-time setup</span>
      </div>
      <div class="oauth-setup-explainer" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
        Delt needs a Google API key to access Gmail, Calendar, and Sheets on your behalf. This is a one-time setup — you won't need to do this again.
      </div>
      <ol class="token-wizard-steps">
        <li data-step="1"><a href="https://console.cloud.google.com/apis/credentials/oauthclient?previousPage=%2Fapis%2Fcredentials" target="_blank" rel="noopener"><strong>Click here</strong></a> to open Google's credential page</li>
        <li data-step="2">Select <strong>Desktop app</strong> as the type, name it <strong>Delt</strong>, then click Create</li>
        <li data-step="3">Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> shown and paste them below</li>
      </ol>
      <input class="token-wizard-input" data-key="clientId" type="text" placeholder="Client ID (xxxxx.apps.googleusercontent.com)" autocomplete="off">
      <input class="token-wizard-input" data-key="clientSecret" type="password" placeholder="Client Secret" autocomplete="off">
      <div style="display:flex;gap:8px;margin-top:4px;">
        <button class="token-wizard-submit" disabled style="flex:1">Save & Sign in</button>
        <button class="oauth-skip-btn" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:12px;cursor:pointer;">Skip for now</button>
      </div>
      <div class="token-wizard-troubleshoot">First time? You may need to <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">create a Google Cloud project</a> first (free, takes 10 seconds), then enable the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail</a>, <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Calendar</a>, and <a href="https://console.cloud.google.com/apis/library/sheets.googleapis.com" target="_blank" rel="noopener">Sheets</a> APIs.</div>
    `;

    // Skip button
    const skipBtn = wizard.querySelector(".oauth-skip-btn");
    if (skipBtn) skipBtn.addEventListener("click", () => wizard.remove());

    const inputs = wizard.querySelectorAll(".token-wizard-input");
    const submit = wizard.querySelector(".token-wizard-submit");

    function checkFilled() {
      submit.disabled = ![...inputs].every((inp) => inp.value.trim());
    }
    inputs.forEach((inp) => {
      inp.addEventListener("input", checkFilled);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !submit.disabled) doSetup();
      });
    });

    async function doSetup() {
      submit.disabled = true;
      submit.textContent = "Saving...";
      try {
        const setupRes = await fetch(`/integrations/${integrationId}/oauth-setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: inputs[0].value.trim(),
            clientSecret: inputs[1].value.trim(),
          }),
        });
        const result = await setupRes.json();
        if (result.ok) {
          wizard.remove();
          startOAuthFlow(integrationId);
        } else {
          submit.textContent = result.error || "Failed";
          submit.disabled = false;
        }
      } catch {
        submit.textContent = "Failed — try again";
        submit.disabled = false;
      }
    }

    submit.addEventListener("click", doSetup);
    cardEl.appendChild(wizard);
    inputs[0].focus();
  }

  // Token wizard — show inline form
  function showTokenWizard(integrationId, cardEl) {
    // Fetch integration details from the card's data
    const existingWizard = cardEl.querySelector(".token-wizard");
    if (existingWizard) { existingWizard.remove(); return; }

    // Find integration in the last loaded data
    fetch("/integrations").then((r) => r.json()).then((data) => {
      const integration = (data.integrations || []).find((i) => i.id === integrationId);
      if (!integration) return;

      const tc = integration.tokenConfig || {};
      const steps = (integration.setupSteps || []).map((s, i) =>
        `<li data-step="${i + 1}">${escapeHtml(s)}</li>`
      ).join("");

      const wizard = document.createElement("div");
      wizard.className = "token-wizard";
      const hasFields = tc.fields && tc.fields.length > 0;
      const inputsHtml = hasFields
        ? tc.fields.map((f) => `<input class="token-wizard-input" data-key="${escapeHtml(f.key)}" type="password" placeholder="${escapeHtml(f.placeholder || f.label)}" autocomplete="off" aria-label="${escapeHtml(f.label)}">`).join("")
        : `<input class="token-wizard-input" type="password" placeholder="${escapeHtml(tc.placeholder || 'Paste your token here')}" autocomplete="off">`;

      wizard.innerHTML = `
        <div class="token-wizard-header">
          <div class="token-wizard-title">How to get your ${escapeHtml(hasFields ? integration.name + " credentials" : tc.label || "API key")}</div>
          ${integration.setupTime ? `<span class="token-wizard-time">${escapeHtml(integration.setupTime)}</span>` : ""}
        </div>
        ${steps ? `<ol class="token-wizard-steps">${steps}</ol>` : ""}
        ${tc.helpUrl ? `<a class="token-wizard-link" href="${tc.helpUrl}" target="_blank" rel="noopener">Open ${escapeHtml(integration.name)} settings &rarr;</a>` : ""}
        ${inputsHtml}
        <button class="token-wizard-submit" disabled>Connect ${escapeHtml(integration.name)}</button>
        ${integration.troubleshooting ? `<div class="token-wizard-troubleshoot">${escapeHtml(integration.troubleshooting)}</div>` : ""}
      `;

      const inputs = wizard.querySelectorAll(".token-wizard-input");
      const submit = wizard.querySelector(".token-wizard-submit");

      function checkAllFilled() {
        submit.disabled = ![...inputs].every((inp) => inp.value.trim());
      }
      inputs.forEach((inp) => {
        inp.addEventListener("input", checkAllFilled);
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !submit.disabled) doConnect();
        });
      });
      submit.addEventListener("click", doConnect);

      async function doConnect() {
        submit.disabled = true;
        submit.textContent = "Connecting...";
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
            if (result.warning) {
              submit.textContent = "Connected (with warning)";
              submit.style.background = "#f59e0b";
              submit.title = result.warning;
              setTimeout(() => loadIntegrations(), 1500);
            } else {
              loadIntegrations();
            }
          } else {
            submit.textContent = result.error || "Failed. Try again.";
            submit.disabled = false;
          }
        } catch {
          submit.textContent = "Connection failed. Try again.";
          submit.disabled = false;
        }
      }

      cardEl.appendChild(wizard);
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
      if (qrStatusText) qrStatusText.textContent = "Scan with your phone camera";
      if (qrUrlRow) qrUrlRow.classList.remove("hidden");
      if (qrUrlInput) qrUrlInput.value = data.qrData;
      if (qrStopBtn) qrStopBtn.classList.remove("hidden");
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

  // Register service worker for PWA
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
        if (obInstallLabel) obInstallLabel.innerHTML = 'Node.js required — <a href="https://nodejs.org" target="_blank" style="color:#6C5CE7">install it</a>, then refresh';
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
          if (obInstallLabel) obInstallLabel.innerHTML = 'Install failed — <button onclick="retryInstall()" style="background:none;border:none;color:#6C5CE7;cursor:pointer;text-decoration:underline;font:inherit">try again</button>';
        }
      } catch {}
    }, 2000);
  }

  function startAuthPoll() {
    if (authPollTimer) clearInterval(authPollTimer);
    authPollTimer = setInterval(async () => {
      try {
        // Use deep auth check — actually runs Claude to verify token is valid
        const res = await fetch("/verify-auth", { method: "POST" });
        const data = await res.json();
        if (data.authed) {
          clearInterval(authPollTimer);
          if (obAuthDot) obAuthDot.className = "ob-auth-dot ok";
          if (obAuthText) obAuthText.textContent = "Connected!";
          setTimeout(() => showObStep(obReady), 800);
        }
      } catch {}
    }, 5000); // 5s interval since this actually calls Claude
  }

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
          if (obInstallLabel) obInstallLabel.innerHTML = 'Install failed — <button onclick="retryInstall()" style="background:none;border:none;color:#6C5CE7;cursor:pointer;text-decoration:underline;font:inherit">try again</button>';
        }
      } catch {}
    }, 1500);
  }

  function showApp() {
    if (installGate) installGate.classList.add("hidden");
    if (appEl) appEl.classList.remove("hidden");
    if (installPollTimer) clearInterval(installPollTimer);
    if (authPollTimer) clearInterval(authPollTimer);

    const restored = restoreSession();

    loadConfig().then(() => {
      checkOnboarding();
      wsConnect();

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
  (async () => {
    const health = await checkClaude();
    if (health.installed && health.authed) {
      showApp();
    } else {
      if (installGate) installGate.classList.remove("hidden");
      if (health.installed && !health.authed) {
        // Claude installed but not signed in — go straight to signin
        showObStep(obSignin);
        startAuthPoll();
      } else if (!health.installed) {
        // Claude not installed — trigger silent install immediately, skip to account step
        showObStep(obAccount);
        startSilentInstall();
      }
    }
  })();
})();
