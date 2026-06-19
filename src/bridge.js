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
    tourney: {},     // tournamentId -> { name, pko, playersLeft, paidSpots }
    worker: null,    // off-main-thread solver Web Worker
    workerFailed: false,
    solveSeq: 0,         // monotonic solve request id
    latestSolveId: 0,    // newest request (older responses are ignored)
    solveInFlight: null, // id of the request currently computing in the worker
    bbv: 2,          // big-blind value in chip units (from GameState)
    moneyType: null, // currency money-type id (from BalancesUpdate)
    heroSel: "auto", // "auto" or a seat index (as string)
    heroCardIds: [null, null], // manually entered hole cards when a seat has none
    expandedPlayer: null,      // Players tab: which player's history is open
    maxSeats: 9,               // table seat count (from GoToTable mp / seat array)
    maxSeatsLocked: false,     // true once mp is known from table info
    heroGs: null,              // latest GameState where the hero is in the hand
    heroInfo: null,            // { seat, cardIds } captured with heroGs
    lastAdviceKey: null        // debounce key for auto-advise
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
      let summary = null;
      if (window.PokerParser) {
        summary = window.PokerParser.update(frame.json);
        if (summary) state.hand = summary;
      }
      if (ft === "GameState" && frame.json.gameState) {
        const gs = frame.json.gameState;
        state.latestGs = gs;
        if (gs.bbv) state.bbv = gs.bbv;
        const sl = (gs.s || []).length;
        if (!state.maxSeatsLocked && sl) state.maxSeats = sl;

        // Track the frame where the hero is in the hand (for advice), and
        // auto-advise the moment it's the hero's turn on a live street.
        const heroS = summary && summary.seats.find(function (s) {
          return s.isHero && s.cardIds && s.cardIds.length === 2;
        });
        if (heroS) {
          state.heroGs = gs;
          state.heroInfo = { seat: heroS.seat, cardIds: heroS.cardIds.slice() };
          const m = gs.m || {};
          const live = m.r >= 1 && m.r <= 4;
          const heroToAct = live && !heroS.folded && m.ci === heroS.seat;
          if (heroToAct) {
            let sumBets = 0;
            for (const s of (gs.s || [])) if (s && typeof s.b === "number") sumBets += s.b;
            const key = gs.gi + ":" + m.r + ":" + sumBets;
            if (key !== state.lastAdviceKey) { state.lastAdviceKey = key; runAdvice(true); }
          }
        }
      }
      // Tournament context (PKO?, players left, paid spots) for advisory flags.
      if (ft === "LobbyTournamentInfo" && frame.json.info && frame.json.info.i != null) {
        const ti2 = frame.json.info;
        state.tourney[ti2.i] = {
          name: ti2.n || "",
          pko: /PKO/i.test(ti2.ptn || "") || !!ti2.bupk || (ti2.bkv > 0),
          playersLeft: typeof ti2.np === "number" ? ti2.np : null,
          paidSpots: typeof ti2.npzp === "number" ? ti2.npzp : null
        };
      }
      if (ft === "PlayerEndTournamentNotification" && frame.json.tournament && frame.json.tournament.i != null) {
        const tt = frame.json.tournament;
        const cur = state.tourney[tt.i] || {};
        cur.pko = cur.pko || /PKO/i.test(tt.ptn || "") || !!tt.bupk || (tt.bkv > 0);
        if (cur.name == null) cur.name = tt.n || "";
        state.tourney[tt.i] = cur;
      }
      // Authoritative table seat count (max players) when joining/viewing a table.
      const info = frame.json.info || frame.json;
      if ((ft === "GoToTable" || ft === "SelectTable") && info && info.mp) {
        state.maxSeats = info.mp; state.maxSeatsLocked = true;
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
        <button class="tg-icon" id="tengan-reset" title="Reset stats &amp; hand records">↺</button>
        <button class="tg-icon" id="tengan-min" title="Minimize">▁</button>
        <button class="tg-icon" id="tengan-close" title="Close HUD">✕</button>
      </div>
      <div id="tengan-tabs">
        <button class="tg-tab active" data-tab="table">Table</button>
        <button class="tg-tab" data-tab="players">Players</button>
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
          <div class="tengan-feed-title">GTO preflop range</div>
          <div id="tengan-grid"></div>
        </div>
        <div class="tg-panel" data-panel="players">
          <div id="tengan-players"></div>
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
      reset: root.querySelector("#tengan-reset"),
      advise: root.querySelector("#tengan-advise"),
      heroSelect: root.querySelector("#tengan-hero"),
      heroCards: root.querySelector("#tengan-herocards"),
      advice: root.querySelector("#tengan-advice"),
      hand: root.querySelector("#tengan-hand"),
      feed: root.querySelector("#tengan-feed"),
      grid: root.querySelector("#tengan-grid"),
      players: root.querySelector("#tengan-players"),
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
    els.reset.addEventListener("click", function () {
      if (!window.confirm("Reset all player stats and hand records?")) return;
      if (window.PokerParser && window.PokerParser.resetStats) window.PokerParser.resetStats();
      state.expandedPlayer = null;
      renderPlayers();
      renderHand();
      renderFeed();
    });

    els.heroSelect.addEventListener("change", function () {
      state.heroSel = els.heroSelect.value;
      renderHeroBar();
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
    renderGrid();
    renderHand();
    renderFeed();
    renderPlayers();
  }

  function closeOverlay() {
    if (els && els.root) els.root.remove();
    els = null;
    if (state.worker) { try { state.worker.terminate(); } catch (e) {} state.worker = null; }
    state.solveInFlight = null;
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

  function renderHeroBar() {
    if (!els || !els.heroSelect) return;
    const seats = (state.hand && state.hand.seats) || [];
    // (Re)build the dropdown, preserving the current selection. Default "Auto"
    // tracks the seat the server marks as the local player (wc/dc signal).
    const sig = seats.map((s) => s.seat + ":" + (s.position || "") + ":" + s.name).join("|");
    if (els.heroSelect.dataset.sig !== sig) {
      let opts = '<option value="auto">Auto (my seat)</option>';
      for (const s of seats) {
        const label = (s.position ? s.position + " " : "") + s.name + (s.isHero ? " (you)" : "");
        opts += `<option value="${s.seat}">${escapeHtml(label)}</option>`;
      }
      els.heroSelect.innerHTML = opts;
      els.heroSelect.dataset.sig = sig;
    }
    els.heroSelect.value = state.heroSel;
    if (els.heroSelect.value !== state.heroSel) { state.heroSel = "auto"; els.heroSelect.value = "auto"; }

    // Card area: show the auto-detected/selected seat's cards (no manual entry).
    const selSeat = state.heroSel === "auto"
      ? (seats.find((s) => s.isHero && s.cards) || seats.find((s) => s.cards))
      : seats.find((s) => String(s.seat) === String(state.heroSel));
    const key = state.heroSel + "|" + (selSeat ? (selSeat.cards || "?") : "none");
    if (els.heroCards.dataset.key === key) return;
    els.heroCards.dataset.key = key;

    if (selSeat && selSeat.cards) {
      els.heroCards.innerHTML = `<span class="tg-cards">${escapeHtml(selSeat.cards)}</span>`;
    } else if (state.heroSel === "auto") {
      els.heroCards.innerHTML = `<span class="tengan-empty">not in hand</span>`;
    } else {
      els.heroCards.innerHTML = `<span class="tengan-empty">cards hidden</span>`;
    }
  }

  // Resolve {heroSeat, heroCards} to pass to the engine, using the per-hand
  // cached card ids from the parser (works even on frames missing dc/d).
  function resolveHero() {
    const seats = (state.hand && state.hand.seats) || [];
    if (state.heroSel === "auto") {
      const withCards = (s) => s.cardIds && s.cardIds.length === 2;
      const hero = seats.find((s) => s.isHero && withCards(s)) || seats.find(withCards);
      return hero ? { heroSeat: hero.seat, heroCards: hero.cardIds.slice() } : {};
    }
    const seat = parseInt(state.heroSel, 10);
    const out = { heroSeat: seat };
    const sel = seats.find((s) => s.seat === seat);
    if (sel && sel.cardIds && sel.cardIds.length === 2) out.heroCards = sel.cardIds.slice();
    return out;
  }

  // (Re)create the off-main-thread solver worker. Returns null if unavailable
  // (e.g. CSP), in which case we fall back to a synchronous main-thread solve.
  function ensureWorker() {
    if (state.worker) return state.worker;
    if (state.workerFailed) return null;
    try {
      if (typeof Worker === "undefined" || typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
        state.workerFailed = true; return null;
      }
      const w = new Worker(chrome.runtime.getURL("src/engine.worker.js"));
      w.onmessage = onWorkerMessage;
      w.onerror = function () { state.workerFailed = true; try { w.terminate(); } catch (e) {} state.worker = null; };
      state.worker = w;
      return w;
    } catch (e) { state.workerFailed = true; return null; }
  }
  function restartWorker() {
    if (state.worker) { try { state.worker.terminate(); } catch (e) {} state.worker = null; }
    return ensureWorker();
  }
  function onWorkerMessage(ev) {
    const d = (ev && ev.data) || {};
    if (d.id !== state.latestSolveId) return;   // a newer request superseded this
    state.solveInFlight = null;
    if (!els) return;
    if (d.error) {
      if (!state.advice) els.advice.innerHTML = '<div class="tengan-empty">Engine error: ' + escapeHtml(String(d.error)) + "</div>";
      return;
    }
    state.advice = d.out;
    renderAdvice();
  }

  // Run the advisor. When `auto` it runs silently for the hero's current
  // decision; manual (⚡) advises the hero's active hand or the latest frame.
  // The solve runs in a Web Worker (off the main thread) so multi-second CFR
  // solves never freeze the HUD; falls back to a synchronous solve if needed.
  function runAdvice(auto) {
    if (!els) return;
    if (!window.TenganEngine) {
      if (!auto) els.advice.innerHTML = '<div class="tengan-empty">Engine bundle not loaded.</div>';
      return;
    }
    const useHeroGs = (state.heroSel === "auto") && state.heroGs;
    const gs = useHeroGs ? state.heroGs : state.latestGs;
    if (!gs) {
      if (!auto) els.advice.innerHTML = '<div class="tengan-empty">No hand captured yet — sit at a table.</div>';
      return;
    }
    let opts = { iterations: 350 };
    if (useHeroGs && state.heroInfo) {
      opts.heroSeat = state.heroInfo.seat;
      opts.heroCards = state.heroInfo.cardIds.slice();
    } else {
      opts = Object.assign(opts, resolveHero());
    }
    if (state.hand && state.hand.preflopAggressor != null && opts.heroSeat != null) {
      opts.heroRole = (opts.heroSeat === state.hand.preflopAggressor) ? "aggressor" : "caller";
    }
    // Primary villain's position + pot type, for the position-aware range-builder.
    if (state.hand && state.hand.seats && opts.heroSeat != null) {
      const seats = state.hand.seats;
      const agg = state.hand.preflopAggressor;
      let villSeat = (agg != null && agg !== opts.heroSeat) ? agg : null;
      if (villSeat == null) {
        const o = seats.find(function (s) { return !s.folded && s.seat !== opts.heroSeat && s.position; });
        if (o) villSeat = o.seat;
      }
      const vs = seats.find(function (s) { return s.seat === villSeat; });
      if (vs && vs.position) opts.villainPos = vs.position;
      let raises = 0;
      for (const a of (state.hand.actions || [])) if (a.street === "preflop" && a.action === "raise") raises++;
      opts.potType = raises >= 2 ? "3bet" : raises === 1 ? "srp" : "limped";

      // Did a player call a bet on a postflop street earlier than the current
      // one? (their range narrows to hands that continued — drops air)
      const ORD = { preflop: 0, flop: 1, turn: 2, river: 3 };
      const cur = ORD[state.hand.street] != null ? ORD[state.hand.street] : 9;
      const calledEarlier = function (seat) {
        for (const a of (state.hand.actions || [])) {
          const o = ORD[a.street] != null ? ORD[a.street] : 9;
          if (a.seat === seat && a.action === "call" && o >= 1 && o < cur) return true;
        }
        return false;
      };
      opts.heroContinued = calledEarlier(opts.heroSeat);
      if (villSeat != null) opts.villainContinued = calledEarlier(villSeat);
    }

    const id = ++state.solveSeq;
    state.latestSolveId = id;
    const positions = positionsMap();
    let w = ensureWorker();
    if (w) {
      opts.solveTurn = true;                         // safe off-thread (turn CFR is multi-second)
      if (state.solveInFlight) w = restartWorker();  // cancel a stale in-flight solve
      if (w) {
        state.solveInFlight = id;
        if (!auto) els.advice.innerHTML = '<div class="tengan-empty">Solving…</div>';
        try { w.postMessage({ id: id, gs: gs, positions: positions, opts: opts }); return; }
        catch (e) { state.workerFailed = true; state.worker = null; }
      }
    }
    // Synchronous fallback (no worker): keep turn on the fast heuristic.
    if (!auto) els.advice.innerHTML = '<div class="tengan-empty">Solving…</div>';
    setTimeout(function () {
      if (id !== state.latestSolveId) return;
      try { state.advice = window.TenganEngine.recommend(gs, positions, opts); renderAdvice(); }
      catch (e) {
        if (!auto) els.advice.innerHTML = '<div class="tengan-empty">Engine error: ' +
          escapeHtml(String((e && e.message) || e)) + "</div>";
      }
    }, auto ? 0 : 30);
  }

  function renderAdvice() {
    if (!els) return;
    const out = state.advice;
    if (!out) {
      els.advice.innerHTML = '<div class="tengan-empty">Click ⚡ for a GTO read on the current spot.</div>';
      return;
    }
    const r = out.recommendation;
    const bb = r.bb || state.bbv || 2;

    // Headline: build from the structured top action (formatted by unit), else
    // fall back to the text headline (math / messages).
    let headline;
    if (r.top) {
      headline = fmtAction(r.top, bb).toUpperCase();
      // Show the frequency whenever the strategy is mixed (more than one action).
      var mixed = r.actions && r.actions.filter(function (a) { return (a.freq || 0) > 0.004; }).length > 1;
      if (mixed || r.source === "solver") headline += " (" + Math.round((r.top.freq || 0) * 100) + "%)";
    } else {
      headline = r.headline || "—";
    }

    // GTO strategy: a prominent segmented action bar (big % blocks, GTO-Wizard
    // style) plus a labelled row per action showing its size and frequency.
    let actionsHtml = "";
    if (r.actions && r.actions.length) {
      const bars = r.actions.filter(function (b) { return (b.freq || 0) > 0.004; })
        .sort(function (a, b) { return b.freq - a.freq; });

      // Segmented distribution bar: each block grows with its frequency.
      const segs = bars.map(function (a) {
        const pct = Math.round(a.freq * 100);
        const cls = gActClass(fmtAction(a, bb));
        const verb = a.allin ? "All-in" : a.kind;
        const showLabel = a.freq >= 0.16;
        return '<span class="tg-actseg ' + cls + '" style="flex-grow:' + Math.max(a.freq, 0.001) +
          '" title="' + escapeHtml(fmtAction(a, bb)) + ' ' + pct + '%">' +
          '<span class="tg-segpct">' + pct + '%</span>' +
          (showLabel ? '<span class="tg-seglabel">' + escapeHtml(verb) + '</span>' : '') +
          '</span>';
      }).join("");
      const actbar = '<div class="tg-actbar">' + segs + '</div>';

      // Detailed rows (action + size + frequency).
      const rows = '<div class="tg-graph">' + bars.map(function (a) {
        const pct = Math.round(a.freq * 100);
        const label = fmtAction(a, bb);
        return '<div class="tg-gbar"><span class="tg-glabel">' + escapeHtml(label) + "</span>" +
          '<span class="tg-gtrack"><span class="tg-gfill ' + gActClass(label) +
          '" style="width:' + pct + '%"></span></span>' +
          '<span class="tg-gpct">' + pct + "%</span></div>";
      }).join("") + "</div>";

      actionsHtml = actbar + rows;
    }

    // Clean panel: action headline + short reason + strategy graph only.
    // (Pot-odds/MDF/SPR math and verbose notes are intentionally hidden.)
    const toggle = '<span class="tg-unit" id="tg-unit-toggle" title="Toggle $ / big blinds">' +
      '<span class="' + (state.unit === "usd" ? "on" : "") + '">$</span>' +
      '<span class="' + (state.unit === "bb" ? "on" : "") + '">bb</span></span>';

    // Tournament advisory strip: push/fold mode, PKO bounty, pay-jump proximity.
    let mttHtml = "";
    const sp = out.spot;
    if (sp && sp.isTournament) {
      const parts = [];
      if (r.note && r.note.indexOf("push/fold") >= 0) parts.push(r.note);
      const tc = state.tourney && state.tourney[sp.tournamentId];
      if (tc && tc.pko) parts.push("PKO: call jams a touch wider (bounties)");
      if (tc && tc.playersLeft != null && tc.paidSpots != null &&
          tc.playersLeft <= tc.paidSpots + 3 && tc.playersLeft >= tc.paidSpots) {
        parts.push("Near pay jump: tighten marginal calls");
      }
      if (parts.length) mttHtml = '<div class="tg-mtt">' + parts.map(escapeHtml).join(" · ") + "</div>";
    }

    // Source badge: tells the user which engine produced the advice (a true CFR
    // solve + its exploitability, a heuristic, or a multiway approximation).
    let srcHtml = "";
    if (r.note && !(sp && sp.isTournament && r.note.indexOf("push/fold") >= 0)) {
      const cls = /CFR|solve/i.test(r.note) ? "good"
        : /approximate|multiway|heuristic/i.test(r.note) ? "warn" : "muted";
      srcHtml = '<div class="tg-srcnote ' + cls + '">' + escapeHtml(r.note) + "</div>";
    }

    els.advice.innerHTML =
      '<div class="tengan-adv-head">' + escapeHtml(headline) + toggle + "</div>" +
      (r.detail ? '<div class="tengan-adv-detail">' + escapeHtml(r.detail) + "</div>" : "") +
      mttHtml +
      actionsHtml +
      srcHtml;

    const tg = els.advice.querySelector("#tg-unit-toggle");
    if (tg) tg.addEventListener("click", function () {
      state.unit = state.unit === "usd" ? "bb" : "usd";
      renderAdvice();
    });

    renderGrid();
  }

  // Hand code ("AKs", "TT", "72o") from two card ids (id = rank*4 + suit).
  function handCodeJS(a, b) {
    const RK = "23456789TJQKA";
    let r1 = a >> 2, r2 = b >> 2;
    const suited = (a & 3) === (b & 3);
    if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
    if (r1 === r2) return RK[r1] + RK[r2];
    return RK[r1] + RK[r2] + (suited ? "s" : "o");
  }

  // Colour class for a grid segment / legend dot.
  function gridCls(action) {
    if (action === "allin") return "allin";
    if (action === "raise") return "raise";
    if (action === "call") return "call";
    if (action === "check") return "check";
    return "fold";
  }

  // 13x13 preflop strategy matrix for the current spot's position/stack.
  function renderGrid() {
    if (!els || !els.grid) return;
    const out = state.advice;
    if (!out || !out.spot || !window.TenganEngine || !window.TenganEngine.preflopGrid) {
      els.grid.innerHTML = '<div class="tengan-empty">Range appears once a hand is read.</div>';
      return;
    }
    const sp = out.spot;
    const posLabel = sp.heroPosition || "BTN";
    const facing = (sp.street === "preflop" && sp.toCall > sp.bb) ? "raise" : "open";
    const stackBB = sp.bb > 0 ? sp.effStack / sp.bb : 100;
    let g;
    try { g = window.TenganEngine.preflopGrid(posLabel, facing, stackBB, !!sp.isTournament); }
    catch (e) { els.grid.innerHTML = ""; return; }

    // Hero's current hand → highlight that cell in the grid.
    let heroCode = null;
    if (sp.heroCards && sp.heroCards.length === 2) heroCode = handCodeJS(sp.heroCards[0], sp.heroCards[1]);

    const order = ["allin", "raise", "call", "check", "fold"];
    let cellsHtml = "";
    g.cells.forEach(function (cell) {
      const pureFold = cell.options.length === 1 && cell.options[0].action === "fold";
      const isHero = heroCode && cell.code === heroCode;
      let segs = "";
      if (!pureFold) {
        order.forEach(function (act) {
          const o = cell.options.find(function (x) { return x.action === act; });
          if (o && o.freq > 0.004) segs += '<span class="tg-gc-' + gridCls(act) + '" style="flex-grow:' + o.freq + '"></span>';
        });
      }
      cellsHtml += '<div class="tg-gcell' + (pureFold ? " fold0" : "") + (isHero ? " hero" : "") + '" title="' + cell.code + (isHero ? " (your hand)" : "") + '">' +
        '<span class="tg-gcellbg">' + segs + "</span>" +
        '<span class="tg-gcode">' + cell.code + "</span></div>";
    });

    const L = g.legend;
    function leg(act, label, pct) {
      return '<span class="tg-lg"><i class="tg-lgdot tg-gc-' + gridCls(act) + '"></i>' + label + " <b>" + pct.toFixed(2) + "%</b></span>";
    }
    const legend = '<div class="tg-rangelegend">' +
      (L.allin > 0.004 ? leg("allin", "All in", L.allin) : "") +
      leg("raise", "Raise", L.raise) +
      (L.call > 0.004 ? leg("call", "Call", L.call) : "") +
      (L.check > 0.004 ? leg("check", "Check", L.check) : "") +
      leg("fold", "Fold", L.fold) + "</div>";

    const jam = !!sp.isTournament && stackBB <= 25;
    const modeLabel = jam
      ? (facing === "raise" ? "call jam" : "open-jam")
      : (facing === "raise" ? "vs raise" : "RFI");
    const hdr = '<div class="tg-rangehdr">' + escapeHtml(posLabel) + " · " +
      modeLabel + " · " + Math.round(stackBB) + "bb" + (jam ? " · MTT" : "") + "</div>";

    els.grid.innerHTML = hdr + '<div class="tg-grid">' + cellsHtml + "</div>" + legend;
  }

  // Format an action's verb + size in the current unit ($ or bb).
  function fmtAction(a, bb) {
    if (!a) return "—";
    if (a.allin) return "all-in";
    if (a.kind === "fold") return "fold";
    if (a.kind === "check") return "check";
    if (a.kind === "call") return "call";
    if (a.kind === "bet" || a.kind === "raise") {
      let size = "";
      if (a.sizeBB != null) {
        size = state.unit === "bb" ? a.sizeBB + "bb" : "$" + (a.sizeBB * bb / 100).toFixed(2);
      } else if (a.amount != null) {
        size = state.unit === "bb" ? (a.amount / bb).toFixed(1) + "bb" : "$" + (a.amount / 100).toFixed(2);
      }
      // Flop/turn sizes also carry a pot fraction (Stake's 33/50/75/pot buttons).
      let pf = "";
      if (a.potFrac != null) pf = (a.potFrac >= 1 ? "pot" : Math.round(a.potFrac * 100) + "%") + " ";
      const body = (pf + size).trim();
      return body ? a.kind + " " + body : a.kind;
    }
    return a.kind;
  }

  // Colour class for a strategy-graph bar based on its action label.
  function gActClass(label) {
    label = (label || "").toLowerCase();
    if (label.indexOf("fold") >= 0) return "fold";
    if (label.indexOf("all-in") >= 0) return "allin";
    if (label.indexOf("check") >= 0) return "check";
    if (label.indexOf("call") >= 0) return "call";
    if (label.indexOf("bet") >= 0 || label.indexOf("raise") >= 0) return "agg";
    return "";
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
    renderPlayers();
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

  // Seat positions are generated for the table's actual seat count (6-max,
  // 9-max, etc.). Index i is placed around the oval matching Stake's layout:
  // the middle index sits at bottom-center, and increasing index goes
  // counter-clockwise (verified against a live 9-max table).
  const _layoutCache = {};
  function seatLayout(n) {
    n = Math.max(2, Math.min(10, n || 9));
    if (_layoutCache[n]) return _layoutCache[n];
    const cx = 50, cy = 49, rx = 40, ry = 39, anchor = Math.floor(n / 2);
    const pos = [];
    for (let i = 0; i < n; i++) {
      const slot = (anchor - i + n) % n;
      const th = (slot * 2 * Math.PI) / n;
      pos[i] = {
        l: (cx + rx * Math.sin(th)).toFixed(1) + "%",
        t: (cy + ry * Math.cos(th)).toFixed(1) + "%"
      };
    }
    _layoutCache[n] = pos;
    return pos;
  }

  function cardTokens(cardStr) {
    if (!cardStr) return "";
    return cardStr.split(" ").filter(Boolean).map(function (c) {
      const red = c.indexOf("♥") >= 0 || c.indexOf("♦") >= 0;
      return '<span class="tg-card2 ' + (red ? "red" : "blk") + '">' + escapeHtml(c) + "</span>";
    }).join("");
  }

  function renderHand() {
    if (!els) return;
    const h = state.hand;
    if (!h) {
      els.hand.innerHTML = `<div class="tengan-empty">Waiting for a hand…</div>`;
      return;
    }

    const winners = new Set(
      (h.result && h.result.winners ? h.result.winners : []).map((w) => w.name)
    );

    // Seat count: prefer the table's max-players (mp); else the seat-array size.
    const n = state.maxSeats || h.maxSeats || 9;
    const layout = seatLayout(n);

    let seatsHtml = "";
    for (const s of h.seats) {
      const pos = layout[s.seat] || { t: "50%", l: "50%" };
      const isWin = winners.has(s.name);
      const cls = (s.folded ? "fold " : "") + (s.isHero ? "hero " : "") + (isWin ? "win" : "");
      const cardsHtml = s.cards ? '<div class="tg-scards">' + cardTokens(s.cards) + "</div>" : "";
      const betHtml = s.bet ? '<div class="tg-bet">' + fmtMoney(s.bet) + "</div>" : "";
      const tags =
        (s.isHero ? '<span class="tg-tag you">YOU</span>' : "") +
        (isWin ? '<span class="tg-tag win">WIN</span>' : "");
      seatsHtml +=
        '<div class="tg-seat ' + cls.trim() + '" style="top:' + pos.t + ";left:" + pos.l + '">' +
          (tags ? '<div class="tg-tags">' + tags + "</div>" : "") +
          cardsHtml +
          '<div class="tg-sbody">' +
            '<div class="tg-srow1">' +
              (s.position ? '<span class="tg-spos">' + escapeHtml(s.position) + "</span>" : "") +
            "</div>" +
            '<div class="tg-sname">' + escapeHtml(s.name || "") + "</div>" +
            '<div class="tg-sstack">' + (s.stack != null ? fmtMoney(s.stack) : "") + "</div>" +
            (s.lastAction ? '<div class="tg-sact ' + actClass(s.lastAction) + '">' + escapeHtml(s.lastAction) + "</div>" : "") +
          "</div>" +
          betHtml +
        "</div>";
    }

    const boardHtml = (h.board && h.board.length)
      ? '<div class="tg-board2">' + cardTokens(h.board.join(" ")) + "</div>"
      : '<div class="tg-board2 empty">pre-flop</div>';

    let resultHtml = "";
    if (h.result && h.result.winners && h.result.winners.length) {
      resultHtml = '<div class="tengan-result">' + h.result.winners.map(function (w) {
        const amt = (typeof w.amount === "number") ? " $" + w.amount.toFixed(2) : "";
        const hand = w.handType ? " — " + escapeHtml(w.handType.replace(/&amp;/g, "&")) : " (uncalled)";
        return '<span class="tg-win">WIN</span> <b>' + escapeHtml(w.name) + "</b>" + amt + hand;
      }).join("<br>") + "</div>";
    }

    els.hand.innerHTML =
      '<div class="tg-tablehdr"><span>Hand ' + escapeHtml(String(h.handId)) + "</span>" +
        '<span class="tg-street">' + escapeHtml(h.street || "") + "</span></div>" +
      '<div class="tg-poker-table">' +
        '<div class="tg-felt"></div>' +
        '<div class="tg-center">' + boardHtml +
          '<div class="tg-pot2">Pot ' + (h.pot != null ? fmtMoney(h.pot) : "—") + "</div>" +
        "</div>" +
        seatsHtml +
      "</div>" +
      resultHtml;
  }

  function actClass(action) {
    if (action === "fold") return "fold";
    if (action === "check") return "check";
    if (action === "call") return "call";
    if (action === "bet" || action === "raise" || action === "bet/raise") return "agg";
    return "";
  }

  function renderPlayers() {
    if (!els || !els.players) return;
    const P = window.PokerParser;
    const stats = (P && P.getPlayerStats) ? P.getPlayerStats() : [];
    if (!stats.length) {
      els.players.innerHTML = '<div class="tengan-empty">No hands tracked yet — play/observe a few hands.</div>';
      return;
    }
    let rows = "";
    for (const r of stats) {
      const af = r.af === Infinity ? "∞" : r.af;
      const bluff = r.bluff == null ? "—" : r.bluff + "%";
      const exp = state.expandedPlayer === r.name;
      rows += `<tr class="tg-prow${exp ? " exp" : ""}" data-name="${escapeHtml(r.name)}">
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.hands}</td><td class="num">${r.vpip}</td><td class="num">${r.pfr}</td>
        <td class="num">${af}</td><td class="num">${r.wtsd}</td>
        <td class="num">${bluff}${r.bluffN ? '<span class="tg-n"> ' + r.bluffN + "</span>" : ""}</td>
      </tr>`;
      if (exp) {
        const hist = (P.getPlayerHistory(r.name) || []).slice(0, 15);
        let hh = hist.map(function (h) {
          const line = h.lines.map(function (l) {
            return '<b>' + l.street.charAt(0).toUpperCase() + "</b> " + escapeHtml(l.acts.join(","));
          }).join("  ");
          const tail = (h.shown ? " [" + escapeHtml(h.shown) + "]" : "") +
            (h.handType ? " " + escapeHtml(h.handType.replace(/&amp;/g, "&")) : "") + " — " + h.result;
          return '<div class="tg-hh">' + line + escapeHtml(tail) + "</div>";
        }).join("");
        if (!hh) hh = '<div class="tengan-empty">no recorded hands yet</div>';
        rows += '<tr class="tg-hist"><td colspan="7">' + hh + "</td></tr>";
      }
    }
    els.players.innerHTML =
      '<div class="tg-legend">' +
        '<div><b>VPIP / PFR</b><span>% of hands played / raised preflop</span></div>' +
        '<div><b>AF</b><span>aggression factor = (bets + raises) / calls</span></div>' +
        '<div><b>WTSD</b><span>% of flops seen that reached showdown</span></div>' +
        '<div><b>Bluff%</b><span>bet/raised river then showed no pair (n = shown hands)</span></div>' +
        '<div class="tg-legend-hint">Tap a player for their hand-by-hand history.</div>' +
      "</div>" +
      '<table class="tengan-pstats"><thead><tr>' +
      '<th>Player</th><th>Hd</th><th>VP</th><th>PFR</th><th>AF</th><th>WTSD</th><th>Bluff</th>' +
      '</tr></thead><tbody>' + rows + "</tbody></table>";
    els.players.querySelectorAll(".tg-prow").forEach(function (tr) {
      tr.addEventListener("click", function () {
        const n = tr.getAttribute("data-name");
        state.expandedPlayer = state.expandedPlayer === n ? null : n;
        renderPlayers();
      });
    });
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
    const actions = (state.hand && state.hand.actions) || [];
    // Always render all four street columns; a new hand just empties them.
    const order = ["preflop", "flop", "turn", "river"];
    const byStreet = {};
    for (const a of actions) (byStreet[a.street] = byStreet[a.street] || []).push(a);
    let cols = "";
    for (const st of order) {
      let rows = "";
      for (const a of (byStreet[st] || [])) {
        const who = (a.position ? '<span class="tg-fpos">' + escapeHtml(a.position) + "</span>" : "") +
          '<span class="tg-fname">' + escapeHtml(a.name) + "</span>";
        rows += '<div class="tg-frow">' + who +
          '<span class="tg-fact ' + actClass(a.action) + '">' + escapeHtml(feedLabel(a)) + "</span></div>";
      }
      if (!rows) rows = '<div class="tg-fempty">·</div>';
      cols += '<div class="tg-fcol"><div class="tg-fstreet">' + st + "</div>" + rows + "</div>";
    }
    els.feed.innerHTML = cols;
  }

  // Compact action label for the feed (verb + amount only).
  function feedLabel(a) {
    switch (a.action) {
      case "raise": return "raise " + fmtMoney(a.toAmount);
      case "bet": return "bet " + fmtMoney(a.toAmount || a.amount);
      case "call": return "call " + fmtMoney(a.amount || a.toAmount);
      case "post SB": return "SB " + fmtMoney(a.toAmount);
      case "post BB": return "BB " + fmtMoney(a.toAmount);
      case "fold": return "fold";
      case "check": return "check";
      case "timeout": return "timeout";
      default: return a.action;
    }
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
