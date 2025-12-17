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


// Burger Club attendance cache (from /api/burger-club)
const TENANT_FIELD_TO_NAME = {
  paul: "Paul Morse",
  job: "Job Gregory",
  john: "John Wainwright",
  andrew: "Andrew King",
  jj: "JJ Greco",
  joe: "Joe Wainwright",
};

let burgerClubAttendanceById = new Map(); // id -> Set(fullName)
let burgerClubAttendanceLoadedAt = 0;

function computeAttendanceSetFromBurgerClubRow(row) {
  const s = new Set();
  if (!row) return s;

  for (const [field, fullName] of Object.entries(TENANT_FIELD_TO_NAME)) {
    if (row[field] === true || row[field] === 1 || row[field] === "1" || row[field] === "true") {
      s.add(fullName);
    }
  }
  return s;
}

// Fetch and cache attendance from Burger Club DB (refreshes at most every 60s)
async function ensureBurgerClubAttendanceFresh(force = false) {
  const now = Date.now();
  if (!force && burgerClubAttendanceLoadedAt && now - burgerClubAttendanceLoadedAt < 60_000) return;

  try {
    const data = await api("/api/burger-club", { headers: {} });
    const rows = (data && data.rows) ? data.rows : [];
    const m = new Map();

    rows.forEach((r) => {
      if (r && r.id != null) m.set(Number(r.id), computeAttendanceSetFromBurgerClubRow(r));
    });

    burgerClubAttendanceById = m;
    burgerClubAttendanceLoadedAt = now;
  } catch {
    // Non-fatal: keep existing cache (vote UI will fall back to option-provided Attendees)
  }
}

function overlayAttendanceOntoOptions(options) {
  if (!Array.isArray(options)) return;

  options.forEach((o) => {
    const id = Number(o && o.id);
    if (!Number.isFinite(id)) return;

    const attendeesFromDb = burgerClubAttendanceById.get(id);
    if (attendeesFromDb && attendeesFromDb.size) {
      // renderAttendees() can handle arrays/strings; normalizeAttendees() will turn it into a Set.
      o.Attendees = Array.from(attendeesFromDb);
    } else if (attendeesFromDb && attendeesFromDb.size === 0) {
      // Explicitly set to empty so everyone stays greyed out.
      o.Attendees = [];
    }
  });
}

// =======================
// Tabs
// =======================
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });

  ["vote", "brackets", "personal", "madness", "compare", "raw", "tracker"].forEach(
    (t) => {
      const pane = $("tab-" + t);
      if (pane) pane.classList.toggle("hidden", t !== tabName);
    }
  );

  // Optional: widen layout if you implemented body.mm-wide logic
  // document.body.classList.toggle("mm-wide", tabName === "madness");

  if (tabName === "vote") refreshProgress();
  else if (tabName === "brackets") loadBrackets();
  else if (tabName === "personal") loadPersonalBracket();
  else if (tabName === "madness") loadMadness();
  else if (tabName === "raw") loadRaw();
  else if (tabName === "compare") loadCompare();
  else if (tabName === "tracker") loadBurgerClub();
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

  sel?.addEventListener("change", () => {
    setMsg(msg, "Seat selected. Click “Use this seat” to apply.");
  });

  btn?.addEventListener("click", async () => {
    const chosen = sel?.value || "";
    if (!chosen) {
      setMsg(msg, "Please choose a seat first.");
      return;
    }

    tenantId = chosen;
    localStorage.setItem("tenantId", tenantId);

    setMsg(msg, "✅ Seat applied.");
    if (status && sel)
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

    // Pull Burger Club attendance and light up tenant photos accordingly
    await ensureBurgerClubAttendanceFresh();
    overlayAttendanceOntoOptions(currentOptions);

    slotToOption = new Map();
    renderVoteCards();
    validateRanks();
  } catch (e) {
    setMsg(msgEl, `Error loading options: ${e.message}`);
  }
}

