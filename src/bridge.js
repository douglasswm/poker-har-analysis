// bridge.js — runs in the ISOLATED world, document_start, all frames.
// Responsibilities:
//   1. Receive raw frames posted by hook.js (MAIN world) in this same frame.
//   2. Redact secrets BEFORE they leave this script.
//   3. If we are inside a child frame (the game iframe), relay frames up to the
//      top frame so the overlay can show them.
//   4. If we are the top frame, ingest frames (own + relayed) and feed the UI.
//
// The overlay UI itself is created by overlay code in this file, only in the
// top frame.
(function () {
  "use strict";

  const SECRET_KEYS = new Set([
    "password", "auth", "logintoken", "oldauth", "tfaauth", "accesstoken",
    "lockdowntoken", "sessionid", "token", "jwt", "refreshtoken", "apikey"
  ]);

  function redact(obj) {
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) {
        if (SECRET_KEYS.has(k.toLowerCase()) && obj[k]) out[k] = "REDACTED";
        else out[k] = redact(obj[k]);
      }
      return out;
    }
    return obj;
  }

  // Returns a safe, parsed copy of a frame's JSON (secrets stripped), or null.
  function sanitize(rawData) {
    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch (e) {
      return { json: null, text: rawData };
    }
    const safe = redact(parsed);
    return { json: safe, text: JSON.stringify(safe) };
  }

  const isTop = window.top === window.self;

  // --- Frame intake from hook.js (this frame's MAIN world) ---
  window.addEventListener("message", function (event) {
    const d = event.data;
    if (!d || event.source !== window) return; // only our own frame's hook posts

    if (d.__tengan === true) {
      const safe = sanitize(d.data);
      const frame = {
        direction: d.direction,
        url: d.url,
        time: d.time,
        json: safe.json,
        text: safe.text
      };
      if (isTop) {
        ingest(frame);
      } else {
        // Bubble up to the top frame (postMessage is cross-origin safe).
        try {
          window.top.postMessage({ __tenganRelay: true, frame: frame }, "*");
        } catch (e) {
          /* ignore */
        }
      }
    }
  });

  // --- Relayed frames from child frames (top frame only) ---
  if (isTop) {
    window.addEventListener("message", function (event) {
      const d = event.data;
      if (d && d.__tenganRelay === true && d.frame) ingest(d.frame);
    });
  }

  // ---------------------------------------------------------------------------
  // Top-frame only: store + overlay
  // ---------------------------------------------------------------------------
  if (!isTop) return;

  const MAX_FRAMES = 5000;
  const state = {
    frames: [],
    paused: false,
    filter: "front", // all | front | stake | intercom
    hand: null,      // latest parsed hand summary
    latestGs: null,  // latest raw GameState (for the engine)
    advice: null,    // latest recommendation
    unit: "usd",     // "usd" | "bb" display unit
    bbv: 2,          // big-blind value in chip units (from GameState)
    moneyType: null, // currency money-type id (from BalancesUpdate)
    heroSel: "auto", // "auto" or a seat index (as string)
    heroCardIds: [null, null] // manually entered hole cards when a seat has none
  };

  const RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const SUIT_LABELS = ["♣", "♦", "♥", "♠"];

  function connectionLabel(url) {
    if (/\/front/.test(url)) return "front";
    if (/stake\.com\/_api\/websockets/.test(url)) return "stake";
    if (/intercom/.test(url)) return "intercom";
    return "other";
  }

  function ingest(frame) {
    frame.conn = connectionLabel(frame.url);
    frame.type = (frame.json && (frame.json.t || frame.json.type)) || "(raw)";
    state.frames.push(frame);
    if (state.frames.length > MAX_FRAMES) state.frames.shift();

    // Update parsed hand summary from poker frames.
    if (frame.conn === "front" && frame.json) {
      const ft = frame.json.t || frame.json.type;
      if (window.PokerParser) {
        const summary = window.PokerParser.update(frame.json);
        if (summary) state.hand = summary;
      }
      if (ft === "GameState" && frame.json.gameState) {
        state.latestGs = frame.json.gameState;
        if (frame.json.gameState.bbv) state.bbv = frame.json.gameState.bbv;
      }
      if (ft === "BalancesUpdate" && frame.json.cashInfoList && frame.json.cashInfoList[0]) {
        state.moneyType = frame.json.cashInfoList[0].mt;
      }
    }

    if (!state.paused) render(frame);
  }

  // Expose ingest to the message handlers above.
  window.__tenganIngest = ingest;

  // ---------------------------------------------------------------------------
  // Overlay UI
  // ---------------------------------------------------------------------------
  let els = null;

  function buildOverlay() {
    if (document.getElementById("tengan-overlay")) return;
    const root = document.createElement("div");
    root.id = "tengan-overlay";
    root.innerHTML = `
      <div id="tengan-head">
        <span id="tengan-logo">♠</span>
        <span id="tengan-title">Tengan</span>
        <span id="tengan-spacer"></span>
        <button class="tg-icon accent" id="tengan-advise" title="GTO advice">⚡</button>
        <button class="tg-icon" id="tengan-min" title="Minimize">▁</button>
        <button class="tg-icon" id="tengan-close" title="Close HUD">✕</button>
      </div>
      <div id="tengan-tabs">
        <button class="tg-tab active" data-tab="table">Table</button>
        <button class="tg-tab" data-tab="log">Log <span id="tengan-count">0</span></button>
      </div>
      <div id="tengan-body">
        <div class="tg-panel active" data-panel="table">
          <div id="tengan-herobar">
            <span class="tg-herolabel">You</span>
            <select id="tengan-hero"></select>
            <span id="tengan-herocards"></span>
          </div>
          <div id="tengan-advice"></div>
          <div id="tengan-hand"></div>
          <div class="tengan-feed-title">Action feed</div>
          <div id="tengan-feed"></div>
        </div>
        <div class="tg-panel" data-panel="log">
          <div id="tengan-logbar">
            <select id="tengan-filter" title="Connection filter">
              <option value="front">front (game)</option>
              <option value="all">all</option>
              <option value="stake">stake</option>
              <option value="intercom">intercom</option>
            </select>
            <span class="tg-spacer"></span>
            <button class="tg-btn" id="tengan-pause" title="Pause/resume">Pause</button>
            <button class="tg-btn" id="tengan-clear" title="Clear">Clear</button>
            <button class="tg-btn" id="tengan-export" title="Export JSON">Export</button>
          </div>
          <div id="tengan-log"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    els = {
      root: root,
      count: root.querySelector("#tengan-count"),
      filter: root.querySelector("#tengan-filter"),
      pause: root.querySelector("#tengan-pause"),
      clear: root.querySelector("#tengan-clear"),
      export: root.querySelector("#tengan-export"),
      min: root.querySelector("#tengan-min"),
      close: root.querySelector("#tengan-close"),
      advise: root.querySelector("#tengan-advise"),
      heroSelect: root.querySelector("#tengan-hero"),
      heroCards: root.querySelector("#tengan-herocards"),
      advice: root.querySelector("#tengan-advice"),
      hand: root.querySelector("#tengan-hand"),
      feed: root.querySelector("#tengan-feed"),
      log: root.querySelector("#tengan-log"),
      head: root.querySelector("#tengan-head"),
      tabs: root.querySelectorAll(".tg-tab"),
      panels: root.querySelectorAll(".tg-panel")
    };

    els.filter.value = state.filter;
    els.filter.addEventListener("change", function () {
      state.filter = els.filter.value;
      rerenderAll();
    });
    els.pause.addEventListener("click", function () {
      state.paused = !state.paused;
      els.pause.textContent = state.paused ? "Resume" : "Pause";
      els.pause.classList.toggle("on", state.paused);
      if (!state.paused) rerenderAll();
    });
    els.clear.addEventListener("click", function () {
      state.frames = [];
      els.log.innerHTML = "";
      els.count.textContent = "0";
    });
    els.export.addEventListener("click", exportJson);
    els.advise.addEventListener("click", runAdvice);
    els.min.addEventListener("click", function () { root.classList.toggle("min"); });
    els.close.addEventListener("click", closeOverlay);

    els.heroSelect.addEventListener("change", function () {
      state.heroSel = els.heroSelect.value;
      state.heroCardIds = [null, null];
      renderHeroBar();
    });
    // Card pickers (delegated) for seats with no visible cards.
    els.heroCards.addEventListener("change", function (e) {
      const t = e.target;
      if (!t || !t.dataset || t.dataset.tgpick == null) return;
      const slot = +t.dataset.slot;     // 0 or 1 (which hole card)
      const kind = t.dataset.tgpick;    // "rank" or "suit"
      const sel = els.heroCards.querySelector(`[data-slot="${slot}"][data-tgpick="rank"]`);
      const sui = els.heroCards.querySelector(`[data-slot="${slot}"][data-tgpick="suit"]`);
      if (sel.value !== "" && sui.value !== "") {
        state.heroCardIds[slot] = (+sel.value) * 4 + (+sui.value);
      } else {
        state.heroCardIds[slot] = null;
      }
    });

    els.tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const name = tab.getAttribute("data-tab");
        els.tabs.forEach((t) => t.classList.toggle("active", t === tab));
        els.panels.forEach((p) => p.classList.toggle("active", p.getAttribute("data-panel") === name));
      });
    });

    makeDraggable(root, els.head);
    renderHeroBar();
    renderAdvice();
    renderHand();
    renderFeed();
  }

  function closeOverlay() {
    if (els && els.root) els.root.remove();
    els = null;
    showLauncher();
  }

  function showLauncher() {
    if (document.getElementById("tengan-launcher")) return;
    const btn = document.createElement("button");
    btn.id = "tengan-launcher";
    btn.textContent = "♠";
    btn.title = "Open Tengan HUD";
    btn.addEventListener("click", function () {
      btn.remove();
      buildOverlay();
      rerenderAll();
    });
    document.documentElement.appendChild(btn);
  }

  function positionsMap() {
    const map = {};
    if (state.hand && state.hand.seats) {
      for (const s of state.hand.seats) if (s.position) map[s.seat] = s.position;
    }
    return map;
  }

  function cardPicker(slot, id) {
    const r = id != null ? Math.floor(id / 4) : "";
    const s = id != null ? id % 4 : "";
    let ro = '<option value="">–</option>';
    RANK_LABELS.forEach((lbl, i) => { ro += `<option value="${i}" ${i === r ? "selected" : ""}>${lbl}</option>`; });
    let so = '<option value="">–</option>';
    SUIT_LABELS.forEach((lbl, i) => { so += `<option value="${i}" ${i === s ? "selected" : ""}>${lbl}</option>`; });
    return `<select class="tg-card" data-tgpick="rank" data-slot="${slot}">${ro}</select>` +
           `<select class="tg-card" data-tgpick="suit" data-slot="${slot}">${so}</select>`;
  }

  function renderHeroBar() {
    if (!els || !els.heroSelect) return;
    const seats = (state.hand && state.hand.seats) || [];
    // (Re)build the dropdown, preserving the current selection.
    const sig = seats.map((s) => s.seat + ":" + (s.position || "") + ":" + s.name).join("|");
    if (els.heroSelect.dataset.sig !== sig) {
      let opts = '<option value="auto">Auto (my seat)</option>';
      for (const s of seats) {
        const label = (s.position ? s.position + " " : "") + s.name + (s.cards ? " ✦" : "");
        opts += `<option value="${s.seat}">${escapeHtml(label)}</option>`;
      }
      els.heroSelect.innerHTML = opts;
      els.heroSelect.dataset.sig = sig;
    }
    els.heroSelect.value = state.heroSel;
    if (els.heroSelect.value !== state.heroSel) { state.heroSel = "auto"; els.heroSelect.value = "auto"; }

    // Card area: show visible cards, or pickers for a seat with hidden cards.
    // Guard rebuilds by a key so per-frame refreshes don't disturb open pickers.
    const selSeat = state.heroSel === "auto"
      ? seats.find((s) => s.cards)
      : seats.find((s) => String(s.seat) === String(state.heroSel));
    const hasCards = !!(selSeat && selSeat.cards);
    const key = state.heroSel + "|" + (selSeat ? selSeat.cards || "?" : "none") + "|" + hasCards;
    if (els.heroCards.dataset.key === key) return;
    els.heroCards.dataset.key = key;

    if (state.heroSel === "auto") {
      els.heroCards.innerHTML = selSeat
        ? `<span class="tg-cards">${escapeHtml(selSeat.cards)}</span>`
        : `<span class="tengan-empty">spectating</span>`;
    } else if (hasCards) {
      els.heroCards.innerHTML = `<span class="tg-cards">${escapeHtml(selSeat.cards)}</span>`;
    } else {
      els.heroCards.innerHTML = cardPicker(0, state.heroCardIds[0]) + cardPicker(1, state.heroCardIds[1]);
    }
  }

  // Resolve {heroSeat, heroCards} to pass to the engine. Uses the per-hand
  // cached card ids from the parser so it works even on frames missing dc.
  function resolveHero() {
    const seats = (state.hand && state.hand.seats) || [];
    if (state.heroSel === "auto") {
      const hero = seats.find((s) => s.cardIds && s.cardIds.length === 2);
      return hero ? { heroSeat: hero.seat, heroCards: hero.cardIds.slice() } : {};
    }
    const seat = parseInt(state.heroSel, 10);
    const out = { heroSeat: seat };
    const sel = seats.find((s) => s.seat === seat);
    if (sel && sel.cardIds && sel.cardIds.length === 2) {
      out.heroCards = sel.cardIds.slice();           // visible/cached cards
    } else {
      const a = state.heroCardIds[0], b = state.heroCardIds[1];
      if (a != null && b != null && a !== b) out.heroCards = [a, b]; // manual
    }
    return out;
  }

  function runAdvice() {
    if (!els) return;
    if (!window.TenganEngine) {
      els.advice.innerHTML = '<div class="tengan-empty">Engine bundle not loaded.</div>';
      return;
    }
    if (!state.latestGs) {
      els.advice.innerHTML = '<div class="tengan-empty">No GameState captured yet — sit at a table.</div>';
      return;
    }
    els.advice.innerHTML = '<div class="tengan-empty">Solving…</div>';
    // Defer so "Solving…" paints before a heavy river solve runs on this thread.
    setTimeout(function () {
      try {
        const opts = Object.assign({ iterations: 350 }, resolveHero());
        state.advice = window.TenganEngine.recommend(state.latestGs, positionsMap(), opts);
        renderAdvice();
      } catch (e) {
        els.advice.innerHTML = '<div class="tengan-empty">Engine error: ' +
          escapeHtml(String((e && e.message) || e)) + "</div>";
      }
    }, 30);
  }

  function renderAdvice() {
    if (!els) return;
    const out = state.advice;
    if (!out) {
      els.advice.innerHTML = '<div class="tengan-empty">Click ⚡ for a GTO read on the current spot.</div>';
      return;
    }
    const r = out.recommendation;
    let actionsHtml = "";
    if (r.actions && r.actions.length) {
      actionsHtml = '<div class="tengan-acts">' + r.actions.map(function (a) {
        return '<span class="tengan-act"><b>' + escapeHtml(a.label) + "</b> " +
          (a.freq * 100).toFixed(0) + "%</span>";
      }).join("") + "</div>";
    }
    let mathHtml = "";
    if (r.math) {
      mathHtml = '<div class="tengan-mathrow">pot odds ' + r.math.potOddsPct +
        "% · MDF " + r.math.mdfPct + "% · bluff " + r.math.bluffPct +
        "% · SPR " + r.math.spr + "</div>";
    }
    const expl = r.exploitabilityPct != null ? " · exploit " + r.exploitabilityPct + "%" : "";
    els.advice.innerHTML =
      '<div class="tengan-adv-head">' + escapeHtml(r.headline) +
      ' <span class="tengan-src">[' + escapeHtml(r.source) + expl + "]</span></div>" +
      '<div class="tengan-adv-detail">' + escapeHtml(r.detail) + "</div>" +
      actionsHtml + mathHtml +
      (r.note ? '<div class="tengan-note">' + escapeHtml(r.note) + "</div>" : "");
  }

  function passesFilter(frame) {
    return state.filter === "all" || frame.conn === state.filter;
  }

  function fmtTime(t) {
    const d = new Date(t);
    return d.toLocaleTimeString("en-GB", { hour12: false }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function render(frame) {
    if (!els) return;
    els.count.textContent = String(state.frames.length);
    renderHeroBar();
    renderHand();
    renderFeed();
    if (!passesFilter(frame)) return;

    const row = document.createElement("div");
    row.className = "tengan-row " + (frame.direction === "out" ? "out" : "in");
    const arrow = frame.direction === "out" ? "▲" : "▼";
    const preview = (frame.text || "").slice(0, 160);
    row.innerHTML = `
      <span class="tengan-t">${fmtTime(frame.time)}</span>
      <span class="tengan-dir">${arrow}</span>
      <span class="tengan-type">${escapeHtml(frame.type)}</span>
      <span class="tengan-prev">${escapeHtml(preview)}</span>
    `;
    const full = document.createElement("pre");
    full.className = "tengan-full";
    full.textContent = frame.json ? JSON.stringify(frame.json, null, 2) : frame.text;
    full.style.display = "none";
    row.addEventListener("click", function () {
      full.style.display = full.style.display === "none" ? "block" : "none";
    });
    els.log.appendChild(row);
    els.log.appendChild(full);

    // Auto-scroll if near the bottom.
    const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
    if (nearBottom) els.log.scrollTop = els.log.scrollHeight;

    // Trim DOM to avoid unbounded growth.
    while (els.log.childElementCount > 1200) els.log.removeChild(els.log.firstChild);
  }

  function rerenderAll() {
    if (!els) return;
    els.log.innerHTML = "";
    const slice = state.frames.slice(-600);
    for (const f of slice) {
      const saved = state.paused;
      state.paused = false;
      render(f);
      state.paused = saved;
    }
    renderHand();
    renderFeed();
  }

  function renderHand() {
    if (!els) return;
    const h = state.hand;
    if (!h) {
      els.hand.innerHTML = `<div class="tengan-empty">Waiting for a hand…</div>`;
      return;
    }
    const board = h.board && h.board.length ? h.board.join(" ") : "—";
    let seatRows = "";
    for (const s of h.seats) {
      seatRows += `<tr class="${s.folded ? "fold" : ""}">
        <td>${escapeHtml(s.position || "")}</td>
        <td>${escapeHtml(s.name || "")}</td>
        <td class="num">${s.stack != null ? fmtMoney(s.stack) : ""}</td>
        <td class="num">${s.bet ? fmtMoney(s.bet) : ""}</td>
        <td>${escapeHtml(s.lastAction || "")}</td>
        <td>${escapeHtml(s.cards || "")}</td>
      </tr>`;
    }
    els.hand.innerHTML = `
      <div class="tengan-hand-top">
        <span>Table ${escapeHtml(String(h.tableId))}</span>
        <span>Hand ${escapeHtml(String(h.handId))}</span>
        <span>${escapeHtml(h.street || "")}</span>
      </div>
      <div class="tengan-hand-mid">
        <span>Board: <b>${escapeHtml(board)}</b></span>
        <span>Pot: <b>${h.pot != null ? fmtMoney(h.pot) : "—"}</b></span>
      </div>
      <table class="tengan-seats">
        <thead><tr><th>Pos</th><th>Player</th><th>Stack</th><th>Bet</th><th>Last</th><th>Cards</th></tr></thead>
        <tbody>${seatRows}</tbody>
      </table>
    `;
  }

  function actionText(a) {
    switch (a.action) {
      case "raise": return `raises → ${fmtMoney(a.toAmount)}` + (a.amount ? ` (+${fmtMoney(a.amount)})` : "");
      case "bet": return `bets ${fmtMoney(a.toAmount || a.amount)}`;
      case "call": return `calls ${fmtMoney(a.amount || a.toAmount)}`;
      case "post SB": return `posts SB ${fmtMoney(a.toAmount)}`;
      case "post BB": return `posts BB ${fmtMoney(a.toAmount)}`;
      case "fold": return "folds";
      case "check": return "checks";
      case "timeout": return "times out (default)";
      default: return a.action;
    }
  }

  function renderFeed() {
    if (!els || !els.feed) return;
    const actions = state.hand && state.hand.actions;
    if (!actions || !actions.length) {
      els.feed.innerHTML = `<div class="tengan-empty">No actions yet this hand.</div>`;
      return;
    }
    let last = null, rows = "";
    for (const a of actions) {
      if (a.street !== last) {
        rows += `<div class="tengan-street">${escapeHtml(a.street || "")}</div>`;
        last = a.street;
      }
      const who = (a.position ? a.position + " " : "") + a.name;
      const cls = a.action === "fold" ? "fold" : (a.action === "raise" || a.action === "bet") ? "agg" : "";
      rows += `<div class="tengan-action ${cls}"><span class="who">${escapeHtml(who)}</span><span class="act">${escapeHtml(actionText(a))}</span></div>`;
    }
    els.feed.innerHTML = rows;
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state.frames, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tengan-frames-" + Date.now() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Chip units are cents (1 unit = $0.01). Display as dollars.
  function fmtMoney(units) {
    if (units == null || units === "" || isNaN(units)) return "";
    return "$" + (Number(units) / 100).toFixed(2);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function makeDraggable(root, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      root.style.left = (ox + e.clientX - sx) + "px";
      root.style.top = (oy + e.clientY - sy) + "px";
      root.style.right = "auto";
    });
    window.addEventListener("mouseup", function () { dragging = false; });
  }

  // Build the overlay once the DOM is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildOverlay);
  } else {
    buildOverlay();
  }
})();
