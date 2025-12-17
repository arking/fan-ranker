const express = require("express");
const path = require("path");
const fs = require("fs");
const { nanoid } = require("nanoid");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "app.db");
const OPTIONS_PATH = path.join(__dirname, "data", "options.json");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --- Schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  month TEXT NOT NULL,
  year INTEGER NOT NULL,
  location TEXT NOT NULL,
  photo_url TEXT NOT NULL,
  additional_notes TEXT NOT NULL,
  attendees TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  option_id INTEGER NOT NULL,
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 5),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id),
  FOREIGN KEY(option_id) REFERENCES options(id)
);
CREATE INDEX IF NOT EXISTS idx_votes_tenant_option ON votes(tenant_id, option_id);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at);
`);

// --- Migrate votes table to add weight column if missing ---
try {
  const cols = db.prepare("PRAGMA table_info(votes)").all();
  if (!cols.find((c) => c.name === "weight")) {
    db.prepare("ALTER TABLE votes ADD COLUMN weight REAL NOT NULL DEFAULT 1").run();
    console.log("Migrated: added votes.weight column");
  }
} catch (err) {
  console.warn("Could not ensure votes.weight column:", err.message);
}
// --- Burger Club Tracker table ---
db.exec(`
CREATE TABLE IF NOT EXISTS burger_club (
  id INTEGER PRIMARY KEY AUTOINCREMENT,       -- this is your # (1,2,3...)
  year INTEGER NOT NULL CHECK(year BETWEEN 2019 AND 2026),
  month TEXT NOT NULL,
  restaurant TEXT NOT NULL,
  location TEXT NOT NULL,
  borough TEXT NOT NULL CHECK(borough IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island','Other')),
  rating TEXT NOT NULL DEFAULT 'Best Burger Ever',

  paul INTEGER NOT NULL DEFAULT 0 CHECK(paul IN (0,1)),
  job  INTEGER NOT NULL DEFAULT 0 CHECK(job  IN (0,1)),
  john INTEGER NOT NULL DEFAULT 0 CHECK(john IN (0,1)),
  andrew INTEGER NOT NULL DEFAULT 0 CHECK(andrew IN (0,1)),
  jj   INTEGER NOT NULL DEFAULT 0 CHECK(jj   IN (0,1)),
  joe  INTEGER NOT NULL DEFAULT 0 CHECK(joe  IN (0,1)),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_burger_club_year ON burger_club(year);
`);

// --- Seed Tenants if empty ---
const tenantCount = db.prepare("SELECT COUNT(*) as c FROM tenants").get().c;
if (tenantCount === 0) {
  const names = [
    "Andrew King",
    "Paul Morse",
    "John Wainwright",
    "Joe Wainwright",
    "Job Gregory",
    "JJ Greco"
  ];
  const ins = db.prepare("INSERT INTO tenants (name) VALUES (?)");
  const tx = db.transaction(() => names.forEach((n) => ins.run(n)));
  tx();
  console.log(`Seeded tenants: ${names.length}`);
}

// --- Seed options from JSON if empty ---
const optionCount = db.prepare("SELECT COUNT(*) as c FROM options").get().c;
if (optionCount === 0) {
  const raw = fs.readFileSync(OPTIONS_PATH, "utf-8");
  const options = JSON.parse(raw);

  if (!Array.isArray(options) || options.length !== 64) {
    console.warn(
      `WARNING: options.json must contain exactly 64 items. Found ${options?.length}.`
    );
  }

  const ins = db.prepare(`
    INSERT INTO options (id, title, month, year, location, photo_url, additional_notes, attendees)
    VALUES (@id, @title, @month, @year, @location, @photoUrl, @Additional_Notes, @Attendees)
  `);

  const tx = db.transaction((rows) => rows.forEach((r) => ins.run(r)));
  tx(options);
  console.log(`Seeded options: ${options.length}`);
}

// --- Tenant helper ---
function requireTenant(req, res, next) {
  const tenantId = Number(req.header("x-tenant-id"));
  if (!tenantId) return res.status(400).json({ error: "Missing X-Tenant-Id header" });

  const tenant = db.prepare("SELECT id, name FROM tenants WHERE id = ?").get(tenantId);
  if (!tenant) return res.status(400).json({ error: "Invalid tenant" });

  req.tenant = tenant;
  next();
}

// --- API: list tenants ---
app.get("/api/tenants", (req, res) => {
  const rows = db.prepare("SELECT id, name FROM tenants ORDER BY id").all();
  res.json({ tenants: rows });
});

// --- Progress: how many times each option ranked by tenant ---
app.get("/api/progress", requireTenant, (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.id as option_id, COUNT(v.id) as times_ranked
       FROM options o
       LEFT JOIN votes v
         ON v.option_id = o.id AND v.tenant_id = ?
       GROUP BY o.id
       ORDER BY o.id`
    )
    .all(req.tenant.id);

  const done = rows.every((r) => r.times_ranked >= 2);

  res.json({
    tenant: req.tenant,
    done,
    totalOptions: rows.length,
    remainingTo2x: rows.filter((r) => r.times_ranked < 2).length
  });
});

