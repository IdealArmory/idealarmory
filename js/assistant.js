(function () {
  if (window.__iaAsst) return;
  window.__iaAsst = true;

  /* ── Styles ─────────────────────────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent = `
    #ia-asst-btn {
      position: fixed;
      bottom: 24px;
      right: 20px;
      z-index: 9000;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #c49a2a;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.28);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    #ia-asst-btn:hover { transform: scale(1.07); box-shadow: 0 6px 20px rgba(0,0,0,.32); }
    #ia-asst-btn svg { width: 26px; height: 26px; fill: #1b2a3b; }

    #ia-asst-panel {
      position: fixed;
      bottom: 92px;
      right: 20px;
      z-index: 9001;
      width: 360px;
      height: 520px;
      background: #fff;
      border: 1px solid #ddd;
      box-shadow: 0 8px 32px rgba(0,0,0,.18);
      display: flex;
      flex-direction: column;
      border-radius: 4px;
      opacity: 0;
      pointer-events: none;
      transform: translateY(12px);
      transition: opacity .2s, transform .2s;
    }
    #ia-asst-panel.open {
      opacity: 1;
      pointer-events: all;
      transform: translateY(0);
    }
    .ia-head {
      background: #1b2a3b;
      color: #fff;
      padding: 13px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-radius: 4px 4px 0 0;
      flex-shrink: 0;
    }
    .ia-head-left { display: flex; align-items: center; gap: 10px; }
    .ia-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: #c49a2a; display: flex; align-items: center;
      justify-content: center; font-weight: 700; font-size: 13px;
      color: #1b2a3b; font-family: 'Inter', sans-serif; flex-shrink: 0;
    }
    .ia-head-title { font-weight: 700; font-size: 14px; font-family: 'Inter', sans-serif; line-height: 1.3; }
    .ia-head-sub { font-size: 11px; opacity: .65; font-family: 'Inter', sans-serif; }
    .ia-close-btn {
      background: none; border: none; color: #fff; font-size: 18px;
      cursor: pointer; opacity: .7; padding: 4px; line-height: 1;
    }
    .ia-close-btn:hover { opacity: 1; }

    .ia-msgs {
      flex: 1; overflow-y: auto; padding: 14px 13px;
      display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth;
    }
    .ia-msg {
      max-width: 86%; padding: 10px 13px;
      font-size: 13.5px; line-height: 1.55;
      font-family: 'Inter', sans-serif; border-radius: 3px; word-break: break-word;
    }
    .ia-msg-assistant { background: #f4f4f2; color: #1b2a3b; align-self: flex-start; }
    .ia-msg-user { background: #1b2a3b; color: #fff; align-self: flex-end; }
    .ia-msg a { color: #c49a2a; text-decoration: underline; }
    .ia-msg ul { margin: 6px 0 4px 16px; padding: 0; }
    .ia-msg li { margin-bottom: 3px; }
    .ia-msg strong { font-weight: 700; }

    .ia-typing {
      display: flex; align-items: center; gap: 5px;
      padding: 12px 14px; align-self: flex-start;
      background: #f4f4f2; border-radius: 3px;
    }
    .ia-typing span {
      width: 7px; height: 7px; border-radius: 50%;
      background: #aaa; animation: ia-dot .9s infinite;
    }
    .ia-typing span:nth-child(2) { animation-delay: .15s; }
    .ia-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes ia-dot {
      0%, 60%, 100% { transform: translateY(0); opacity: .6; }
      30% { transform: translateY(-5px); opacity: 1; }
    }

    .ia-input-row {
      display: flex; align-items: center;
      border-top: 1px solid #e8e8e4; padding: 10px 12px; gap: 8px; flex-shrink: 0;
    }
    #ia-asst-input {
      flex: 1; border: 1.5px solid #ddd; padding: 9px 12px;
      font-size: 16px; font-family: 'Inter', sans-serif; outline: none;
      border-radius: 3px; color: #1b2a3b; background: #fafaf8;
    }
    #ia-asst-input:focus { border-color: #1b2a3b; }
    #ia-asst-input::placeholder { color: #bbb; }
    #ia-send-btn {
      width: 38px; height: 38px; border-radius: 50%;
      background: #c49a2a; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background .15s;
    }
    #ia-send-btn:hover { background: #b8891f; }
    #ia-send-btn:disabled { background: #ddd; cursor: default; }
    #ia-send-btn svg { width: 16px; height: 16px; fill: #1b2a3b; }

    @media (max-width: 768px) {
      #ia-asst-btn {
        bottom: calc(58px + env(safe-area-inset-bottom, 0px) + 14px);
        right: 14px;
      }
      #ia-asst-panel {
        right: 0; left: 0; bottom: calc(58px + env(safe-area-inset-bottom, 0px));
        width: 100%; height: 70vh;
        border-radius: 4px 4px 0 0;
        border-left: none; border-right: none; border-bottom: none;
      }
    }
    @media (max-width: 480px) { #ia-asst-panel { height: 75vh; } }
  `;
  document.head.appendChild(css);

  /* ── HTML ───────────────────────────────────────────────────────────────── */
  var root = document.createElement('div');
  root.innerHTML = `
    <button id="ia-asst-btn" aria-label="Open shopping assistant">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 10H6v-2h12v2zm0-3H6V7h12v2z"/>
      </svg>
    </button>
    <div id="ia-asst-panel">
      <div class="ia-head">
        <div class="ia-head-left">
          <div class="ia-avatar">IA</div>
          <div>
            <div class="ia-head-title">Ideal Armory Assistant</div>
            <div class="ia-head-sub">Firearm advisor &bull; Ask me anything</div>
          </div>
        </div>
        <button class="ia-close-btn" aria-label="Close">&#10005;</button>
      </div>
      <div class="ia-msgs" id="ia-msgs"></div>
      <div class="ia-input-row">
        <input type="text" id="ia-asst-input" placeholder="Ask me anything..." autocomplete="off">
        <button id="ia-send-btn" aria-label="Send">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  /* ── Wire up events ─────────────────────────────────────────────────────── */
  var panel   = document.getElementById('ia-asst-panel');
  var msgs    = document.getElementById('ia-msgs');
  var inp     = document.getElementById('ia-asst-input');
  var sendBtn = document.getElementById('ia-send-btn');

  document.getElementById('ia-asst-btn').addEventListener('click', function () { window.iaAsst.toggle(); });
  panel.querySelector('.ia-close-btn').addEventListener('click', function () { window.iaAsst.toggle(); });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.iaAsst.send(); }
  });
  sendBtn.addEventListener('click', function () { window.iaAsst.send(); });

  /* ── Assistant controller ───────────────────────────────────────────────── */
  window.iaAsst = {
    isOpen:  false,
    history: [],
    loading: false,

    toggle: function () {
      this.isOpen = !this.isOpen;
      panel.classList.toggle('open', this.isOpen);
      if (this.isOpen) {
        if (this.history.length === 0) this._greet();
        setTimeout(function () { inp.focus(); }, 250);
      }
    },

    _greet: function () {
      this._bubble('assistant',
        "Hi! I’m the Ideal Armory assistant — here to help you find exactly what you’re looking for.\n\nAre you shopping for a **firearm**, **optic**, **holster**, **ammo**, or something else today?");
    },

    _bubble: function (role, text) {
      var div = document.createElement('div');
      div.className = 'ia-msg ia-msg-' + role;
      div.innerHTML = this._md(text);
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    },

    _md: function (raw) {
      // Escape HTML
      var t = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Bold
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Links [label](url)
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
      // Bullets — must come before line-break conversion
      t = t.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
      t = t.replace(/(<li>.*?<\/li>\n?)+/g, '<ul>$&</ul>');
      // Line breaks
      t = t.replace(/\n/g, '<br>');
      return t;
    },

    _showTyping: function () {
      var d = document.createElement('div');
      d.id = 'ia-typing';
      d.className = 'ia-typing';
      d.innerHTML = '<span></span><span></span><span></span>';
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
    },

    _hideTyping: function () {
      var t = document.getElementById('ia-typing');
      if (t) t.remove();
    },

    send: function () {
      if (this.loading) return;
      var text = inp.value.trim();
      if (!text) return;
      inp.value = '';

      this._bubble('user', text);
      this.history.push({ role: 'user', content: text });

      this.loading = true;
      sendBtn.disabled = true;
      this._showTyping();

      var self = this;
      fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: self.history.slice(-20) }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          self._hideTyping();
          var reply = data.reply || "I’m having trouble connecting. Please try again in a moment.";
          self._bubble('assistant', reply);
          self.history.push({ role: 'assistant', content: reply });
        })
        .catch(function () {
          self._hideTyping();
          self._bubble('assistant', "I’m having trouble connecting. Please try again in a moment.");
        })
        .finally(function () {
          self.loading = false;
          sendBtn.disabled = false;
          inp.focus();
        });
    },
  };
})();