// ---- Attendee parsing + render ----
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

  if (Array.isArray(attendeesRaw)) {
    attendeesRaw.forEach((a) => a && s.add(String(a).trim()));
    return s;
  }

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
    const tenantSel = $("tenantSelect");
    const currentTenantName = tenantSel && tenantSel.value ? tenantSel.options[tenantSel.selectedIndex].textContent : null;

    const attendeesSet = normalizeAttendees(o.Attendees);
    const attendedBySelectedTenant = currentTenantName ? attendeesSet.has(currentTenantName) : false;

    const idNum = Number(o.id);
    const dbAttendanceKnown = burgerClubAttendanceById && burgerClubAttendanceById.has(idNum);
    const absentBySelectedTenant = dbAttendanceKnown && currentTenantName ? !attendeesSet.has(currentTenantName) : false;

    const card = document.createElement("div");
    card.className = "option draggable" + (attendedBySelectedTenant ? " attended" : "") + (absentBySelectedTenant ? " absent" : "");
    card.draggable = true;
    card.dataset.optionId = String(o.id);

    card.innerHTML = `
      ${attendedBySelectedTenant ? '<div class="attendedFlag"><img src="/tenants/burger.png" alt="Burger" class="attendedIcon" /><span>Attended</span></div>' : ''}
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
  if (!pool) return;

  const cards = Array.from(pool.querySelectorAll(".draggable"));
  const cardById = new Map(cards.map((c) => [Number(c.dataset.optionId), c]));

  cards.forEach((c) => c.classList.remove("ghost"));

  slots.forEach((slot) => {
    const rank = Number(slot.dataset.rank);
    const body = slot.querySelector(".slotBody");
    const optionId = slotToOption.get(rank);

    if (!body) return;
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
  if (!wrap) return;
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
  if (!wrap) return;

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
      <div style="margin-bottom:10px; display:flex; gap:8px; align-items:center;">
        <button id="btnDeleteMine" class="miniBtn">Delete my submissions</button>
        <button id="btnRefreshRawLocal" class="miniBtn">Refresh</button>
        <div class="muted small" style="margin-left:auto">Showing ${rows.length} rows</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Option</th>
            <th>Rank</th>
            <th>Round</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => {
                const canDelete = tenantId && String(r.tenant_id) === String(tenantId);
                return `
            <tr>
              <td>${escapeHtml(r.created_at)}</td>
              <td>${escapeHtml(r.tenant_name)}</td>
              <td>${escapeHtml(r.option_title)}</td>
              <td>${r.rank}</td>
              <td>${escapeHtml(r.round_id)}</td>
              <td>${canDelete ? `<button class="miniBtn" data-delete-vote="${r.vote_id}">Delete</button>` : ""}</td>
            </tr>
          `
              }
            )
            .join("")}
        </tbody>
      </table>
    `;

    // bind buttons
    $("btnRefreshRawLocal")?.addEventListener("click", loadRaw);

    $("btnDeleteMine")?.addEventListener("click", async () => {
      if (!tenantId) {
        setMsg($("voteMsg"), "Select a seat first.");
        return;
      }
      if (!confirm("Delete ALL your submissions? This cannot be undone.")) return;
      try {
        await api("/api/votes", { method: "DELETE" });
        await loadRaw();
        await refreshProgress();
        setMsg($("voteMsg"), "Deleted your submissions.");
      } catch (e) {
        setMsg($("voteMsg"), `Delete failed: ${e.message}`);
      }
    });

    wrap.querySelectorAll("[data-delete-vote]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.deleteVote;
        if (!id) return;
        if (!confirm(`Delete vote #${id}? This cannot be undone.`)) return;
        try {
          await api(`/api/vote/${id}`, { method: "DELETE" });
          await loadRaw();
          await refreshProgress();
          setMsg($("voteMsg"), `Deleted vote #${id}`);
        } catch (e) {
          setMsg($("voteMsg"), `Delete failed: ${e.message}`);
        }
      });
    });
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

// ---- Undo stack ----
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
// Burger Club Tracker (CRUD + Sorting)
// =======================
let bcEditingId = null;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Persisted sort state for the tracker table
let burgerSort = loadBurgerSort();

function loadBurgerSort() {
  try {
    const raw = localStorage.getItem("burgerSort");
    if (!raw) return { key: "id", dir: "asc" };
    const obj = JSON.parse(raw);
    const key = String(obj?.key || "id");
    const dir = obj?.dir === "desc" ? "desc" : "asc";
    return { key, dir };
  } catch {
    return { key: "id", dir: "asc" };
  }
}