// --- Get next randomized set of 5 ---
// Prioritize options ranked < 2 times by this tenant, then fill randomly.
app.get("/api/next", requireTenant, (req, res) => {
  const tenantId = req.tenant.id;

  const counts = db
    .prepare(
      `SELECT
        o.id, o.title, o.month, o.year, o.location,
        o.photo_url, o.additional_notes, o.attendees,
        COUNT(v.id) as times_ranked
       FROM options o
       LEFT JOIN votes v
         ON v.option_id = o.id AND v.tenant_id = ?
       GROUP BY o.id`
    )
    .all(tenantId);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const need = shuffle(counts.filter((c) => c.times_ranked < 2));
  const rest = shuffle(counts.filter((c) => c.times_ranked >= 2));

  const pick = [...need, ...rest].slice(0, 5).map((o) => ({
    id: o.id,
    title: o.title,
    month: o.month,
    year: o.year,
    location: o.location,
    photoUrl: o.photo_url,
    Additional_Notes: o.additional_notes,
    Attendees: o.attendees,
    timesRanked: o.times_ranked
  }));

  if (pick.length < 5) return res.status(500).json({ error: "Not enough options to pick from" });

  res.json({
    tenant: req.tenant,
    roundId: nanoid(10),
    options: pick
  });
});

// --- Submit rankings for a round ---
app.post("/api/vote", requireTenant, (req, res) => {
  const tenantId = req.tenant.id;
  const { roundId, rankings } = req.body || {};

  if (!roundId || !Array.isArray(rankings) || rankings.length !== 5) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const ranks = rankings.map((r) => r.rank);
  const optionIds = rankings.map((r) => r.optionId);

  const validRanks = [1, 2, 3, 4, 5];
  const rankSet = new Set(ranks);
  if (rankSet.size !== 5 || !ranks.every((x) => validRanks.includes(x))) {
    return res.status(400).json({ error: "Ranks must be unique 1-5" });
  }

  const optSet = new Set(optionIds);
  if (optSet.size !== 5) return res.status(400).json({ error: "Duplicate options" });

  const existing = db
    .prepare(`SELECT id FROM options WHERE id IN (${optionIds.map(() => "?").join(",")})`)
    .all(...optionIds)
    .map((r) => r.id);

  if (existing.length !== 5) return res.status(400).json({ error: "Unknown optionId" });

  const ins = db.prepare(
    "INSERT INTO votes (tenant_id, round_id, option_id, rank, weight) VALUES (?, ?, ?, ?, ?)"
  );

  // Map tenant full name -> burger_club column
  const TENANT_NAME_TO_FIELD = {
    "Paul Morse": "paul",
    "Job Gregory": "job",
    "John Wainwright": "john",
    "Andrew King": "andrew",
    "JJ Greco": "jj",
    "Joe Wainwright": "joe",
  };

  const tenantField = TENANT_NAME_TO_FIELD[req.tenant.name] || null;

  const tx = db.transaction(() => {
    rankings.forEach((r) => {
      // determine attendance for this tenant for the option
      let attended = false;

      try {
        const bcRow = db.prepare("SELECT * FROM burger_club WHERE id = ?").get(r.optionId);
        if (bcRow && tenantField && (bcRow[tenantField] === 1 || bcRow[tenantField] === "1" || bcRow[tenantField] === true)) {
          attended = true;
        } else {
          // fallback to options.attendees text
          const opt = db.prepare("SELECT attendees FROM options WHERE id = ?").get(r.optionId);
          if (opt && opt.attendees) {
            const attStr = String(opt.attendees).toLowerCase();
            if (attStr.includes(String(req.tenant.name).toLowerCase())) attended = true;
            if (attStr === "true") attended = true;
          }
        }
      } catch (err) {
        // ignore and assume not attended
      }

      const weight = attended ? 1 : 0.5;
      ins.run(tenantId, roundId, r.optionId, r.rank, weight);
    });
  });

  tx();
  res.json({ ok: true });
});

