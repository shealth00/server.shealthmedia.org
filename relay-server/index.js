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

const PORT = parseInt(process.env.PORT || "3000", 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const API_TOKEN = process.env.API_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "virtualdj.db");

if (!RELAY_TOKEN || !API_TOKEN) {
  console.error("RELAY_TOKEN and API_TOKEN env vars are required. Refusing to start with no auth.");
  process.exit(1);
}

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
const app = express();
app.use(express.json());

function checkApiAuth(req, res, next) {
  const provided = req.query.token || req.headers["x-api-token"];
  if (provided !== API_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    agentConnected: Boolean(getAgent("default")?.ws.readyState === 1),
  });
});

async function handleCommand(req, res, endpoint, message) {
  const start = Date.now();
  const agentId = req.query.agent || "default";
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

app.all("/transport", checkApiAuth, (req, res) => {
  const deck = req.query.deck || req.body.deck;
  const action = req.query.action || req.body.action;
  handleCommand(req, res, "/transport", { type: "transport", deck, action });
});

app.all("/mix_now", checkApiAuth, (req, res) => {
  handleCommand(req, res, "/mix_now", { type: "mix_now" });
});

app.all("/emergency_play", checkApiAuth, (req, res) => {
  handleCommand(req, res, "/emergency_play", { type: "emergency_play" });
});

app.all("/key", checkApiAuth, (req, res) => {
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

app.get("/history", checkApiAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
  const rows = db.prepare(`SELECT * FROM commands ORDER BY id DESC LIMIT ?`).all(limit);
  res.json({ ok: true, rows });
});

// --- WebSocket server (Mac agent connects here) --------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

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
  console.log(`VirtualDJ relay server listening on :${PORT} (HTTP + WS /agent)`);
});
