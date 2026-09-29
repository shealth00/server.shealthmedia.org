#!/usr/bin/env node
/**
 * VirtualDJ relay server — runs on server.shealthmedia.org.
 *
 * Purpose: the Mac running VirtualDJ is usually behind NAT/a home
 * router, so this server can't connect IN to it. Instead the Mac
 * agent (../mac-agent) opens an outbound WebSocket connection to
 * THIS server and holds it open. Public HTTP requests hitting this
 * server are forwarded down that socket, the Mac agent executes
 * them (via AppleScript keystrokes into VirtualDJ) and acks back.
 *
 * Also logs every command to a local SQLite database ("database
 * access" — swap DB_PATH / the sqlite calls for your Postgres/MySQL
 * setup if this server already runs one).
 *
 * Env vars:
 *   PORT             HTTP port to listen on (default 3000)
 *   RELAY_TOKEN       shared secret the Mac agent must present to
 *                     connect (required)
 *   API_TOKEN         shared secret HTTP clients must present to
 *                     issue commands (required — separate from
 *                     RELAY_TOKEN so you can rotate independently)
 *   DB_PATH           sqlite file path (default ./virtualdj.db)
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const PORT = parseInt(process.env.PORT || "3000", 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const API_TOKEN = process.env.API_TOKEN;
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "virtualdj.db");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");

if (!RELAY_TOKEN || !API_TOKEN) {
  console.error("RELAY_TOKEN and API_TOKEN env vars are required. Refusing to start with no auth.");
  process.exit(1);
}
if (!CLIENT_PASSWORD) {
  console.error("CLIENT_PASSWORD env var is required. Refusing to start with no auth.");
  process.exit(1);
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- database (command log) -------------------------------------------
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    endpoint TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    response TEXT,
    duration_ms INTEGER
  )
`);
const insertCommand = db.prepare(
  `INSERT INTO commands (endpoint, payload, status, response, duration_ms) VALUES (?, ?, ?, ?, ?)`
);

// --- database (podcast content) -----------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    audio_file TEXT NOT NULL,
    cover_file TEXT,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    cover_file TEXT,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- client login sessions (in-memory; single shared client password) ---
// Not a per-user account system — one password for the site owner/client,
// checked server-side, backing a random bearer token kept in memory only.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function checkClientAuth(req, res, next) {
  const token = req.headers["x-client-token"];
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "not logged in" });
  }
  next();
}

// --- agent connection registry -----------------------------------------
// Only one Mac agent is expected, but this supports multiple named
// agents (e.g. "studio-mac", "booth-mac") if you ever run more than one.
const agents = new Map(); // agentId -> { ws, pending: Map<requestId, {resolve, reject, timer}> }

function getAgent(agentId = "default") {
  return agents.get(agentId);
}

function sendCommandToAgent(agentId, message, timeoutMs = 8000) {
  const agent = getAgent(agentId);
  if (!agent || agent.ws.readyState !== agent.ws.OPEN) {
    return Promise.reject(new Error(`Mac agent "${agentId}" is not connected.`));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.pending.delete(requestId);
      reject(new Error("Timed out waiting for Mac agent to respond."));
    }, timeoutMs);
    agent.pending.set(requestId, { resolve, reject, timer });
    agent.ws.send(JSON.stringify({ ...message, requestId }));
  });
}

// --- HTTP API ------------------------------------------------------------
// Mounted under /api so this app can share server.shealthmedia.org with a
// static site served directly by the webserver at "/".
const app = express();
const api = express.Router();
app.use(express.json());
app.use("/api", api);

function checkApiAuth(req, res, next) {
  const provided = req.query.token || req.headers["x-api-token"];
  if (provided !== API_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

api.get("/health", (req, res) => {
  res.json({
    ok: true,
    agentConnected: Boolean(getAgent("default")?.ws.readyState === 1),
    agents: {
      virtualdj: Boolean(getAgent("default")?.ws.readyState === 1),
      garageband: Boolean(getAgent("garageband")?.ws.readyState === 1),
    },
  });
});

async function handleCommand(req, res, endpoint, message, defaultAgentId = "default") {
  const start = Date.now();
  const agentId = req.query.agent || defaultAgentId;
  try {
    const response = await sendCommandToAgent(agentId, message);
    const duration = Date.now() - start;
    insertCommand.run(endpoint, JSON.stringify(req.body || req.query), "ok", JSON.stringify(response), duration);
    res.json({ ok: true, ...response });
  } catch (err) {
    const duration = Date.now() - start;
    insertCommand.run(endpoint, JSON.stringify(req.body || req.query), "error", err.message, duration);
    res.status(502).json({ ok: false, error: err.message });
  }
}

api.all("/transport", checkApiAuth, (req, res) => {
  const deck = req.query.deck || req.body.deck;
  const action = req.query.action || req.body.action;
  handleCommand(req, res, "/transport", { type: "transport", deck, action });
});

api.all("/mix_now", checkApiAuth, (req, res) => {
  handleCommand(req, res, "/mix_now", { type: "mix_now" });
});

api.all("/emergency_play", checkApiAuth, (req, res) => {
  handleCommand(req, res, "/emergency_play", { type: "emergency_play" });
});

api.all("/key", checkApiAuth, (req, res) => {
  const key = req.query.key ?? req.body.key;
  const keyCode = req.query.keyCode ?? req.body.keyCode;
  const modifiersRaw = req.query.modifiers ?? req.body.modifiers;
  const modifiers = Array.isArray(modifiersRaw)
    ? modifiersRaw
    : typeof modifiersRaw === "string"
    ? modifiersRaw.split(",").filter(Boolean)
    : [];
  handleCommand(req, res, "/key", {
    type: "key",
    key,
    keyCode: keyCode !== undefined ? Number(keyCode) : undefined,
    modifiers,
  });
});

api.all("/gb/transport", checkApiAuth, (req, res) => {
  const action = req.query.action || req.body.action;
  handleCommand(req, res, "/gb/transport", { type: "gb_transport", action }, "garageband");
});

// --- client login ----------------------------------------------------------
api.post("/login", (req, res) => {
  const password = req.body?.password;
  if (password !== CLIENT_PASSWORD) {
    return res.status(401).json({ ok: false, error: "incorrect password" });
  }
  res.json({ ok: true, token: createSession() });
});

api.post("/logout", checkClientAuth, (req, res) => {
  sessions.delete(req.headers["x-client-token"]);
  res.json({ ok: true });
});

// --- podcast content ---------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB, generous for podcast audio
  fileFilter: (req, file, cb) => {
    const okAudio = file.fieldname === "audio" && /^audio\//.test(file.mimetype);
    const okImage = file.fieldname === "cover" && /^image\//.test(file.mimetype);
    cb(null, okAudio || okImage);
  },
});

api.get("/media/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // no path traversal
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

api.get("/podcast/episodes", (req, res) => {
  const rows = db.prepare(`SELECT * FROM episodes ORDER BY published_at DESC`).all();
  res.json({ ok: true, episodes: rows });
});

api.post(
  "/podcast/episodes",
  checkClientAuth,
  upload.fields([{ name: "audio", maxCount: 1 }, { name: "cover", maxCount: 1 }]),
  (req, res) => {
    const { title, description } = req.body;
    const audioFile = req.files?.audio?.[0]?.filename;
    const coverFile = req.files?.cover?.[0]?.filename;
    if (!title || !audioFile) {
      return res.status(400).json({ ok: false, error: "title and audio file are required" });
    }
    const info = db
      .prepare(`INSERT INTO episodes (title, description, audio_file, cover_file) VALUES (?, ?, ?, ?)`)
      .run(title, description || "", audioFile, coverFile || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  }
);

api.delete("/podcast/episodes/:id", checkClientAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "not found" });
  for (const f of [row.audio_file, row.cover_file]) {
    if (f) fs.rm(path.join(UPLOADS_DIR, f), { force: true }, () => {});
  }
  db.prepare(`DELETE FROM episodes WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

api.get("/podcast/articles", (req, res) => {
  const rows = db.prepare(`SELECT * FROM articles ORDER BY published_at DESC`).all();
  res.json({ ok: true, articles: rows });
});

api.post("/podcast/articles", checkClientAuth, upload.fields([{ name: "cover", maxCount: 1 }]), (req, res) => {
  const { title, body } = req.body;
  const coverFile = req.files?.cover?.[0]?.filename;
  if (!title || !body) {
    return res.status(400).json({ ok: false, error: "title and body are required" });
  }
  const info = db
    .prepare(`INSERT INTO articles (title, body, cover_file) VALUES (?, ?, ?)`)
    .run(title, body, coverFile || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

api.delete("/podcast/articles/:id", checkClientAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM articles WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "not found" });
  if (row.cover_file) fs.rm(path.join(UPLOADS_DIR, row.cover_file), { force: true }, () => {});
  db.prepare(`DELETE FROM articles WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

api.get("/history", checkApiAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
  const rows = db.prepare(`SELECT * FROM commands ORDER BY id DESC LIMIT ?`).all(limit);
  res.json({ ok: true, rows });
});

// --- WebSocket server (Mac agent connects here) --------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/api/agent" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const agentId = url.searchParams.get("agentId") || "default";

  if (token !== RELAY_TOKEN) {
    ws.close(4001, "unauthorized");
    return;
  }

  console.log(`Mac agent "${agentId}" connected.`);
  agents.set(agentId, { ws, pending: new Map() });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const agent = agents.get(agentId);
    if (!agent) return;
    const pending = agent.pending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    agent.pending.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.result || {});
    else pending.reject(new Error(msg.error || "agent error"));
  });

  ws.on("close", () => {
    console.log(`Mac agent "${agentId}" disconnected.`);
    const agent = agents.get(agentId);
    if (agent) {
      for (const { reject, timer } of agent.pending.values()) {
        clearTimeout(timer);
        reject(new Error("Mac agent disconnected."));
      }
      agents.delete(agentId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`VirtualDJ relay server listening on :${PORT} (HTTP + WS under /api)`);
});
