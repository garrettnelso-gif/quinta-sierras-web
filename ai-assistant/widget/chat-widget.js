/*
 * Quinta Sierras / Posta Bariloche — AI Concierge Chat Widget
 * -----------------------------------------------------------
 * Drop-in, dependency-free chat widget. Include this script plus
 * chat-widget.css on any page, then configure it like:
 *
 *   <link rel="stylesheet" href="ai-assistant/widget/chat-widget.css">
 *   <script>
 *     window.QS_CHAT_CONFIG = {
 *       property: "quinta-sierras",      // or "posta-bariloche"
 *       endpoint: "https://YOUR-WORKER-URL.workers.dev/chat",
 *       lang: "en",                       // initial language: en | es | de | fr
 *       accent: "#111110"                 // optional accent color override
 *     };
 *   </script>
 *   <script src="ai-assistant/widget/chat-widget.js" defer></script>
 *
 * The widget POSTs { property, lang, message, history } as JSON to
 * `endpoint` and expects back { reply: "..." }.
 */
(function () {
  'use strict';

  var cfg = window.QS_CHAT_CONFIG || {};
  var PROPERTY = cfg.property || 'quinta-sierras';
  var ENDPOINT = cfg.endpoint || '';
  var LANG = cfg.lang || (document.documentElement.lang || 'en').slice(0, 2);

  var STRINGS = {
    en: {
      title: PROPERTY === 'posta-bariloche' ? 'Posta Bariloche — Virtual Concierge' : 'Quinta Sierras — Virtual Concierge',
      placeholder: 'Ask about the property, dates, rates…',
      send: 'Send',
      greeting: "Hi! I'm the virtual host assistant. Ask me about the property, amenities, availability, or rates — I'll do my best to help, and the host will follow up on anything I can't answer.",
      error: "Sorry, something went wrong reaching the assistant. Please try again, or message the host directly via WhatsApp.",
      disabled: "Chat assistant is not configured yet — please use WhatsApp or email to get in touch.",
      fab: 'Ask us anything'
    },
    es: {
      title: PROPERTY === 'posta-bariloche' ? 'Posta Bariloche — Conserje Virtual' : 'Quinta Sierras — Conserje Virtual',
      placeholder: 'Preguntá sobre la propiedad, fechas, tarifas…',
      send: 'Enviar',
      greeting: 'Hola! Soy el asistente virtual del anfitrión. Preguntame sobre la propiedad, comodidades, disponibilidad o tarifas — voy a ayudarte en lo que pueda, y el anfitrión te va a responder lo que no pueda contestar.',
      error: 'Hubo un problema al contactar al asistente. Probá de nuevo o escribinos directamente por WhatsApp.',
      disabled: 'El asistente de chat todavía no está configurado — escribinos por WhatsApp o email.',
      fab: 'Pregúntanos lo que quieras'
    }
  };
  var T = STRINGS[LANG] || STRINGS.en;

  // ---- Build DOM ----
  var root = document.createElement('div');
  root.className = 'qsc-root';
  if (cfg.accent) root.style.setProperty('--qsc-accent', cfg.accent);

  root.innerHTML =
    '<button class="qsc-fab" type="button" aria-label="' + T.fab + '">' +
      '<svg viewBox="0 0 24 24" class="qsc-fab-icon-chat" xmlns="http://www.w3.org/2000/svg"><path d="M12 3C6.48 3 2 6.94 2 11.8c0 2.6 1.27 4.94 3.34 6.6-.07.78-.36 2.1-1.13 3.6 1.7-.27 3.27-.97 4.4-1.74 1.04.31 2.18.49 3.39.49 5.52 0 10-3.94 10-8.95S17.52 3 12 3z"/></svg>' +
      '<svg viewBox="0 0 24 24" class="qsc-fab-icon-close" xmlns="http://www.w3.org/2000/svg"><path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.7 2.88 18.3 9.17 12 2.88 5.71 4.3 4.29l6.29 6.3 6.29-6.3z"/></svg>' +
      '<span class="qsc-fab-label">' + T.fab + '</span>' +
    '</button>' +
    '<div class="qsc-panel" role="dialog" aria-label="' + T.title + '">' +
      '<div class="qsc-header">' +
        '<span class="qsc-header-title">' + T.title + '</span>' +
        '<button class="qsc-header-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="qsc-messages"></div>' +
      '<form class="qsc-form">' +
        '<input class="qsc-input" type="text" placeholder="' + T.placeholder + '" autocomplete="off" />' +
        '<button class="qsc-send" type="submit">' + T.send + '</button>' +
      '</form>' +
    '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(root);
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    document.body.appendChild(root);
  }

  var fab = root.querySelector('.qsc-fab');
  var panel = root.querySelector('.qsc-panel');
  var closeBtn = root.querySelector('.qsc-header-close');
  var messagesEl = root.querySelector('.qsc-messages');
  var form = root.querySelector('.qsc-form');
  var input = root.querySelector('.qsc-input');

  var history = []; // { role: 'user'|'assistant', content: '...' }
  var greeted = false;

  // Renders text into the bubble as plain text, except for two contact
  // tokens the assistant may emit:
  //   {{whatsapp:MESSAGE}} -> a "WhatsApp" link that opens a chat with the
  //     host with MESSAGE pre-filled.
  //   {{email:MESSAGE}}    -> an "Email" link that opens a new email to the
  //     host with MESSAGE pre-filled as the body.
  // Everything else is rendered as plain text.
  var WHATSAPP_NUMBER = '5493518749830';
  var HOST_EMAIL = 'quintasierras@gmail.com';
  var TOKEN_PATTERN = /\{\{(whatsapp|email):([^{}]+)\}\}/g;

  // A trailing {{buttons:Option A|Option B}} token (up to 3 options,
  // separated by "|") renders as tappable quick-reply buttons below the
  // message. Tapping one sends that label as the guest's next message,
  // exactly as written. Must be the last thing in the message.
  var BUTTONS_PATTERN = /\{\{buttons:([^{}]+)\}\}\s*$/;

  function renderRichText(container, text) {
    var lastIndex = 0;
    var match;
    TOKEN_PATTERN.lastIndex = 0;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var kind = match[1];
      var msg = match[2].trim();
      var a = document.createElement('a');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (kind === 'whatsapp') {
        a.href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);
        a.textContent = 'WhatsApp';
      } else {
        a.href = 'mailto:' + HOST_EMAIL + '?subject=' + encodeURIComponent('Quinta Sierras inquiry') + '&body=' + encodeURIComponent(msg);
        a.textContent = 'Email';
      }
      container.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function addMessage(role, text) {
    var row = document.createElement('div');
    row.className = 'qsc-msg qsc-msg-' + role;
    var bubble = document.createElement('div');
    bubble.className = 'qsc-bubble';

    var quickReplies = null;
    if (role === 'assistant') {
      var btnMatch = text.match(BUTTONS_PATTERN);
      if (btnMatch) {
        quickReplies = btnMatch[1].split('|')
          .map(function (s) { return s.trim(); })
          .filter(Boolean)
          .slice(0, 3);
        text = text.slice(0, btnMatch.index).replace(/\s+$/, '');
      }
      renderRichText(bubble, text);
    } else {
      bubble.textContent = text;
    }
    row.appendChild(bubble);

    if (quickReplies && quickReplies.length) {
      var replyRow = document.createElement('div');
      replyRow.className = 'qsc-quick-replies';
      quickReplies.forEach(function (label) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qsc-quick-reply';
        btn.textContent = label;
        btn.addEventListener('click', function () {
          replyRow.remove();
          sendMessage(label);
        });
        replyRow.appendChild(btn);
      });
      row.appendChild(replyRow);
    }

    messagesEl.appendChild(row);
    if (role === 'assistant') {
      // For assistant replies (which can be long), scroll so the start of
      // the new message is visible instead of jumping to its end.
      messagesEl.scrollTop = row.offsetTop - 8;
    } else {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return bubble;
  }

  function addTyping() {
    var row = document.createElement('div');
    row.className = 'qsc-msg qsc-msg-assistant qsc-typing-row';
    row.innerHTML = '<div class="qsc-bubble qsc-typing"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
  }

  function open() {
    root.classList.add('qsc-open');
    if (!greeted) {
      addMessage('assistant', T.greeting);
      greeted = true;
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
    root.classList.remove('qsc-open');
  }

  fab.addEventListener('click', function () {
    root.classList.contains('qsc-open') ? close() : open();
  });
  closeBtn.addEventListener('click', close);

  function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;

    if (!ENDPOINT) {
      addMessage('user', text);
      addMessage('assistant', T.disabled);
      return;
    }

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    input.disabled = true;

    var typingRow = addTyping();

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property: PROPERTY,
        lang: LANG,
        message: text,
        history: history.slice(0, -1) // prior turns, excluding the message just sent
      })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Bad response: ' + res.status);
        return res.json();
      })
      .then(function (data) {
        typingRow.remove();
        var reply = (data && data.reply) ? data.reply : T.error;
        addMessage('assistant', reply);
        history.push({ role: 'assistant', content: reply });
      })
      .catch(function () {
        typingRow.remove();
        addMessage('assistant', T.error);
      })
      .finally(function () {
        input.disabled = false;
        input.focus();
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  });
})();