// --- Brackets across all tenants ---
// popularity score: average points where rank 1=5 points ... rank 5=1 point
app.get("/api/brackets", (req, res) => {
  const rows = db
    .prepare(
      `SELECT
        o.id, o.title, o.month, o.year, o.location, o.photo_url,
        o.additional_notes, o.attendees,
        COALESCE(SUM(v.weight),0) as votes,
        SUM((6 - v.rank) * v.weight) / NULLIF(SUM(v.weight),0) as avg_points,
        SUM(v.rank * v.weight) / NULLIF(SUM(v.weight),0) as avg_rank
      FROM options o
      LEFT JOIN votes v ON v.option_id = o.id
      GROUP BY o.id`
    )
    .all();

  rows.sort((a, b) => {
    const ap = a.avg_points ?? 0;
    const bp = b.avg_points ?? 0;
    if (bp !== ap) return bp - ap;
    if ((b.votes ?? 0) !== (a.votes ?? 0)) return (b.votes ?? 0) - (a.votes ?? 0);
    return String(a.title).localeCompare(String(b.title));
  });

  const ranked = rows.map((r, idx) => ({
    overallRank: idx + 1,
    id: r.id,
    title: r.title,
    month: r.month,
    year: r.year,
    location: r.location,
    photoUrl: r.photo_url,
    Additional_Notes: r.additional_notes,
    Attendees: r.attendees,
    votes: r.votes,
    avgRank: r.avg_rank,
    avgPoints: r.avg_points
  }));

  const regionNames = ["Bracket A", "Bracket B", "Bracket C", "Bracket D"];
  const regions = regionNames.map((name) => ({ name, teams: [] }));

  for (let seed = 1; seed <= 16; seed++) {
    const startIdx = (seed - 1) * 4;
    const band = ranked.slice(startIdx, startIdx + 4);
    band.forEach((team, regionIdx) => {
      regions[regionIdx].teams.push({ ...team, seed });
    });
  }

  regions.forEach((r) => r.teams.sort((a, b) => a.seed - b.seed));

  const firstRoundPairs = [
    [1, 16],
    [8, 9],
    [5, 12],
    [4, 13],
    [6, 11],
    [3, 14],
    [7, 10],
    [2, 15]
  ];

  const matchups = regions.map((r) => {
    const bySeed = new Map(r.teams.map((t) => [t.seed, t]));
    return {
      name: r.name,
      games: firstRoundPairs.map(([a, b]) => ({
        top: bySeed.get(a),
        bottom: bySeed.get(b)
      }))
    };
  });

  res.json({ regions, matchups });
});

