(function () {
  if (window.__iaAssistant) return;
  window.__iaAssistant = true;

  /* ── Styles ───────────────────────────────────────────────── */
  var css = `
#ia-assistant { position:fixed; bottom:20px; right:20px; z-index:9999; font-family:'Inter',sans-serif; }

#ia-chat-btn {
  width:56px; height:56px; border-radius:50%; background:#1b2a3b; border:none; cursor:pointer;
  box-shadow:0 4px 16px rgba(0,0,0,.28); display:flex; align-items:center; justify-content:center;
  transition:background .18s, transform .15s;
}
#ia-chat-btn:hover { background:#c49a2a; transform:scale(1.07); }
#ia-chat-btn svg { width:26px; height:26px; }

#ia-chat-panel {
  position:absolute; bottom:68px; right:0;
  width:340px; max-height:520px;
  background:#fff; border:1.5px solid #e3e0d8;
  box-shadow:0 8px 32px rgba(0,0,0,.18);
  display:flex; flex-direction:column;
  opacity:0; pointer-events:none;
  transform:translateY(12px) scale(.97);
  transition:opacity .2s, transform .2s;
  border-radius:3px;
}
#ia-chat-panel.ia-open { opacity:1; pointer-events:all; transform:translateY(0) scale(1); }

.ia-head {
  background:#1b2a3b; color:#fff; padding:14px 16px;
  display:flex; align-items:center; gap:10px;
  border-radius:3px 3px 0 0;
}
.ia-head-avatar {
  width:32px; height:32px; background:#c49a2a; border-radius:50%;
  display:flex; align-items:center; justify-content:center; flex-shrink:0;
  font-size:16px; font-weight:700; color:#1b2a3b;
}
.ia-head-info { flex:1; }
.ia-head-name { font-size:14px; font-weight:700; line-height:1.2; }
.ia-head-status { font-size:11px; color:#c49a2a; }
.ia-close-btn {
  background:none; border:none; color:#fff; cursor:pointer;
  font-size:18px; line-height:1; padding:2px 4px; opacity:.7;
  transition:opacity .15s;
}
.ia-close-btn:hover { opacity:1; }

.ia-messages {
  flex:1; overflow-y:auto; padding:14px 12px;
  display:flex; flex-direction:column; gap:10px;
  scroll-behavior:smooth;
}
.ia-messages::-webkit-scrollbar { width:4px; }
.ia-messages::-webkit-scrollbar-thumb { background:#d0cdc6; border-radius:2px; }

.ia-msg { display:flex; gap:8px; align-items:flex-end; }
.ia-msg.ia-user { flex-direction:row-reverse; }

.ia-bubble {
  max-width:80%; padding:9px 12px; font-size:13px; line-height:1.55;
  border-radius:14px; word-break:break-word;
}
.ia-msg.ia-bot  .ia-bubble { background:#f2f1ee; color:#1b2a3b; border-bottom-left-radius:4px; }
.ia-msg.ia-user .ia-bubble { background:#1b2a3b; color:#fff;    border-bottom-right-radius:4px; }
.ia-msg.ia-user .ia-bubble a { color:#c49a2a; }
.ia-msg.ia-bot  .ia-bubble a { color:#1b2a3b; text-decoration:underline; font-weight:600; }
.ia-bubble strong { font-weight:700; }
.ia-bubble ul { margin:6px 0 2px 16px; padding:0; }
.ia-bubble li { margin-bottom:3px; }
.ia-bubble p { margin:0 0 6px; }
.ia-bubble p:last-child { margin-bottom:0; }

.ia-avatar-sm {
  width:24px; height:24px; border-radius:50%;
  background:#1b2a3b; display:flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:700; color:#c49a2a; flex-shrink:0;
}

.ia-typing { display:flex; align-items:center; gap:4px; padding:10px 12px; }
.ia-dot { width:7px; height:7px; border-radius:50%; background:#b0ada6; animation:ia-bounce .9s infinite; }
.ia-dot:nth-child(2) { animation-delay:.15s; }
.ia-dot:nth-child(3) { animation-delay:.3s; }
@keyframes ia-bounce { 0%,60%,100% { transform:translateY(0); } 30% { transform:translateY(-5px); } }

.ia-input-row {
  display:flex; gap:8px; padding:10px 12px;
  border-top:1.5px solid #ebe8e0;
  background:#faf9f7; border-radius:0 0 3px 3px;
}
#ia-input {
  flex:1; border:1.5px solid #d4d0c8; padding:9px 12px;
  font-family:'Inter',sans-serif; font-size:13px; outline:none;
  border-radius:3px; color:#1b2a3b; background:#fff;
  transition:border-color .15s;
}
#ia-input:focus { border-color:#1b2a3b; }
#ia-input::placeholder { color:#a09d96; }
#ia-send-btn {
  background:#1b2a3b; color:#fff; border:none; cursor:pointer;
  padding:9px 14px; font-size:13px; font-weight:600;
  font-family:'Inter',sans-serif; border-radius:3px;
  transition:background .15s;
  display:flex; align-items:center; gap:5px;
}
#ia-send-btn:hover { background:#c49a2a; }
#ia-send-btn:disabled { background:#a09d96; cursor:not-allowed; }

.ia-badge {
  position:absolute; top:-4px; right:-4px;
  width:14px; height:14px; background:#c49a2a; border-radius:50%;
  display:none; animation:ia-pulse 2s infinite;
}
@keyframes ia-pulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.2); } }

@media (max-width:480px) {
  #ia-assistant { bottom:74px; right:12px; }
  #ia-chat-panel { width:calc(100vw - 24px); right:-12px; max-height:420px; }
}
`;

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── HTML ─────────────────────────────────────────────────── */
  var wrap = document.createElement('div');
  wrap.id = 'ia-assistant';
  wrap.innerHTML = `
<div id="ia-chat-panel">
  <div class="ia-head">
    <div class="ia-head-avatar">IA</div>
    <div class="ia-head-info">
      <div class="ia-head-name">Ideal Armory Assistant</div>
      <div class="ia-head-status">&#x25CF; Online</div>
    </div>
    <button class="ia-close-btn" id="ia-close-btn" title="Close">&#x2715;</button>
  </div>
  <div class="ia-messages" id="ia-msgs"></div>
  <div class="ia-input-row">
    <input id="ia-input" type="text" placeholder="Ask me anything..." autocomplete="off" maxlength="500">
    <button id="ia-send-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
    </button>
  </div>
</div>

<button id="ia-chat-btn" title="Ask our assistant">
  <span class="ia-badge" id="ia-badge"></span>
  <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
</button>`;

  document.body.appendChild(wrap);

  /* ── State ────────────────────────────────────────────────── */
  var history = [];
  var isOpen = false;
  var isWaiting = false;

  var panel   = document.getElementById('ia-chat-panel');
  var msgs    = document.getElementById('ia-msgs');
  var input   = document.getElementById('ia-input');
  var sendBtn = document.getElementById('ia-send-btn');
  var badge   = document.getElementById('ia-badge');

  /* ── Markdown parser (links, bold, bullets, line breaks) ──── */
  function parseMarkdown(text) {
    // Escape HTML
    var s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      var isInternal = u.startsWith('/') || u.includes('idealarmory.com');
      return '<a href="' + u + '"' + (isInternal ? '' : ' target="_blank" rel="noopener"') + '>' + t + '</a>';
    });

    // Bold **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Bullet lines
    var lines = s.split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function (line) {
      var trimmed = line.trimStart();
      if (/^[-•]\s+/.test(trimmed)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + trimmed.replace(/^[-•]\s+/, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (trimmed === '') {
          out.push('<br>');
        } else {
          out.push('<p>' + line + '</p>');
        }
      }
    });
    if (inList) out.push('</ul>');

    // Collapse consecutive <br>
    return out.join('').replace(/(<br>){2,}/g, '<br>');
  }

  /* ── Render a message bubble ──────────────────────────────── */
  function addMessage(role, text) {
    var isBot = role === 'assistant';
    var row = document.createElement('div');
    row.className = 'ia-msg ' + (isBot ? 'ia-bot' : 'ia-user');

    if (isBot) {
      row.innerHTML = '<div class="ia-avatar-sm">IA</div><div class="ia-bubble">' + parseMarkdown(text) + '</div>';
    } else {
      row.innerHTML = '<div class="ia-bubble">' + parseMarkdown(text) + '</div>';
    }

    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  /* ── Typing indicator ─────────────────────────────────────── */
  function showTyping() {
    var row = document.createElement('div');
    row.className = 'ia-msg ia-bot';
    row.id = 'ia-typing-row';
    row.innerHTML = '<div class="ia-avatar-sm">IA</div><div class="ia-bubble ia-typing"><div class="ia-dot"></div><div class="ia-dot"></div><div class="ia-dot"></div></div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping() {
    var row = document.getElementById('ia-typing-row');
    if (row) row.remove();
  }

  /* ── Send a message ───────────────────────────────────────── */
  function sendMessage(text) {
    text = (text || input.value).trim();
    if (!text || isWaiting) return;

    input.value = '';
    addMessage('user', text);
    history.push({ role: 'user', content: text });

    isWaiting = true;
    sendBtn.disabled = true;
    showTyping();

    fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        var reply = data.reply || "Sorry, I'm having trouble right now. Please try again.";
        history.push({ role: 'assistant', content: reply });
        addMessage('assistant', reply);
      })
      .catch(function () {
        hideTyping();
        addMessage('assistant', "I'm having trouble connecting. Please try again in a moment.");
      })
      .finally(function () {
        isWaiting = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  /* ── Open / close ─────────────────────────────────────────── */
  function openChat() {
    isOpen = true;
    panel.classList.add('ia-open');
    badge.style.display = 'none';
    input.focus();
    if (history.length === 0) {
      var greeting = "Hi! I'm the Ideal Armory Assistant. I can help you find the perfect firearm or accessory.\n\nWhat are you looking for today? Feel free to describe your situation — whether it's your first rifle, a home defense setup, or anything in between.";
      history.push({ role: 'assistant', content: greeting });
      addMessage('assistant', greeting);
    }
  }

  function closeChat() {
    isOpen = false;
    panel.classList.remove('ia-open');
  }

  /* ── Event listeners ──────────────────────────────────────── */
  document.getElementById('ia-chat-btn').addEventListener('click', function () {
    isOpen ? closeChat() : openChat();
  });
  document.getElementById('ia-close-btn').addEventListener('click', closeChat);

  sendBtn.addEventListener('click', function () { sendMessage(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  /* ── Show badge after 8s to nudge visitors ────────────────── */
  setTimeout(function () {
    if (!isOpen) badge.style.display = 'block';
  }, 8000);
})();