function persistBurgerSort() {
  try {
    localStorage.setItem("burgerSort", JSON.stringify(burgerSort));
  } catch {}
}

function monthIndex(m) {
  const i = MONTHS.indexOf(String(m || ""));
  return i >= 0 ? i : 999;
}

function sortBurgerRows(rows) {
  const { key, dir } = burgerSort;
  const mul = dir === "asc" ? 1 : -1;

  const norm = (v) => (v == null ? "" : v);

  return rows.slice().sort((a, b) => {
    // Special month handling (calendar order)
    if (key === "month") {
      return (monthIndex(a.month) - monthIndex(b.month)) * mul;
    }

    const av = a[key];
    const bv = b[key];

    // numbers
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;

    // booleans
    if (typeof av === "boolean" || typeof bv === "boolean") {
      const an = av ? 1 : 0;
      const bn = bv ? 1 : 0;
      return (an - bn) * mul;
    }

    // common 0/1 ints
    if ((av === 0 || av === 1) && (bv === 0 || bv === 1)) return (av - bv) * mul;

    // string fallback
    return String(norm(av)).localeCompare(String(norm(bv))) * mul;
  });
}

function sortIndicator(key) {
  if (burgerSort.key !== key) return "";
  return burgerSort.dir === "asc" ? " ▲" : " ▼";
}

function openBurgerModal(mode, row) {
  const modal = $("burgerModal");
  const title = $("burgerModalTitle");
  const hint = $("burgerEditHint");
  const btnDel = $("btnDeleteBurger");

  bcEditingId = mode === "edit" ? row.id : null;

  // populate selects
  const yearSel = $("bcYear");
  const monthSel = $("bcMonth");
  if (yearSel && !yearSel.children.length) {
    for (let y = 2019; y <= 2026; y++) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      yearSel.appendChild(o);
    }
  }
  if (monthSel && !monthSel.children.length) {
    MONTHS.forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      monthSel.appendChild(o);
    });
  }

  // fill values
  $("bcYear").value = String(row?.year ?? new Date().getFullYear());
  $("bcMonth").value = String(row?.month ?? MONTHS[new Date().getMonth()]);
  $("bcRestaurant").value = row?.restaurant ?? "";
  $("bcLocation").value = row?.location ?? "";
  $("bcBorough").value = row?.borough ?? "Manhattan";

  $("bcPaul").checked = !!row?.paul;
  $("bcJob").checked = !!row?.job;
  $("bcJohn").checked = !!row?.john;
  $("bcAndrew").checked = !!row?.andrew;
  $("bcJJ").checked = !!row?.jj;
  $("bcJoe").checked = !!row?.joe;

  if (title) title.textContent = mode === "edit" ? `Edit Record #${row.id}` : "New Record";
  if (hint) hint.textContent = mode === "edit" ? `Editing record #${row.id}` : "Creating a new record";
  btnDel?.classList.toggle("hidden", mode !== "edit");

  modal?.classList.remove("hidden");
}

function closeBurgerModal() {
  $("burgerModal")?.classList.add("hidden");
  bcEditingId = null;
}

function burgerPayloadFromForm() {
  return {
    year: Number($("bcYear").value),
    month: $("bcMonth").value,
    restaurant: $("bcRestaurant").value.trim(),
    location: $("bcLocation").value.trim(),
    borough: $("bcBorough").value,
    // rating fixed server-side
    paul: $("bcPaul").checked,
    job: $("bcJob").checked,
    john: $("bcJohn").checked,
    andrew: $("bcAndrew").checked,
    jj: $("bcJJ").checked,
    joe: $("bcJoe").checked,
  };
}