// --- Personal bracket (per-tenant only) ---
// IMPORTANT: must be registered before the SPA catch-all below
app.get("/api/personal-bracket", requireTenant, (req, res) => {
  const tenantId = req.tenant.id;

  const rows = db
    .prepare(
      `SELECT
        o.id, o.title, o.month, o.year, o.location, o.photo_url,
        o.additional_notes, o.attendees,
        COALESCE(SUM(v.weight),0) as votes,
        SUM((6 - v.rank) * v.weight) / NULLIF(SUM(v.weight),0) as avg_points,
        SUM(v.rank * v.weight) / NULLIF(SUM(v.weight),0) as avg_rank
      FROM options o
      LEFT JOIN votes v
        ON v.option_id = o.id AND v.tenant_id = ?
      GROUP BY o.id`
    )
    .all(tenantId);

  rows.sort((a, b) => {
    const ap = a.avg_points ?? 0;
    const bp = b.avg_points ?? 0;
    if (bp !== ap) return bp - ap;
    if ((b.votes ?? 0) !== (a.votes ?? 0)) return (b.votes ?? 0) - (a.votes ?? 0);
    return String(a.title).localeCompare(String(b.title));
  });

  const ranked = rows.map((r, idx) => ({
    overallRank: idx + 1,
    id: r.id,
    title: r.title,
    month: r.month,
    year: r.year,
    location: r.location,
    photoUrl: r.photo_url,
    Additional_Notes: r.additional_notes,
    Attendees: r.attendees,
    votes: r.votes,
    avgRank: r.avg_rank,
    avgPoints: r.avg_points
  }));

  const regionNames = ["Bracket A", "Bracket B", "Bracket C", "Bracket D"];
  const regions = regionNames.map((name) => ({ name, teams: [] }));

  for (let seed = 1; seed <= 16; seed++) {
    const startIdx = (seed - 1) * 4;
    const band = ranked.slice(startIdx, startIdx + 4);
    band.forEach((team, regionIdx) => {
      regions[regionIdx].teams.push({ ...team, seed });
    });
  }

  regions.forEach((r) => r.teams.sort((a, b) => a.seed - b.seed));

  res.json({ tenant: req.tenant, regions });
});

// --- Raw votes ---
app.get("/api/raw", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 5000), 20000);

  const rows = db
    .prepare(
      `SELECT
        v.created_at,
        v.round_id,
        v.rank,
        t.name as tenant_name,
        o.id as option_id,
        o.title as option_title,
        o.month as option_month,
        o.year as option_year,
        o.location as option_location
      FROM votes v
      JOIN tenants t ON t.id = v.tenant_id
      JOIN options o ON o.id = v.option_id
      ORDER BY v.created_at DESC
      LIMIT ?`
    )
    .all(limit);

  res.json({ rows });
});
// --- Compare: ranks for every tenant (optionId -> overallRank) ---
app.get("/api/compare", (req, res) => {
  const tenants = db.prepare("SELECT id, name FROM tenants ORDER BY id").all();

  // Get options once (for titles)
  const options = db.prepare("SELECT id, title FROM options ORDER BY id").all();

  const ranksByTenant = {};

  // For each tenant, compute overallRank 1..64 using the same scoring rules
  const stmt = db.prepare(
    `SELECT
      o.id, o.title,
      COUNT(v.id) as votes,
      AVG(6 - v.rank) as avg_points,
      AVG(v.rank) as avg_rank
    FROM options o
    LEFT JOIN votes v
      ON v.option_id = o.id AND v.tenant_id = ?
    GROUP BY o.id`
  );

  tenants.forEach((t) => {
    const rows = stmt.all(t.id);

    rows.sort((a, b) => {
      const ap = a.avg_points ?? 0;
      const bp = b.avg_points ?? 0;
      if (bp !== ap) return bp - ap;
      if ((b.votes ?? 0) !== (a.votes ?? 0)) return (b.votes ?? 0) - (a.votes ?? 0);
      return String(a.title).localeCompare(String(b.title));
    });

    const map = {};
    rows.forEach((r, idx) => {
      map[r.id] = idx + 1; // overallRank
    });

    ranksByTenant[String(t.id)] = map;
  });

  res.json({ tenants, options, ranksByTenant });
});
// --- Burger Club Tracker table ---
db.exec(`
CREATE TABLE IF NOT EXISTS burger_club (
  id INTEGER PRIMARY KEY AUTOINCREMENT,       -- this is your # (1,2,3...)
  year INTEGER NOT NULL CHECK(year BETWEEN 2019 AND 2026),
  month TEXT NOT NULL,
  restaurant TEXT NOT NULL,
  location TEXT NOT NULL,
  borough TEXT NOT NULL CHECK(borough IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island','Other')),
  rating TEXT NOT NULL DEFAULT 'Best Burger Ever',

  paul INTEGER NOT NULL DEFAULT 0 CHECK(paul IN (0,1)),
  job  INTEGER NOT NULL DEFAULT 0 CHECK(job  IN (0,1)),
  john INTEGER NOT NULL DEFAULT 0 CHECK(john IN (0,1)),
  andrew INTEGER NOT NULL DEFAULT 0 CHECK(andrew IN (0,1)),
  jj   INTEGER NOT NULL DEFAULT 0 CHECK(jj   IN (0,1)),
  joe  INTEGER NOT NULL DEFAULT 0 CHECK(joe  IN (0,1)),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_burger_club_year ON burger_club(year);
`);
// =======================
// Burger Club Tracker API
// =======================

