/**
 * TRADELINK — Gemini AI Chatbot (shared/chatbot.js)
 * 
 * Simple, fast, and structured AI assistant:
 * - Floating bottom-right assistant bubble (visible only when logged in)
 * - Clean, pure text input chat box (no prompt buttons, chips, or clutter)
 * - Accepts any user question (e.g. price of DOMS Proxima pen, 10kg rice, general queries)
 * - Outputs structured, concise markdown response with bold highlights and bullet points
 */

(function () {
  'use strict';

  // Determine current portal role
  const isSellerPortal = window.location.pathname.includes('seller') || document.title.toLowerCase().includes('seller');
  const userRole = isSellerPortal ? 'seller' : 'merchant';
  const roleTitle = isSellerPortal ? 'Seller Assistant' : 'Procurement Assistant';

  let isWindowOpen = false;
  let chatHistory = [];

  // Render HTML Structure
  function initWidgetDOM() {
    if (document.getElementById('tl-ai-container')) return;

    const container = document.createElement('div');
    container.id = 'tl-ai-container';
    container.innerHTML = `
      <!-- Floating Trigger Launcher -->
      <button class="tl-ai-trigger" id="tl-ai-trigger" title="TradeLink AI Assistant">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L14.4 7.6L20 10L14.4 12.4L12 18L9.6 12.4L4 10L9.6 7.6L12 2Z" fill="currentColor" opacity="0.9"/>
          <path d="M18 16L19.2 18.8L22 20L19.2 21.2L18 24L16.8 21.2L14 20L16.8 18.8L18 16Z" fill="currentColor"/>
          <path d="M6 16L7 18.3L9.3 19.3L7 20.3L6 22.6L5 20.3L2.7 19.3L5 18.3L6 16Z" fill="currentColor" opacity="0.7"/>
        </svg>
        <span class="tl-ai-badge" id="tl-ai-badge">AI</span>
      </button>

      <!-- Chat Window -->
      <div class="tl-ai-window" id="tl-ai-window">
        <!-- Header -->
        <div class="tl-ai-header">
          <div class="tl-ai-header-left">
            <div class="tl-ai-avatar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M12 2L14.4 7.6L20 10L14.4 12.4L12 18L9.6 12.4L4 10L9.6 7.6L12 2Z"/>
              </svg>
            </div>
            <div class="tl-ai-title-wrap">
              <h4>TradeLink AI <span class="tl-ai-pill">Assistant</span></h4>
              <div class="tl-ai-subtitle">${roleTitle} • Online</div>
            </div>
          </div>
          <div class="tl-ai-header-actions">
            <button class="tl-ai-btn-icon" id="tl-ai-btn-clear" title="Clear Conversation">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
            <button class="tl-ai-btn-icon" id="tl-ai-btn-close" title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>

        <!-- Messages Area -->
        <div class="tl-ai-messages" id="tl-ai-messages"></div>

        <!-- Input Area -->
        <div class="tl-ai-input-area">
          <input type="text" class="tl-ai-input" id="tl-ai-input" placeholder="Ask anything (e.g. price of DOMS pen, 10kg rice)..." autocomplete="off" />
          <button class="tl-ai-send-btn" id="tl-ai-send-btn" title="Send message">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    setupEvents();
    renderWelcomeMessage();
  }

  function renderWelcomeMessage() {
    const messagesEl = document.getElementById('tl-ai-messages');
    if (!messagesEl) return;

    const initialText = "Hello! 👋 I am **TradeLink AI**.\n\nAsk me anything about product prices, quantities, calculations, market rates, or trade queries.";

    messagesEl.innerHTML = `
      <div class="tl-ai-msg assistant">
        <div class="tl-ai-msg-bubble">
          ${formatMarkdown(initialText)}
        </div>
      </div>
    `;
    chatHistory = [{ role: 'assistant', content: initialText }];
  }

  function setupEvents() {
    const trigger = document.getElementById('tl-ai-trigger');
    const closeBtn = document.getElementById('tl-ai-btn-close');
    const clearBtn = document.getElementById('tl-ai-btn-clear');
    const sendBtn = document.getElementById('tl-ai-send-btn');
    const inputEl = document.getElementById('tl-ai-input');

    trigger.addEventListener('click', toggleWindow);
    closeBtn.addEventListener('click', () => setWindowOpen(false));
    clearBtn.addEventListener('click', () => {
      chatHistory = [];
      renderWelcomeMessage();
    });

    sendBtn.addEventListener('click', () => handleUserSend());
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleUserSend();
      }
    });
  }

  function toggleWindow() {
    setWindowOpen(!isWindowOpen);
  }

  function setWindowOpen(open) {
    isWindowOpen = open;
    const win = document.getElementById('tl-ai-window');
    if (win) {
      if (open) {
        win.classList.add('open');
        document.getElementById('tl-ai-input')?.focus();
        scrollToBottom();
      } else {
        win.classList.remove('open');
      }
    }
  }

  function scrollToBottom() {
    const messagesEl = document.getElementById('tl-ai-messages');
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function appendMessage(role, content) {
    const messagesEl = document.getElementById('tl-ai-messages');
    if (!messagesEl) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = `tl-ai-msg ${role}`;
    msgDiv.innerHTML = `
      <div class="tl-ai-msg-bubble">
        ${formatMarkdown(content)}
      </div>
    `;
    messagesEl.appendChild(msgDiv);
    scrollToBottom();
  }

  function showTypingIndicator() {
    const messagesEl = document.getElementById('tl-ai-messages');
    if (!messagesEl) return;

    const typingDiv = document.createElement('div');
    typingDiv.id = 'tl-ai-typing-indicator';
    typingDiv.className = 'tl-ai-msg assistant';
    typingDiv.innerHTML = `
      <div class="tl-ai-typing">
        <div class="tl-ai-dot"></div>
        <div class="tl-ai-dot"></div>
        <div class="tl-ai-dot"></div>
      </div>
    `;
    messagesEl.appendChild(typingDiv);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    const indicator = document.getElementById('tl-ai-typing-indicator');
    if (indicator) indicator.remove();
  }

  async function handleUserSend() {
    const inputEl = document.getElementById('tl-ai-input');
    const sendBtn = document.getElementById('tl-ai-send-btn');
    const text = (inputEl.value || '').trim();
    if (!text) return;

    inputEl.value = '';
    sendBtn.disabled = true;

    // Append user message
    appendMessage('user', text);
    chatHistory.push({ role: 'user', content: text });

    showTypingIndicator();

    try {
      let apiBase = 'http://localhost:8000';
      if (typeof window.ENV_CONFIG !== 'undefined' && window.ENV_CONFIG && window.ENV_CONFIG.BACKEND_URL) {
        apiBase = window.ENV_CONFIG.BACKEND_URL.replace(/\/api\/?$/, '').replace(/\/+$/, '');
      } else if (typeof window.API_BASE === 'string' && window.API_BASE) {
        apiBase = window.API_BASE.replace(/\/api\/?$/, '').replace(/\/+$/, '');
      } else if (typeof window.API_BASE_URL === 'string' && window.API_BASE_URL) {
        apiBase = window.API_BASE_URL.replace(/\/api\/?$/, '').replace(/\/+$/, '');
      } else if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        apiBase = '';
      }

      const response = await fetch(`${apiBase}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: chatHistory.map(m => ({ role: m.role, content: m.content })),
          role: userRole
        })
      });

      const data = await response.json();
      hideTypingIndicator();

      if (data.success && data.text) {
        appendMessage('assistant', data.text);
        chatHistory.push({ role: 'assistant', content: data.text });
      } else {
        const errorMsg = data.text || data.error || "Unable to get response from AI. Please check backend connection.";
        appendMessage('assistant', `⚠️ ${errorMsg}`);
      }
    } catch (err) {
      hideTypingIndicator();
      appendMessage('assistant', "⚠️ Connection to TradeLink AI backend failed. Please ensure the backend server is running on `http://localhost:8000`.");
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // Structured Markdown Formatter for chat bubbles
  function formatMarkdown(text) {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Headings
    html = html.replace(/^### (.*$)/gim, '<div style="font-weight:700;margin:6px 0 2px 0;font-size:14px;color:#34d399;">$1</div>');
    html = html.replace(/^## (.*$)/gim, '<div style="font-weight:700;margin:8px 0 3px 0;font-size:15px;color:#34d399;">$1</div>');

    // Bold highlights
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color:#34d399;">$1</strong>');
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-family:monospace;">$1</code>');
    // Lists
    html = html.replace(/^\s*[-•*]\s+(.*)$/gm, '<li style="margin-bottom:3px;">$1</li>');
    html = html.replace(/(<li.*<\/li>)/s, '<ul style="margin:4px 0 6px 18px;padding:0;">$1</ul>');
    // Line breaks
    html = html.replace(/\n\n/g, '<div style="margin:6px 0;"></div>').replace(/\n/g, '<br>');

    return `<div style="line-height:1.5;">${html}</div>`;
  }

  function updateAuthVisibility() {
    const container = document.getElementById('tl-ai-container');
    if (!container) return;

    const isBodyAppVisible = document.body.classList.contains('app-visible');
    const appShell = document.querySelector('.app-shell');
    const isAppShellVisible = appShell && window.getComputedStyle(appShell).display !== 'none';
    const loginShell = document.querySelector('.login-shell');
    const isLoginShellHidden = loginShell && window.getComputedStyle(loginShell).display === 'none';

    const isLoggedIn = isBodyAppVisible || (isAppShellVisible && isLoginShellHidden);

    if (isLoggedIn) {
      container.classList.add('tl-visible');
      container.style.display = 'block';
    } else {
      container.classList.remove('tl-visible');
      container.style.display = 'none';
      if (isWindowOpen) {
        setWindowOpen(false);
      }
    }
  }

  // Auto-init on DOMContentLoaded or immediate
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initWidgetDOM();
      setInterval(updateAuthVisibility, 400);
    });
  } else {
    initWidgetDOM();
    setInterval(updateAuthVisibility, 400);
  }

  // Export to window
  window.TradeLinkAI = {
    open: () => setWindowOpen(true),
    close: () => setWindowOpen(false),
    ask: (prompt) => {
      setWindowOpen(true);
      const inputEl = document.getElementById('tl-ai-input');
      if (inputEl) {
        inputEl.value = prompt;
        handleUserSend();
      }
    }
  };
})();
