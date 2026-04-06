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
        messagesEl.innerHTML = data.messages;
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
  function wsConnect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      connected = true;
      setStatus("connected", "Ready");
    };

    ws.onclose = () => {
      connected = false;
      setStatus("error", "Disconnected");
      setTimeout(wsConnect, 2000);
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
        if (typeof fn === "function") return fn(text);
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

  let pane2SessionId = null;
  let pane2Busy = false;
  let pane2CurrentEl = null;
  let pane2LastText = "";
  const pane2SeenTools = new Set();
  let pane2Open = false;

  function openPane2() {
    if (pane2Open || !pane2) return;
    pane2Open = true;
    pane2.classList.remove("hidden");
    pane2Messages.innerHTML = "";
    pane2Welcome.classList.remove("hidden");
    pane2SessionId = null;
    pane2Busy = false;
    pane2CurrentEl = null;
    pane2LastText = "";
    pane2SeenTools.clear();
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
    pane2SessionId = null;
    pane2Busy = false;
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
        if (tool) sendPane2Message(tool.prompt);
      });
    });
  }

  function sendPane2Message(text) {
    text = text || (pane2Input ? pane2Input.value.trim() : "");
    if (!text || pane2Busy || !connected) return;
    pane2Welcome.classList.add("hidden");

    // Add user message to pane 2
    const userEl = document.createElement("div");
    userEl.className = "message user";
    const biz = config?.business || {};
    userEl.innerHTML = `
      <div class="message-avatar" style="background:var(--accent);color:white;">Y</div>
      <div class="message-body">
        <div class="message-sender">You</div>
        <div class="message-content" style="background:var(--accent-soft);padding:12px 18px;border-radius:var(--r-lg) var(--r-lg) 4px var(--r-lg);display:inline-block;">${escapeHtml(text)}</div>
      </div>
    `;
    pane2Messages.appendChild(userEl);
    if (pane2Input) { pane2Input.value = ""; pane2Input.style.height = "auto"; }
    pane2Send.disabled = true;

    // Send via WebSocket with pane2 tag
    ws.send(JSON.stringify({ type: "pane2-chat", message: text, sessionId: pane2SessionId }));
    pane2Busy = true;
    pane2Send.classList.add("hidden");
    pane2Stop.classList.remove("hidden");
    pane2CurrentEl = null;
    pane2LastText = "";
    pane2SeenTools.clear();
    pane2ScrollDown();
  }

  function pane2ScrollDown() {
    requestAnimationFrame(() => {
      if (pane2ScrollAnchor) pane2ScrollAnchor.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }

  function handlePane2Server(msg) {
    switch (msg.type) {
      case "pane2-session":
        pane2SessionId = msg.sessionId;
        break;
      case "pane2-thinking":
        // Show typing dots in pane 2
        break;
      case "pane2-stream":
        handlePane2Stream(msg.data);
        break;
      case "pane2-done":
        pane2CurrentEl = null;
        pane2LastText = "";
        pane2Busy = false;
        pane2Send.classList.remove("hidden");
        pane2Stop.classList.add("hidden");
        if (pane2Input) pane2Input.focus();
        break;
      case "pane2-error":
        pane2Busy = false;
        pane2Send.classList.remove("hidden");
        pane2Stop.classList.add("hidden");
        break;
    }
  }

  function handlePane2Stream(data) {
    if (!data || !data.type) return;
    if (data.type === "assistant") {
      const content = data.message?.content;
      if (!content || !Array.isArray(content)) return;
      if (!pane2CurrentEl) {
        const biz = config?.business || {};
        const avatar = (biz.name || "A").charAt(0);
        pane2CurrentEl = document.createElement("div");
        pane2CurrentEl.className = "message assistant";
        pane2CurrentEl.innerHTML = `
          <div class="message-avatar" style="background:var(--accent-soft);color:var(--accent);font-weight:700;">${avatar}</div>
          <div class="message-body">
            <div class="message-sender">${biz.name || "Assistant"}</div>
            <div class="message-content"></div>
          </div>
        `;
        pane2Messages.appendChild(pane2CurrentEl);
      }
      let text = "";
      for (const b of content) {
        if (b.type === "text") text += b.text;
      }
      if (text && text !== pane2LastText) {
        pane2LastText = text;
        const el = pane2CurrentEl.querySelector(".message-content");
        if (el) el.innerHTML = renderMd(text);
        pane2ScrollDown();
      }
    }
    if (data.type === "result") {
      if (!pane2CurrentEl && data.result) {
        const biz = config?.business || {};
        const avatar = (biz.name || "A").charAt(0);
        pane2CurrentEl = document.createElement("div");
        pane2CurrentEl.className = "message assistant";
        pane2CurrentEl.innerHTML = `
          <div class="message-avatar" style="background:var(--accent-soft);color:var(--accent);font-weight:700;">${avatar}</div>
          <div class="message-body">
            <div class="message-sender">${biz.name || "Assistant"}</div>
            <div class="message-content">${renderMd(data.result)}</div>
          </div>
        `;
        pane2Messages.appendChild(pane2CurrentEl);
      }
      pane2ScrollDown();
    }
  }

  if (pane2Close) pane2Close.addEventListener("click", closePane2);
  if (pane2Input) {
    pane2Input.addEventListener("input", () => {
      pane2Input.style.height = "auto";
      pane2Input.style.height = Math.min(pane2Input.scrollHeight, 160) + "px";
      pane2Send.disabled = !pane2Input.value.trim();
    });
    pane2Input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPane2Message(); }
    });
  }
  if (pane2Send) pane2Send.addEventListener("click", () => sendPane2Message());
  if (pane2Stop) pane2Stop.addEventListener("click", () => {
    if (ws && pane2Busy) ws.send(JSON.stringify({ type: "pane2-stop" }));
  });

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
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
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
        return `
          <div class="sidebar-item${isActive ? ' active' : ''}" data-session="${c.sessionId}">
            <div class="sidebar-item-title">${escapeHtml(c.title)}</div>
            <div class="sidebar-item-meta">
              <span>${c.messageCount} msgs</span>
              <span>${time}</span>
            </div>
          </div>
        `;
      }).join('');

      sidebarList.querySelectorAll('.sidebar-item').forEach((item) => {
        item.addEventListener('click', () => resumeConversation(item.dataset.session));
      });
    } catch {}
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

  // --- Activity Summary (Welcome Screen + Badge) ---
  const activitySummary = document.getElementById("activity-summary");
  const activityStats = document.getElementById("activity-stats");
  const activityRecent = document.getElementById("activity-recent");
  const activityViewAll = document.getElementById("activity-viewall");
  async function loadActivitySummary() {
    try {
      const res = await fetch("/logs/summary");
      const data = await res.json();
      renderActivitySummary(data);
    } catch {
      // No logs yet — keep hidden
    }
  }

  function renderActivitySummary(data) {
    if (!activitySummary || !activityStats || !activityRecent) return;

    const today = data.today || {};
    const week = data.week || {};
    const recent = data.recent || [];

    // Don't show if no data at all
    if (today.count === 0 && week.count === 0) return;

    activitySummary.classList.remove("hidden");

    // Stats row
    const totalDuration = today.totalDurationMs || 0;
    const durationDisplay = totalDuration < 60000
      ? Math.round(totalDuration / 1000) + "s"
      : Math.round(totalDuration / 60000) + "m";

    activityStats.innerHTML = `
      <div class="activity-stat">
        <span class="activity-stat-value accent">${today.count || 0}</span>
        <span class="activity-stat-label">Today</span>
      </div>
      <div class="activity-stat">
        <span class="activity-stat-value">${week.count || 0}</span>
        <span class="activity-stat-label">This week</span>
      </div>
      <div class="activity-stat">
        <span class="activity-stat-value">${today.count ? durationDisplay : "—"}</span>
        <span class="activity-stat-label">Time today</span>
      </div>
    `;

    // Recent list
    if (!recent.length) {
      activityRecent.innerHTML = `<div class="activity-empty">No conversations today yet.</div>`;
      return;
    }

    activityRecent.innerHTML = `<div class="activity-recent-list">${recent.map((e) => `
      <div class="activity-recent-item">
        <span class="activity-recent-time">${formatTime(e.timestamp)}</span>
        <div class="activity-recent-content">
          <div class="activity-recent-q">${escapeHtml(truncate(e.userMessage, 80))}</div>
          ${e.assistantMessage ? `<div class="activity-recent-a">${escapeHtml(truncate(e.assistantMessage, 100))}</div>` : ""}
        </div>
      </div>
    `).join("")}</div>`;
  }


  // ============================================
  // BTW — Side Panel
  // ============================================
  const btwFab = document.getElementById("btw-fab");
  const btwPanel = document.getElementById("btw-panel");
  const btwOverlay = document.getElementById("btw-overlay");
  const btwCloseBtn = document.getElementById("btw-close");
  const btwMessagesEl = document.getElementById("btw-messages");
  const btwEmpty = document.getElementById("btw-empty");
  const btwInput = document.getElementById("btw-input");
  const btwSendBtn = document.getElementById("btw-send");
  const btwStopBtn = document.getElementById("btw-stop");

  let btwBusy = false;
  let btwCurrentEl = null;
  let btwLastText = "";
  let btwTypingEl = null;
  const btwSeenTools = new Set();
  let btwActiveActivity = null;

  const chatColumn = document.querySelector(".chat-column");

  function openBtw() {
    btwPanel.classList.remove("hidden");
    btwFab.classList.add("panel-open");
    if (chatColumn) chatColumn.classList.add("multitask-open");
    btwInput.focus();
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

  function btwShowActivity(tool) {
    if (btwSeenTools.has(tool.id)) return;
    btwSeenTools.add(tool.id);
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
    if (btwCurrentEl) {
      btwCurrentEl.querySelector(".btw-msg-body").appendChild(el);
    } else {
      btwMessagesEl.appendChild(el);
    }
    btwActiveActivity = el;
    btwScrollDown();
  }

  function btwFinalizeActivities() {
    if (btwActiveActivity) {
      const dot = btwActiveActivity.querySelector(".btw-activity-dot");
      if (dot) dot.className = "btw-activity-dot done";
      btwActiveActivity = null;
    }
  }

  function btwSetBusy(val) {
    btwBusy = val;
    if (btwSendBtn) btwSendBtn.classList.toggle("hidden", val);
    if (btwStopBtn) btwStopBtn.classList.toggle("hidden", !val);
    if (!val && btwInput) btwInput.focus();
  }

  function btwUpdateSend() {
    if (btwSendBtn) btwSendBtn.disabled = !btwInput.value.trim();
  }

  function btwSend() {
    const text = btwInput.value.trim();
    if (!text || btwBusy || !connected) return;
    btwAddMsg("user", text);
    btwInput.value = "";
    btwInput.style.height = "auto";
    btwUpdateSend();
    ws.send(JSON.stringify({ type: "btw", message: text }));
    btwSetBusy(true);
    btwCurrentEl = null;
    btwLastText = "";
    btwSeenTools.clear();
    btwActiveActivity = null;
  }

  function handleBtwServer(msg) {
    switch (msg.type) {
      case "btw-thinking":
        btwShowTyping();
        break;
      case "btw-stream":
        handleBtwStream(msg.data);
        break;
      case "btw-done":
        btwHideTyping();
        btwFinalizeActivities();
        btwCurrentEl = null;
        btwLastText = "";
        btwSetBusy(false);
        break;
      case "btw-stopped":
        btwHideTyping();
        btwSetBusy(false);
        break;
      case "btw-error":
        btwHideTyping();
        const errEl = document.createElement("div");
        errEl.className = "error-banner";
        errEl.style.fontSize = "12px";
        errEl.textContent = msg.message;
        btwMessagesEl.appendChild(errEl);
        btwScrollDown();
        btwSetBusy(false);
        break;
      case "btw-cleared":
        btwMessagesEl.innerHTML = "";
        if (btwEmpty) { btwMessagesEl.appendChild(btwEmpty); btwEmpty.style.display = ""; }
        btwCurrentEl = null;
        btwLastText = "";
        btwSetBusy(false);
        break;
    }
  }

  function handleBtwStream(data) {
    if (!data || !data.type) return;
    if (data.type === "assistant") {
      btwHideTyping();
      const content = data.message?.content;
      if (!content || !Array.isArray(content)) return;
      if (!btwCurrentEl) {
        btwCurrentEl = btwAddMsg("assistant", "");
      }
      let text = "";
      const tools = [];
      for (const b of content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") tools.push(b);
      }
      if (text && text !== btwLastText) {
        btwLastText = text;
        const body = btwCurrentEl.querySelector(".btw-msg-body");
        if (body) {
          const activities = body.querySelectorAll(".btw-activity");
          body.innerHTML = renderMd(text);
          activities.forEach((a) => body.appendChild(a));
        }
        btwScrollDown();
      }
      for (const t of tools) btwShowActivity(t);
    }
    if (data.type === "result") {
      btwHideTyping();
      if (!btwCurrentEl && data.result) {
        btwCurrentEl = btwAddMsg("assistant", "");
        const body = btwCurrentEl.querySelector(".btw-msg-body");
        if (body) body.innerHTML = renderMd(data.result);
      }
      btwScrollDown();
    }
  }

  if (btwInput) {
    btwInput.addEventListener("input", () => {
      btwInput.style.height = "auto";
      btwInput.style.height = Math.min(btwInput.scrollHeight, 120) + "px";
      btwUpdateSend();
    });
    btwInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); btwSend(); }
    });
  }
  if (btwSendBtn) btwSendBtn.addEventListener("click", btwSend);
  if (btwStopBtn) btwStopBtn.addEventListener("click", () => {
    if (ws && btwBusy) ws.send(JSON.stringify({ type: "btw-stop" }));
  });

  // Patch handleServer to route btw-* and pane2-* messages
  const _origHandleServer = handleServer;
  handleServer = function(msg) {
    if (msg.type && msg.type.startsWith("btw-")) {
      handleBtwServer(msg);
    } else if (msg.type && msg.type.startsWith("pane2-")) {
      handlePane2Server(msg);
    } else {
      _origHandleServer(msg);
    }
  };

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
  // Install Gate
  // ============================================
  const installGate = document.getElementById("install-gate");
  const appEl = document.getElementById("app");
  const installStepDetect = document.getElementById("install-step-detect");
  const installStepMissing = document.getElementById("install-step-missing");
  const installStepAuth = document.getElementById("install-step-auth");
  const installStepReady = document.getElementById("install-step-ready");
  const installStatusDot = installGate?.querySelector(".install-status-dot");
  const installStatusText = document.getElementById("install-status-text");
  const installVersionText = document.getElementById("install-version-text");

  function showInstallStep(step) {
    [installStepDetect, installStepMissing, installStepAuth, installStepReady].forEach((s) => {
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

  async function runInstallCheck() {
    showInstallStep(installStepDetect);
    if (installStatusDot) installStatusDot.className = "install-status-dot checking";
    if (installStatusText) installStatusText.textContent = "Checking for Claude CLI...";

    const health = await checkClaude();

    if (!health.installed) {
      if (installStatusDot) installStatusDot.className = "install-status-dot fail";
      if (installStatusText) installStatusText.textContent = "Claude CLI not found";
      setTimeout(() => showInstallStep(installStepMissing), 600);
      return false;
    }

    if (!health.authed) {
      if (installStatusDot) installStatusDot.className = "install-status-dot fail";
      if (installStatusText) installStatusText.textContent = "Not signed in";
      setTimeout(() => showInstallStep(installStepAuth), 600);
      return false;
    }

    if (installStatusDot) installStatusDot.className = "install-status-dot ok";
    if (installStatusText) installStatusText.textContent = "Connected";
    if (installVersionText && health.version) {
      installVersionText.textContent = `Claude CLI ${health.version} is installed and connected. Everything runs locally on your machine.`;
    }
    setTimeout(() => showInstallStep(installStepReady), 400);
    return true;
  }

  function showApp() {
    if (installGate) installGate.classList.add("hidden");
    if (appEl) appEl.classList.remove("hidden");

    // Restore previous session if user navigated away
    const restored = restoreSession();

    loadConfig().then(() => {
      checkOnboarding();
      wsConnect();

      // If we restored a session, tell server to resume it
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
    loadActivitySummary();
    initSpeech();
    if (localStorage.getItem(MIC_CONSENT_KEY) === "denied" && micBtn) {
      micBtn.classList.add("hidden");
    }
    input.focus();
  }

  // Install button — open terminal with install command
  const installBtn = document.getElementById("install-btn");
  if (installBtn) {
    installBtn.addEventListener("click", () => {
      // macOS: open Terminal.app and run the install
      window.open("x-apple.terminal:///usr/bin/env?args=bash%20-c%20%22npm%20install%20-g%20%40anthropic-ai%2Fclaude-code%20%26%26%20echo%20%27Done!%20Go%20back%20to%20your%20browser.%27%20%26%26%20read%22");
      // Fallback: also try applescript approach via a fetch
      fetch("/run-install", { method: "POST" }).catch(() => {});
    });
  }

  // Auth button — open terminal
  const authBtn = document.getElementById("auth-btn");
  if (authBtn) {
    authBtn.addEventListener("click", () => {
      window.open("x-apple.terminal:///usr/bin/env?args=bash%20-c%20%22claude%20%26%26%20echo%20%27Done!%20Go%20back%20to%20your%20browser.%27%20%26%26%20read%22");
      fetch("/run-auth", { method: "POST" }).catch(() => {});
    });
  }

  // Copy install command
  const installCopy = document.getElementById("install-copy");
  const installCommand = document.getElementById("install-command");
  if (installCopy && installCommand) {
    installCopy.addEventListener("click", () => {
      navigator.clipboard.writeText(installCommand.textContent);
      installCopy.textContent = "Copied!";
      setTimeout(() => (installCopy.textContent = "Copy"), 1500);
    });
  }

  // Retry buttons
  const installRetry = document.getElementById("install-retry");
  if (installRetry) installRetry.addEventListener("click", () => runInstallCheck());

  const authRetry = document.getElementById("auth-retry");
  if (authRetry) authRetry.addEventListener("click", () => runInstallCheck());

  // Continue button
  const installContinue = document.getElementById("install-continue");
  if (installContinue) installContinue.addEventListener("click", showApp);

  // --- Boot ---
  // If already passed gate before, skip it
  (async () => {
    const health = await checkClaude();
    if (health.installed && health.authed) {
      showApp();
    } else {
      if (installGate) installGate.classList.remove("hidden");
      runInstallCheck();
    }
  })();
})();
