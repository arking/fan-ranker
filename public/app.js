// =======================
// Helpers
// =======================
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function api(path, opts = {}) {
  const headers = opts.headers ? { ...opts.headers } : {};
  if (tenantId) headers["X-Tenant-Id"] = String(tenantId);

  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg = data && data.error ? data.error : text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function setMsg(el, msg) {
  if (!el) return;
  el.textContent = msg || "";
}

// =======================
// Global state
// =======================
let tenantId = localStorage.getItem("tenantId") || "";
let currentRoundId = null;
let currentOptions = [];
let slotToOption = new Map(); // rank(1..5) -> optionId

// Tenant photo map (ensure these files exist in /public/tenants/)
const TENANT_PHOTOS = {
  "Andrew King": "/tenants/andrew.jpg",
  "Paul Morse": "/tenants/paul.jpg",
  "John Wainwright": "/tenants/john.jpg",
  "Joe Wainwright": "/tenants/joe.jpg",
  "Job Gregory": "/tenants/job.jpg",
  "JJ Greco": "/tenants/jj.jpg",
};

// =======================
// Tabs
// =======================
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });

  ["vote", "brackets", "personal", "madness", "compare", "raw"].forEach((t) => {
    const pane = $("tab-" + t);
    if (pane) pane.classList.toggle("hidden", t !== tabName);
  });

  // Optional: widen layout if you implemented body.mm-wide logic
  // document.body.classList.toggle("mm-wide", tabName === "madness");

  if (tabName === "vote") {
    refreshProgress();
  } else if (tabName === "brackets") {
    loadBrackets();
  } else if (tabName === "personal") {
    loadPersonalBracket();
  } else if (tabName === "madness") {
    loadMadness();
  } else if (tabName === "compare") {
    loadCompare();
  } else if (tabName === "raw") {
    loadRaw();
  }
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
}

// =======================
// Tenants
// =======================
async function loadTenants() {
  const sel = $("tenantSelect");
  const data = await api("/api/tenants", { headers: {} });

  sel.innerHTML = `<option value="">Select seat…</option>`;
  data.tenants.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.name;
    sel.appendChild(opt);
  });

  if (tenantId) sel.value = tenantId;
}

function bindTenantSelect() {
  const sel = $("tenantSelect");
  const btn = $("btnSetTenant");
  const status = $("tenantStatus");
  const msg = $("tenantMsg");

  sel.addEventListener("change", () => {
    setMsg(msg, "Seat selected. Click “Use this seat” to apply.");
  });

  btn.addEventListener("click", async () => {
    const chosen = sel.value || "";
    if (!chosen) {
      setMsg(msg, "Please choose a seat first.");
      return;
    }

    tenantId = chosen;
    localStorage.setItem("tenantId", tenantId);

    setMsg(msg, "✅ Seat applied.");
    if (status)
      status.textContent = `Seat: ${sel.options[sel.selectedIndex].textContent}`;

    // Reset vote state + load new round for this seat
    currentRoundId = null;
    currentOptions = [];
    slotToOption = new Map();
    renderVoteCards();

    await refreshProgress();
    await loadNext5();
  });
}

// =======================
// Vote flow
// =======================
async function refreshProgress() {
  const progressEl = $("progress");
  const msgEl = $("voteMsg");

  if (!tenantId) {
    setMsg(progressEl, "Select a seat to start ranking.");
    setMsg(msgEl, "");
    const btn = $("btnSubmit");
    if (btn) {
      btn.disabled = true;
      btn.classList.remove("ready");
    }
    return;
  }

  try {
    const p = await api("/api/progress");
    setMsg(
      progressEl,
      `${p.tenant.name}: ${p.remainingTo2x} options still need 2+ rankings`
    );
  } catch (e) {
    setMsg(progressEl, `Progress error: ${e.message}`);
  }

  if (!currentOptions.length) {
    await loadNext5();
  } else {
    validateRanks();
  }
}

async function loadNext5() {
  const msgEl = $("voteMsg");
  setMsg(msgEl, "");

  if (!tenantId) {
    setMsg(msgEl, "Select a seat first.");
    return;
  }

  try {
    const data = await api("/api/next");
    currentRoundId = data.roundId;
    currentOptions = data.options || [];
    slotToOption = new Map();
    renderVoteCards();
    validateRanks();
  } catch (e) {
    setMsg(msgEl, `Error loading options: ${e.message}`);
  }
}