// List all records
app.get("/api/burger-club", (req, res) => {
  const rows = db
    .prepare(
      `SELECT
        id, year, month, restaurant, location, borough, rating,
        paul, job, john, andrew, jj, joe,
        created_at, updated_at
      FROM burger_club
      ORDER BY id DESC`
    )
    .all();

  res.json({ rows });
});

// Create record
app.post("/api/burger-club", (req, res) => {
  const b = req.body || {};

  const year = Number(b.year);
  const month = String(b.month || "");
  const restaurant = String(b.restaurant || "").trim();
  const location = String(b.location || "").trim();
  const borough = String(b.borough || "");
  const rating = "Best Burger Ever"; // fixed value per requirement

  const to01 = (x) => (x ? 1 : 0);

  if (!(year >= 2019 && year <= 2026)) return res.status(400).json({ error: "Invalid year" });
  if (!month) return res.status(400).json({ error: "Month required" });
  if (!restaurant) return res.status(400).json({ error: "Restaurant required" });
  if (!location) return res.status(400).json({ error: "Location required" });
  if (!["Manhattan","Brooklyn","Queens","Bronx","Staten Island","Other"].includes(borough)) {
    return res.status(400).json({ error: "Invalid borough" });
  }

  const stmt = db.prepare(`
    INSERT INTO burger_club
      (year, month, restaurant, location, borough, rating, paul, job, john, andrew, jj, joe, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const info = stmt.run(
    year, month, restaurant, location, borough, rating,
    to01(b.paul), to01(b.job), to01(b.john), to01(b.andrew), to01(b.jj), to01(b.joe)
  );

  const row = db.prepare(`SELECT * FROM burger_club WHERE id = ?`).get(info.lastInsertRowid);
  res.json({ ok: true, row });
});

// Update record
app.put("/api/burger-club/:id", (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  if (!id) return res.status(400).json({ error: "Invalid id" });

  const year = Number(b.year);
  const month = String(b.month || "");
  const restaurant = String(b.restaurant || "").trim();
  const location = String(b.location || "").trim();
  const borough = String(b.borough || "");
  const rating = "Best Burger Ever";

  const to01 = (x) => (x ? 1 : 0);

  if (!(year >= 2019 && year <= 2026)) return res.status(400).json({ error: "Invalid year" });
  if (!month) return res.status(400).json({ error: "Month required" });
  if (!restaurant) return res.status(400).json({ error: "Restaurant required" });
  if (!location) return res.status(400).json({ error: "Location required" });
  if (!["Manhattan","Brooklyn","Queens","Bronx","Staten Island","Other"].includes(borough)) {
    return res.status(400).json({ error: "Invalid borough" });
  }

  const exists = db.prepare(`SELECT id FROM burger_club WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: "Not found" });

  db.prepare(`
    UPDATE burger_club SET
      year = ?,
      month = ?,
      restaurant = ?,
      location = ?,
      borough = ?,
      rating = ?,
      paul = ?,
      job = ?,
      john = ?,
      andrew = ?,
      jj = ?,
      joe = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    year, month, restaurant, location, borough, rating,
    to01(b.paul), to01(b.job), to01(b.john), to01(b.andrew), to01(b.jj), to01(b.joe),
    id
  );

  const row = db.prepare(`SELECT * FROM burger_club WHERE id = ?`).get(id);
  res.json({ ok: true, row });
});

// Delete record
app.delete("/api/burger-club/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const info = db.prepare(`DELETE FROM burger_club WHERE id = ?`).run(id);
  res.json({ ok: true, deleted: info.changes });
});


// Serve SPA (must be last route)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server (must be last line)
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
