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
 * Persistence is Supabase: Postgres holds the command log and the
 * podcast content (episodes, articles), and Supabase Storage holds the
 * uploaded audio and cover images. Media is served straight from
 * Storage's public CDN URLs, so podcast audio never goes through this
 * process or the web host's disk.
 *
 * Env vars:
 *   PORT                  HTTP port to listen on (default 3000)
 *   RELAY_TOKEN           shared secret the Mac agent must present to
 *                         connect (required)
 *   API_TOKEN             shared secret HTTP clients must present to
 *                         issue commands (required — separate from
 *                         RELAY_TOKEN so you can rotate independently)
 *   CLIENT_PASSWORD       password for the website's client portal
 *                         (required)
 *   SUPABASE_URL          Supabase project URL (required)
 *   SUPABASE_SERVICE_KEY  service_role key — server-side only, never
 *                         ship this to the browser (required)
 *   SUPABASE_BUCKET       Storage bucket for media (default "podcast")
 *   TMP_UPLOAD_DIR        scratch dir for in-flight uploads
 *                         (default <os tmp>/shm-uploads)
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const API_TOKEN = process.env.API_TOKEN;
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "podcast";
const TMP_UPLOAD_DIR = process.env.TMP_UPLOAD_DIR || path.join(os.tmpdir(), "shm-uploads");

if (!RELAY_TOKEN || !API_TOKEN) {
  console.error("RELAY_TOKEN and API_TOKEN env vars are required. Refusing to start with no auth.");
  process.exit(1);
}
if (!CLIENT_PASSWORD) {
  console.error("CLIENT_PASSWORD env var is required. Refusing to start with no auth.");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required. Refusing to start with no database.");
  process.exit(1);
}

fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

// --- Supabase (database + object storage) -------------------------------
// The service_role key bypasses RLS, so every table below stays locked
// down to server-side access only (see supabase/schema.sql).
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Logging a command must never fail the command itself.
async function logCommand(endpoint, payload, status, response, durationMs) {
  const { error } = await supabase.from("commands").insert({
    endpoint,
    payload: JSON.stringify(payload ?? {}),
    status,
    response: typeof response === "string" ? response : JSON.stringify(response ?? {}),
    duration_ms: durationMs,
  });
  if (error) console.error("command log insert failed:", error.message);
}

// --- storage helpers ----------------------------------------------------
function publicUrl(key) {
  if (!key) return null;
  return supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key).data.publicUrl;
}

// Streams a finished multer temp file into Storage, then removes the temp
// copy either way, so a failed upload can't leave the disk filling up.
async function putObject(file, prefix) {
  const ext = path.extname(file.originalname).toLowerCase();
  const key = `${prefix}/${crypto.randomUUID()}${ext}`;
  try {
    const body = await fs.promises.readFile(file.path);
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(key, body, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    return key;
  } finally {
    await fs.promises.rm(file.path, { force: true }).catch(() => {});
  }
}

async function removeObjects(keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(list);
  if (error) console.error("storage delete failed:", error.message);
}

async function discardUploads(files) {
  for (const list of Object.values(files || {})) {
    for (const f of list) await fs.promises.rm(f.path, { force: true }).catch(() => {});
  }
}

// Rows carry storage keys; the browser gets ready-to-use public URLs.
function withUrls(row) {
  const out = { ...row };
  if ("audio_path" in row) out.audio_url = publicUrl(row.audio_path);
  if ("cover_path" in row) out.cover_url = publicUrl(row.cover_path);
  return out;
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
    await logCommand(endpoint, req.body || req.query, "ok", response, duration);
    res.json({ ok: true, ...response });
  } catch (err) {
    const duration = Date.now() - start;
    await logCommand(endpoint, req.body || req.query, "error", err.message, duration);
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
// Uploads land in a temp dir first, then move to Storage. Media is served
// from Storage's public URLs, so there is no /media route here any more.
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_UPLOAD_DIR,
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

api.get("/podcast/episodes", async (req, res) => {
  const { data, error } = await supabase
    .from("episodes")
    .select("*")
    .order("published_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, episodes: data.map(withUrls) });
});

api.post(
  "/podcast/episodes",
  checkClientAuth,
  upload.fields([{ name: "audio", maxCount: 1 }, { name: "cover", maxCount: 1 }]),
  async (req, res) => {
    const { title, description } = req.body;
    const audio = req.files?.audio?.[0];
    const cover = req.files?.cover?.[0];
    if (!title || !audio) {
      await discardUploads(req.files);
      return res.status(400).json({ ok: false, error: "title and audio file are required" });
    }
    let audioPath = null;
    let coverPath = null;
    try {
      audioPath = await putObject(audio, "episodes/audio");
      if (cover) coverPath = await putObject(cover, "episodes/covers");
      const { data, error } = await supabase
        .from("episodes")
        .insert({ title, description: description || "", audio_path: audioPath, cover_path: coverPath })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      res.json({ ok: true, id: data.id });
    } catch (err) {
      // Don't leave orphaned objects behind if the row insert failed.
      await removeObjects([audioPath, coverPath]);
      await discardUploads(req.files);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

api.delete("/podcast/episodes/:id", checkClientAuth, async (req, res) => {
  const { data: row, error: findErr } = await supabase
    .from("episodes").select("*").eq("id", req.params.id).maybeSingle();
  if (findErr) return res.status(500).json({ ok: false, error: findErr.message });
  if (!row) return res.status(404).json({ ok: false, error: "not found" });
  await removeObjects([row.audio_path, row.cover_path]);
  const { error } = await supabase.from("episodes").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

api.get("/podcast/articles", async (req, res) => {
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .order("published_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, articles: data.map(withUrls) });
});

api.post("/podcast/articles", checkClientAuth, upload.fields([{ name: "cover", maxCount: 1 }]), async (req, res) => {
  const { title, body } = req.body;
  const cover = req.files?.cover?.[0];
  if (!title || !body) {
    await discardUploads(req.files);
    return res.status(400).json({ ok: false, error: "title and body are required" });
  }
  let coverPath = null;
  try {
    if (cover) coverPath = await putObject(cover, "articles/covers");
    const { data, error } = await supabase
      .from("articles")
      .insert({ title, body, cover_path: coverPath })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, id: data.id });
  } catch (err) {
    await removeObjects([coverPath]);
    await discardUploads(req.files);
    res.status(500).json({ ok: false, error: err.message });
  }
});

api.delete("/podcast/articles/:id", checkClientAuth, async (req, res) => {
  const { data: row, error: findErr } = await supabase
    .from("articles").select("*").eq("id", req.params.id).maybeSingle();
  if (findErr) return res.status(500).json({ ok: false, error: findErr.message });
  if (!row) return res.status(404).json({ ok: false, error: "not found" });
  await removeObjects([row.cover_path]);
  const { error } = await supabase.from("articles").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

api.get("/history", checkApiAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
  const { data, error } = await supabase
    .from("commands")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, rows: data });
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