async function loadBurgerClub() {
  const wrap = $("burgerTableWrap");
  const msg = $("burgerMsg");
  if (!wrap) return;

  wrap.innerHTML = "Loading…";
  setMsg(msg, "");

  try {
    const data = await api("/api/burger-club", { headers: {} });
    let rows = data.rows || [];

    if (!rows.length) {
      wrap.innerHTML = `<div class="muted">No records yet. Click “+ New”.</div>`;
      return;
    }

    rows = sortBurgerRows(rows);

    const yesNo = (v) => (v ? "✅" : "—");

    wrap.innerHTML = `
      <table class="trackerTable">
        <thead>
          <tr>
            <th data-sort="id">#${sortIndicator("id")}</th>
            <th data-sort="year">Year${sortIndicator("year")}</th>
            <th data-sort="month">Month${sortIndicator("month")}</th>
            <th data-sort="restaurant">Restaurant${sortIndicator("restaurant")}</th>
            <th data-sort="location">Location${sortIndicator("location")}</th>
            <th data-sort="borough">Borough${sortIndicator("borough")}</th>
            <th>Rating</th>
            <th data-sort="paul">Paul${sortIndicator("paul")}</th>
            <th data-sort="job">Job${sortIndicator("job")}</th>
            <th data-sort="john">John${sortIndicator("john")}</th>
            <th data-sort="andrew">Andrew${sortIndicator("andrew")}</th>
            <th data-sort="jj">JJ${sortIndicator("jj")}</th>
            <th data-sort="joe">Joe${sortIndicator("joe")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td class="num strong">${r.id}</td>
              <td class="num">${r.year}</td>
              <td>${escapeHtml(r.month)}</td>
              <td>${escapeHtml(r.restaurant)}</td>
              <td>${escapeHtml(r.location)}</td>
              <td>${escapeHtml(r.borough)}</td>
              <td>${escapeHtml(r.rating)}</td>
              <td class="num">${yesNo(r.paul)}</td>
              <td class="num">${yesNo(r.job)}</td>
              <td class="num">${yesNo(r.john)}</td>
              <td class="num">${yesNo(r.andrew)}</td>
              <td class="num">${yesNo(r.jj)}</td>
              <td class="num">${yesNo(r.joe)}</td>
              <td class="num">
                <button class="miniBtn" data-edit="${r.id}">Edit</button>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;

    // Bind edit buttons
    wrap.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.edit);
        const row = rows.find((x) => x.id === id);
        if (row) openBurgerModal("edit", row);
      });
    });

    // Bind sortable headers
    wrap.querySelectorAll("th[data-sort]").forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (!key) return;

        if (burgerSort.key === key) {
          burgerSort.dir = burgerSort.dir === "asc" ? "desc" : "asc";
        } else {
          burgerSort.key = key;
          burgerSort.dir = "asc";
        }

        persistBurgerSort();
        loadBurgerClub(); // re-render sorted
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

async function saveBurgerClub() {
  const msg = $("burgerMsg");
  setMsg(msg, "");

  const payload = burgerPayloadFromForm();

  try {
    if (bcEditingId) {
      await api(`/api/burger-club/${bcEditingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg(msg, `✅ Updated record #${bcEditingId}`);
    } else {
      const out = await api(`/api/burger-club`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg(msg, `✅ Created record #${out?.row?.id ?? ""}`.trim());
    }

    burgerClubAttendanceLoadedAt = 0;
    closeBurgerModal();
    await loadBurgerClub();
  } catch (e) {
    setMsg(msg, `Save failed: ${e.message}`);
  }
}

async function deleteBurgerClub() {
  const msg = $("burgerMsg");
  if (!bcEditingId) return;

  if (!confirm(`Delete record #${bcEditingId}?`)) return;

  try {
    await api(`/api/burger-club/${bcEditingId}`, {
      method: "DELETE",
      headers: {},
    });
    setMsg(msg, `🗑️ Deleted record #${bcEditingId}`);
    burgerClubAttendanceLoadedAt = 0;
    closeBurgerModal();
    await loadBurgerClub();
  } catch (e) {
    setMsg(msg, `Delete failed: ${e.message}`);
  }
}

function bindBurgerClub() {
  $("btnRefreshBurger")?.addEventListener("click", loadBurgerClub);
  $("btnNewBurger")?.addEventListener("click", () => openBurgerModal("new", null));
  $("btnCloseBurgerModal")?.addEventListener("click", closeBurgerModal);
  $("btnSaveBurger")?.addEventListener("click", saveBurgerClub);
  $("btnDeleteBurger")?.addEventListener("click", deleteBurgerClub);

  // click outside modal card closes
  $("burgerModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "burgerModal") closeBurgerModal();
  });
}

// =======================
// Init
// =======================
document.addEventListener("DOMContentLoaded", async () => {
  bindTabs();
  bindTenantSelect();
  bindVoteButtons();
  bindBurgerClub();

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