// ---- Attendee parsing + render (NEW) ----
function normalizeAttendees(attendeesRaw) {
  // Returns Set of tenant names that attended.
  const s = new Set();

  if (attendeesRaw === true || attendeesRaw === "true") {
    Object.keys(TENANT_PHOTOS).forEach((n) => s.add(n));
    return s;
  }
  if (attendeesRaw === false || attendeesRaw === "false" || attendeesRaw == null) {
    return s;
  }

  // If already array of names
  if (Array.isArray(attendeesRaw)) {
    attendeesRaw.forEach((a) => a && s.add(String(a).trim()));
    return s;
  }

  // If string, try to parse common patterns:
  // "Andrew King, Paul Morse" OR "Andrew King|Paul Morse" OR JSON-like "[...]"
  const str = String(attendeesRaw).trim();

  // JSON array string?
  if (str.startsWith("[") && str.endsWith("]")) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) arr.forEach((a) => a && s.add(String(a).trim()));
      return s;
    } catch {
      /* ignore */
    }
  }

  // Split on comma or pipe
  str
    .split(/[,\|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((name) => s.add(name));

  return s;
}

function renderAttendees(attendeesRaw) {
  const attendees = normalizeAttendees(attendeesRaw);

  return `
    <div class="attendeeRow">
      ${Object.entries(TENANT_PHOTOS)
        .map(([name, photo]) => {
          const attended = attendees.has(name);
          return `
            <div class="attendee ${attended ? "yes" : "no"}" title="${escapeHtml(
              name
            )}">
              <img src="${photo}" alt="${escapeHtml(name)}" />
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderVoteCards() {
  const slotsEl = $("rankSlots");
  const poolEl = $("optionPool");
  if (!slotsEl || !poolEl) return;

  slotsEl.innerHTML = "";
  poolEl.innerHTML = "";

  // Rank slots (1..5)
  for (let rank = 1; rank <= 5; rank++) {
    const slot = document.createElement("div");
    slot.className = "slot";
    slot.dataset.rank = String(rank);
    slot.innerHTML = `
      <div class="slotLabel">#${rank}</div>
      <div class="slotBody muted">Drop here</div>
    `;

    slot.addEventListener("dragover", (e) => {
      e.preventDefault();
      slot.classList.add("over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("over"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      slot.classList.remove("over");
      const optionId = Number(e.dataTransfer.getData("text/optionId"));
      if (!optionId) return;
      placeOptionInSlot(optionId, rank);
    });

    // Double click clears
    slot.addEventListener("dblclick", () => clearSlot(rank));

    slotsEl.appendChild(slot);
  }

  // Pool cards
  currentOptions.forEach((o) => {
    const card = document.createElement("div");
    card.className = "option draggable";
    card.draggable = true;
    card.dataset.optionId = String(o.id);

    card.innerHTML = `
      <img src="${o.photoUrl}" alt="${escapeHtml(o.title)}" />
      <div class="pad">
        <div class="meta">
          <div>
            <div><strong>${escapeHtml(o.title)}</strong></div>
            <div class="muted small">${escapeHtml(o.month)} ${escapeHtml(
      o.year
    )} • ${escapeHtml(o.location)}</div>
          </div>
          <div class="badge">ranked ${o.timesRanked}×</div>
        </div>

        ${renderAttendees(o.Attendees)}

        <p class="muted small"><strong>Notes:</strong> ${escapeHtml(
          o.Additional_Notes
        )}</p>
      </div>
    `;

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/optionId", String(o.id));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    poolEl.appendChild(card);
  });

  renderSlotsAndPoolState();
}

function placeOptionInSlot(optionId, rank) {
  for (const [r, oid] of slotToOption.entries()) {
    if (oid === optionId) slotToOption.delete(r);
  }
  slotToOption.set(rank, optionId);
  renderSlotsAndPoolState();
  validateRanks();
}

function clearSlot(rank) {
  slotToOption.delete(rank);
  renderSlotsAndPoolState();
  validateRanks();
}

function renderSlotsAndPoolState() {
  const slots = Array.from(document.querySelectorAll(".slot"));
  const pool = $("optionPool");
  const cards = Array.from(pool.querySelectorAll(".draggable"));
  const cardById = new Map(cards.map((c) => [Number(c.dataset.optionId), c]));

  cards.forEach((c) => c.classList.remove("ghost"));

  slots.forEach((slot) => {
    const rank = Number(slot.dataset.rank);
    const body = slot.querySelector(".slotBody");
    const optionId = slotToOption.get(rank);

    body.innerHTML = "";

    if (!optionId) {
      body.textContent = "Drop here";
      body.classList.add("muted");
      return;
    }
    body.classList.remove("muted");

    const original = cardById.get(optionId);
    if (!original) {
      body.textContent = `Selected option #${optionId}`;
      return;
    }

    original.classList.add("ghost");

    const preview = original.cloneNode(true);
    preview.classList.add("slotPreview");
    preview.draggable = true;
    preview.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/optionId", String(optionId));
      e.dataTransfer.effectAllowed = "move";
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "miniBtn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => clearSlot(rank));

    const wrap = document.createElement("div");
    wrap.className = "slotWrap";
    wrap.appendChild(preview);
    wrap.appendChild(removeBtn);

    body.appendChild(wrap);
  });
}

function validateRanks() {
  const msg = $("voteMsg");
  const btn = $("btnSubmit");
  if (!btn) return;

  if (!tenantId) {
    btn.disabled = true;
    btn.classList.remove("ready");
    setMsg(msg, "Select a seat first.");
    return;
  }

  if (!currentRoundId || currentOptions.length !== 5) {
    btn.disabled = true;
    btn.classList.remove("ready");
    return;
  }

  if (slotToOption.size !== 5) {
    btn.disabled = true;
    btn.classList.remove("ready");
    setMsg(msg, "Drag all 5 options into rank slots (1–5).");
    return;
  }

  const vals = [...slotToOption.values()];
  if (new Set(vals).size !== 5) {
    btn.disabled = true;
    btn.classList.remove("ready");
    setMsg(msg, "Each slot must contain a different option.");
    return;
  }

  btn.disabled = false;
  btn.classList.add("ready");
  setMsg(msg, "Ready to submit.");
}

async function submitVote() {
  const msg = $("voteMsg");
  const btn = $("btnSubmit");
  if (!btn || btn.disabled) return;

  const payload = {
    roundId: currentRoundId,
    rankings: [1, 2, 3, 4, 5].map((rank) => ({
      optionId: slotToOption.get(rank),
      rank,
    })),
  };

  try {
    await api("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setMsg(msg, "Submitted! Loading next 5…");
    await loadNext5();
    await refreshProgress();
  } catch (e) {
    setMsg(msg, `Submit error: ${e.message}`);
  }
}

function bindVoteButtons() {
  $("btnNext")?.addEventListener("click", loadNext5);
  $("btnSubmit")?.addEventListener("click", submitVote);
}

// =======================
// Brackets tab (global)
// =======================
async function loadBrackets() {
  const wrap = $("bracketWrap");
  wrap.innerHTML = "Loading…";

  try {
    const data = await api("/api/brackets", { headers: {} });
    const regions = data?.regions;
    if (!Array.isArray(regions)) {
      wrap.innerHTML = `<div class="muted">Unexpected response.</div>`;
      return;
    }

    wrap.innerHTML = `
      <div class="madnessGrid">
        ${regions
          .map(
            (r) => `
          <div class="madnessRegion">
            <div class="madnessTitle">${escapeHtml(r.name)}</div>
            <div class="madnessRoundLabel muted small">Seeds 1–16</div>
            <div class="games">
              ${(r.teams || [])
                .slice()
                .sort((a, b) => a.seed - b.seed)
                .map(
                  (t) => `
                    <div class="game">
                      <div class="teamLine">
                        <span class="seed">#${t.seed}</span>
                        <span class="teamName">${escapeHtml(t.title)}</span>
                        <span class="meta muted small">${escapeHtml(t.month)} ${escapeHtml(
                    t.year
                  )} • ${escapeHtml(t.location)}</span>
                      </div>
                    </div>
                  `
                )
                .join("")}
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

// =======================
// Personal Bracket tab
// =======================
async function loadPersonalBracket() {
  const wrap = $("personalWrap");
  if (!tenantId) {
    wrap.innerHTML = `<div class="muted">Select a seat to view your personal bracket.</div>`;
    return;
  }

  wrap.innerHTML = "Loading…";

  try {
    const data = await api("/api/personal-bracket");
    const regions = data?.regions;
    if (!Array.isArray(regions)) {
      wrap.innerHTML = `<div class="muted">Unexpected response.</div>`;
      return;
    }

    wrap.innerHTML = `
      <div class="row space" style="margin:0 0 10px 0;">
        <div class="muted small">Seat: <strong>${escapeHtml(
          data.tenant?.name
        )}</strong></div>
        <div class="muted small">Based only on this seat’s submissions</div>
      </div>

      <div class="madnessGrid">
        ${regions
          .map(
            (r) => `
          <div class="madnessRegion">
            <div class="madnessTitle">${escapeHtml(r.name)}</div>
            <div class="madnessRoundLabel muted small">Seeds 1–16</div>
            <div class="games">
              ${(r.teams || [])
                .slice()
                .sort((a, b) => a.seed - b.seed)
                .map(
                  (t) => `
                  <div class="game">
                    <div class="teamLine">
                      <span class="seed">#${t.seed}</span>
                      <span class="teamName">${escapeHtml(t.title)}</span>
                      <span class="meta muted small">${escapeHtml(t.month)} ${escapeHtml(
                    t.year
                  )} • ${escapeHtml(t.location)} • votes: ${t.votes || 0} • avg rank: ${
                    t.avgRank ? Number(t.avgRank).toFixed(2) : "—"
                  }</span>
                    </div>
                  </div>
                `
                )
                .join("")}
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

// =======================
// Raw votes tab
// =======================
async function loadRaw() {
  const wrap = $("rawTableWrap");
  const filter = ($("rawFilter")?.value || "").trim().toLowerCase();
  if (!wrap) return;

  wrap.innerHTML = "Loading…";

  try {
    const data = await api("/api/raw", { headers: {} });
    let rows = data?.rows || [];

    if (filter) {
      rows = rows.filter(
        (r) =>
          String(r.tenant_name || "").toLowerCase().includes(filter) ||
          String(r.option_title || "").toLowerCase().includes(filter)
      );
    }

    if (!rows.length) {
      wrap.innerHTML = `<div class="muted">No rows match.</div>`;
      return;
    }

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Option</th>
            <th>Rank</th>
            <th>Round</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.created_at)}</td>
              <td>${escapeHtml(r.tenant_name)}</td>
              <td>${escapeHtml(r.option_title)}</td>
              <td>${r.rank}</td>
              <td>${escapeHtml(r.round_id)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

// =======================================================
// MARCH MADNESS FULL INTERACTIVE BRACKET
// =======================================================
let mmState = null;

const FIRST_ROUND_PAIRS = [
  [1, 16],
  [8, 9],
  [5, 12],
  [4, 13],
  [6, 11],
  [3, 14],
  [7, 10],
  [2, 15],
];

function buildRegionRounds(region) {
  const bySeed = new Map((region.teams || []).map((t) => [t.seed, t]));

  const r64 = FIRST_ROUND_PAIRS.map(([a, b], i) => ({
    id: `${region.name}-r64-${i}`,
    a: bySeed.get(a) || null,
    b: bySeed.get(b) || null,
    winnerId: null,
    type: "r64",
  }));

  const r32 = [0, 1, 2, 3].map((i) => ({
    id: `${region.name}-r32-${i}`,
    aGame: `${region.name}-r64-${i * 2}`,
    bGame: `${region.name}-r64-${i * 2 + 1}`,
    winnerId: null,
    type: "r32",
  }));

  const s16 = [0, 1].map((i) => ({
    id: `${region.name}-s16-${i}`,
    aGame: `${region.name}-r32-${i * 2}`,
    bGame: `${region.name}-r32-${i * 2 + 1}`,
    winnerId: null,
    type: "s16",
  }));

  const e8 = [
    {
      id: `${region.name}-e8-0`,
      aGame: `${region.name}-s16-0`,
      bGame: `${region.name}-s16-1`,
      winnerId: null,
      type: "e8",
    },
  ];

  return { r64, r32, s16, e8 };
}

function getWinnerTeam(gameId) {
  const g = mmState.games[gameId];
  if (!g) return null;

  if (g.type === "r64") {
    if (g.winnerId && g.a && g.winnerId === g.a.id) return g.a;
    if (g.winnerId && g.b && g.winnerId === g.b.id) return g.b;
    return null;
  }
  return g.winnerId ? mmState.teamsById.get(g.winnerId) : null;
}

function getGameTeams(gameId) {
  const g = mmState.games[gameId];
  if (!g) return { a: null, b: null };

  if (g.type === "r64") return { a: g.a, b: g.b };

  const aTeam = g.aGame ? getWinnerTeam(g.aGame) : null;
  const bTeam = g.bGame ? getWinnerTeam(g.bGame) : null;
  return { a: aTeam, b: bTeam };
}

function clearDownstream(fromGameId) {
  const deps = mmState.dependents[fromGameId] || [];
  deps.forEach((depId) => {
    const dep = mmState.games[depId];
    if (dep) dep.winnerId = null;
    clearDownstream(depId);
  });
}

function persistMadness() {
  try {
    const snapshot = {};
    Object.entries(mmState.games).forEach(([id, g]) => {
      snapshot[id] = g.winnerId || null;
    });
    localStorage.setItem("mmState", JSON.stringify(snapshot));
  } catch {}
}

function restoreMadness() {
  try {
    const raw = localStorage.getItem("mmState");
    if (!raw) return;
    const snapshot = JSON.parse(raw);
    Object.entries(snapshot).forEach(([id, winnerId]) => {
      if (mmState.games[id]) mmState.games[id].winnerId = winnerId;
    });
  } catch {}
}

// ---- Undo stack (already used) ----
function snapshotMadness() {
  const snap = {};
  Object.entries(mmState.games).forEach(([id, g]) => {
    snap[id] = g.winnerId || null;
  });
  return snap;
}

function applyMadnessSnapshot(snap) {
  Object.entries(snap || {}).forEach(([id, winnerId]) => {
    if (mmState.games[id]) mmState.games[id].winnerId = winnerId;
  });
}

function getUndoStack() {
  try {
    return JSON.parse(localStorage.getItem("mmUndo") || "[]");
  } catch {
    return [];
  }
}

function setUndoStack(stack) {
  localStorage.setItem("mmUndo", JSON.stringify(stack || []));
}

function pushUndoSnapshot() {
  const stack = getUndoStack();
  stack.push(snapshotMadness());
  if (stack.length > 50) stack.shift();
  setUndoStack(stack);
}

function undoMadness() {
  if (!mmState) return;
  const stack = getUndoStack();
  const last = stack.pop();
  setUndoStack(stack);

  if (!last) return;

  Object.keys(mmState.games).forEach((id) => (mmState.games[id].winnerId = null));
  applyMadnessSnapshot(last);

  persistMadness();
  renderMadness();
}

function pickWinner(gameId, teamId) {
  const g = mmState.games[gameId];
  if (!g) return;

  const { a, b } = getGameTeams(gameId);
  const valid = (a && a.id === teamId) || (b && b.id === teamId);
  if (!valid) return;

  pushUndoSnapshot();

  if (g.winnerId === teamId) {
    g.winnerId = null;
    clearDownstream(gameId);
  } else {
    g.winnerId = teamId;
    clearDownstream(gameId);
  }

  persistMadness();
  renderMadness();
}

function renderGameButton(gameId, team) {
  const g = mmState.games[gameId];
  const picked = g?.winnerId && team && g.winnerId === team.id;
  const disabled = !team;

  return `
    <button class="mmTeam ${picked ? "picked" : ""}"
      ${disabled ? "disabled" : ""}
      data-game="${gameId}" data-team="${team ? team.id : ""}">
      <span class="mmSeedPill">${team ? team.seed : ""}</span>
      <span class="mmTeamName">${escapeHtml(team ? team.title : "TBD")}</span>
    </button>
  `;
}

function renderRound(roundTitle, gameIds) {
  return `
    <div class="mmRound">
      <div class="mmRoundTitle muted small">${escapeHtml(roundTitle)}</div>
      <div class="mmGames">
        ${gameIds
          .map((id) => {
            const { a, b } = getGameTeams(id);
            return `
              <div class="mmGame">
                ${renderGameButton(id, a)}
                ${renderGameButton(id, b)}
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

async function loadMadness() {
  const wrap = $("madnessWrap");
  if (!wrap) return;
  wrap.innerHTML = "Loading…";

  const data = await api("/api/brackets", { headers: {} });
  const regions = data?.regions;
  if (!Array.isArray(regions)) {
    wrap.innerHTML = `<div class="muted">Unexpected response.</div>`;
    return;
  }

  const teamsById = new Map();
  regions.forEach((r) => (r.teams || []).forEach((t) => teamsById.set(t.id, t)));

  const games = {};
  const dependents = {};

  function addDep(from, to) {
    if (!dependents[from]) dependents[from] = [];
    dependents[from].push(to);
  }

  const regionBlocks = regions.map((r) => {
    const rounds = buildRegionRounds(r);

    rounds.r64.forEach((g) => (games[g.id] = g));
    rounds.r32.forEach((g) => {
      games[g.id] = g;
      addDep(g.aGame, g.id);
      addDep(g.bGame, g.id);
    });
    rounds.s16.forEach((g) => {
      games[g.id] = g;
      addDep(g.aGame, g.id);
      addDep(g.bGame, g.id);
    });
    rounds.e8.forEach((g) => {
      games[g.id] = g;
      addDep(g.aGame, g.id);
      addDep(g.bGame, g.id);
    });

    return { name: r.name, rounds };
  });

  const e8Winners = regionBlocks.map((rb) => rb.rounds.e8[0].id);

  games["ff-0"] = {
    id: "ff-0",
    type: "ff",
    aGame: e8Winners[0],
    bGame: e8Winners[1],
    winnerId: null,
  };
  games["ff-1"] = {
    id: "ff-1",
    type: "ff",
    aGame: e8Winners[2],
    bGame: e8Winners[3],
    winnerId: null,
  };
  addDep(e8Winners[0], "ff-0");
  addDep(e8Winners[1], "ff-0");
  addDep(e8Winners[2], "ff-1");
  addDep(e8Winners[3], "ff-1");

  games["final-0"] = {
    id: "final-0",
    type: "final",
    aGame: "ff-0",
    bGame: "ff-1",
    winnerId: null,
  };
  addDep("ff-0", "final-0");
  addDep("ff-1", "final-0");

  mmState = { regionBlocks, games, dependents, teamsById };

  restoreMadness();
  renderMadness();
}

function renderMadness() {
  const wrap = $("madnessWrap");
  if (!wrap || !mmState) return;

  const blocks = mmState.regionBlocks;
  const leftTop = blocks[0];
  const leftBottom = blocks[1];
  const rightTop = blocks[2];
  const rightBottom = blocks[3];

  function regionHtml(rb, side) {
    const r64Ids = rb.rounds.r64.map((g) => g.id);
    const r32Ids = rb.rounds.r32.map((g) => g.id);
    const s16Ids = rb.rounds.s16.map((g) => g.id);
    const e8Ids = rb.rounds.e8.map((g) => g.id);

    const roundsClass = side === "right" ? "mmRegionRounds right" : "mmRegionRounds";

    return `
      <div class="mmRegionShell">
        <div class="mmRegionHeader">
          <div class="mmRegionName">${escapeHtml(rb.name)}</div>
          <div class="mmRegionHint">1–16 seeds</div>
        </div>

        <div class="${roundsClass}">
          ${renderRound("Round 1", r64Ids)}
          ${renderRound("Round 2", r32Ids)}
          ${renderRound("Sweet 16", s16Ids)}
          ${renderRound("Elite 8", e8Ids)}
        </div>
      </div>
    `;
  }

  const champion = getWinnerTeam("final-0");
  const championLabel = champion ? `#${champion.seed} ${champion.title}` : "—";

  wrap.innerHTML = `
    <div class="mmBracketBoard">
      <div class="mmSideCol">
        ${regionHtml(leftTop, "left")}
        ${regionHtml(leftBottom, "left")}
      </div>

      <div class="mmCenter">
        <div class="mmCenterHeader">
          <div class="mmCenterTitle">Final Four</div>
          <div class="mmRegionHint">Click to advance</div>
        </div>

        <div class="mmCenterGrid">
          ${renderRound("National Semifinal", ["ff-0"])}
          ${renderRound("National Semifinal", ["ff-1"])}
          ${renderRound("National Championship", ["final-0"])}
        </div>

        <div class="mmChampion">
          <div class="mmChampionLabel">Champion</div>
          <div class="mmChampionName">${escapeHtml(championLabel)}</div>
        </div>
      </div>

      <div class="mmSideCol">
        ${regionHtml(rightTop, "right")}
        ${regionHtml(rightBottom, "right")}
      </div>
    </div>
  `;

  wrap.querySelectorAll(".mmTeam").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gameId = btn.dataset.game;
      const teamId = Number(btn.dataset.team);
      if (!teamId) return;
      pickWinner(gameId, teamId);
    });
  });
}

// =======================
// Compare tab
// =======================
async function loadCompare() {
  const wrap = $("compareWrap");
  if (!wrap) return;

  if (!tenantId) {
    wrap.innerHTML = `<div class="muted">Select a seat first.</div>`;
    return;
  }

  wrap.innerHTML = "Loading…";

  try {
    const data = await api("/api/compare", { headers: {} });
    const tenants = data.tenants || [];
    const options = data.options || [];
    const ranksByTenant = data.ranksByTenant || {};

    const me = tenants.find((t) => String(t.id) === String(tenantId));
    if (!me) {
      wrap.innerHTML = `<div class="muted">Selected seat not found.</div>`;
      return;
    }

    const filter = ($("compareFilter")?.value || "").trim().toLowerCase();
    const sortMode = $("compareSort")?.value || "mine";
    const topN = Number($("compareTop")?.value || 64);

    const otherTenants = tenants.filter((t) => String(t.id) !== String(tenantId));

    let rows = options.map((o) => {
      const myRank = ranksByTenant[String(tenantId)]?.[o.id] ?? null;

      const others = otherTenants
        .map((t) => ranksByTenant[String(t.id)]?.[o.id])
        .filter((x) => typeof x === "number");

      const avgOther = others.length
        ? others.reduce((a, b) => a + b, 0) / others.length
        : null;

      const delta = myRank && avgOther ? avgOther - myRank : null;

      return { id: o.id, title: o.title, myRank, avgOther, delta };
    });

    if (filter) rows = rows.filter((r) => String(r.title).toLowerCase().includes(filter));

    rows.sort((a, b) => {
      if (sortMode === "delta") return (b.delta ?? -999) - (a.delta ?? -999);
      if (sortMode === "avg") return (a.avgOther ?? 999) - (b.avgOther ?? 999);
      return (a.myRank ?? 999) - (b.myRank ?? 999);
    });

    rows = rows.slice(0, topN);

    const headerCols = otherTenants.map((t) => `<th>${escapeHtml(t.name)}</th>`).join("");

    wrap.innerHTML = `
      <div class="muted small" style="margin-bottom:10px;">
        <strong>Me:</strong> ${escapeHtml(me.name)} •
        <strong>Others:</strong> ${otherTenants.length}
      </div>

      <div class="compareTableWrap">
        <table class="compareTable">
          <thead>
            <tr>
              <th>Option</th>
              <th>My Rank</th>
              <th>Avg (Others)</th>
              <th>Δ (Others - Me)</th>
              ${headerCols}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const delta = r.delta;
                const deltaClass =
                  delta == null
                    ? ""
                    : delta >= 10
                    ? "deltaBig"
                    : delta >= 4
                    ? "deltaPos"
                    : delta <= -10
                    ? "deltaBigNeg"
                    : delta <= -4
                    ? "deltaNeg"
                    : "deltaFlat";

                const perCols = otherTenants
                  .map((t) => {
                    const v = ranksByTenant[String(t.id)]?.[r.id] ?? null;
                    return `<td class="num">${v ?? "—"}</td>`;
                  })
                  .join("");

                return `
                  <tr>
                    <td class="titleCell">${escapeHtml(r.title)}</td>
                    <td class="num strong">${r.myRank ?? "—"}</td>
                    <td class="num">${r.avgOther ? r.avgOther.toFixed(1) : "—"}</td>
                    <td class="num ${deltaClass}">${delta ? delta.toFixed(1) : "—"}</td>
                    ${perCols}
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

// =======================
// Init
// =======================
document.addEventListener("DOMContentLoaded", async () => {
  bindTabs();
  bindTenantSelect();
  bindVoteButtons();

  await loadTenants();
  if (tenantId) await refreshProgress();

  // Raw
  $("btnRefreshRaw")?.addEventListener("click", loadRaw);
  $("rawFilter")?.addEventListener("input", loadRaw);

  // Madness: full reset refresh + undo
  $("btnRefreshMadness")?.addEventListener("click", () => {
    localStorage.removeItem("mmState");
    localStorage.removeItem("mmUndo");
    loadMadness();
  });
  $("btnUndoMadness")?.addEventListener("click", undoMadness);

  // Compare
  $("btnRefreshCompare")?.addEventListener("click", loadCompare);
  $("compareFilter")?.addEventListener("input", loadCompare);
  $("compareSort")?.addEventListener("change", loadCompare);
  $("compareTop")?.addEventListener("change", loadCompare);

  // Default tab: vote
  switchTab("vote");
});
