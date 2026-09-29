/**
 * Podcast CMS routes for the shealthmedia relay.
 *
 * Additive: this module is mounted onto the existing /api router and does
 * not touch /api/health, /api/history, the VirtualDJ/GarageBand transport
 * routes or the WebSocket agent endpoint. If the CMS env vars are absent
 * the routes still mount but answer 503, so deploying this code without
 * new configuration cannot break the running relay.
 *
 * The contract below is derived from the site's script.js (the frontend is
 * the source of truth):
 *
 *   POST   /api/login                    {password}            -> {ok, token}
 *   POST   /api/logout                   X-Client-Token        -> {ok}
 *   GET    /api/podcast/episodes         (public)              -> {ok, episodes:[...]}
 *   POST   /api/podcast/episodes         multipart + token     -> {ok, episode}
 *   DELETE /api/podcast/episodes/:id     X-Client-Token        -> {ok, deleted}
 *   GET    /api/podcast/articles         (public)              -> {ok, articles:[...]}
 *   POST   /api/podcast/articles         multipart + token     -> {ok, article}
 *   DELETE /api/podcast/articles/:id     X-Client-Token        -> {ok, deleted}
 *
 * Env vars:
 *   CLIENT_PASSWORD        portal password checked by POST /api/login
 *   SUPABASE_URL           Supabase project URL
 *   SUPABASE_SERVICE_KEY   service_role key (server-side only, bypasses RLS)
 *   SUPABASE_BUCKET        public Storage bucket for media (default "podcast")
 *   SESSION_TTL_HOURS      client session lifetime (default 12)
 *   MAX_UPLOAD_MB          per-file upload cap (default 300)
 */

const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "podcast";
const SESSION_TTL_MS = (parseFloat(process.env.SESSION_TTL_HOURS || "12") || 12) * 3600 * 1000;
const MAX_UPLOAD_BYTES = (parseInt(process.env.MAX_UPLOAD_MB || "300", 10) || 300) * 1024 * 1024;

const enabled = Boolean(CLIENT_PASSWORD && SUPABASE_URL && SUPABASE_SERVICE_KEY);

const supabase = enabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// --- sessions (in memory, exactly what the site's UI assumes) ------------
// script.js treats any 401 as "the relay restarted / session expired" and
// re-opens the login modal, so in-memory sessions are the intended design.
const sessions = new Map(); // token -> expiresAt (ms)

function issueToken() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function passwordMatches(provided) {
  const a = Buffer.from(String(provided == null ? "" : provided));
  const b = Buffer.from(CLIENT_PASSWORD);
  // Compare hashes so differing lengths don't throw and don't leak length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireCms(req, res, next) {
  if (!enabled) {
    return res.status(503).json({
      error: "Podcast CMS is not configured on this relay (CLIENT_PASSWORD / SUPABASE_URL / SUPABASE_SERVICE_KEY).",
    });
  }
  next();
}

function requireClient(req, res, next) {
  const token = req.get("X-Client-Token") || "";
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "not signed in" });
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
  next();
}

// --- helpers -------------------------------------------------------------
// script.js's formatDate() does `new Date(value.replace(" ", "T") + "Z")`,
// so timestamps must go out as "YYYY-MM-DD HH:MM:SS" (UTC, no zone suffix).
function fmtTimestamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function publicUrl(key) {
  if (!key) return null;
  return supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key).data.publicUrl;
}

function safeExt(filename, fallback) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

async function uploadFile(file, folder, fallbackExt) {
  const key = `${folder}/${Date.now()}-${crypto.randomUUID()}${safeExt(file.originalname, fallbackExt)}`;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, file.buffer, {
    contentType: file.mimetype || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return key;
}

async function removeFiles(keys) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(list);
  if (error) console.warn(`[podcast] could not remove storage objects: ${error.message}`);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
});

// Multer/file errors must come back as JSON — script.js parses the body for
// an `error` field and falls back to "upload failed (<status>)".
function uploadFields(fields) {
  const mw = upload.fields(fields);
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB` : err.message,
      });
    });
}

function mapEpisode(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    audio_url: publicUrl(row.audio_path),
    cover_url: publicUrl(row.cover_path),
    published_at: fmtTimestamp(row.published_at),
  };
}

function mapArticle(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body || "",
    cover_url: publicUrl(row.cover_path),
    published_at: fmtTimestamp(row.published_at),
  };
}

function firstFile(req, field) {
  return (req.files && req.files[field] && req.files[field][0]) || null;
}

// --- route mounting ------------------------------------------------------
function mount(api) {
  // ---- auth ----
  api.post("/login", requireCms, (req, res) => {
    const password = (req.body || {}).password;
    if (!password || !passwordMatches(password)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    res.json({ ok: true, token: issueToken() });
  });

  api.post("/logout", requireCms, (req, res) => {
    const token = req.get("X-Client-Token") || "";
    if (token) sessions.delete(token);
    res.json({ ok: true });
  });

  // ---- episodes ----
  api.get("/podcast/episodes", requireCms, async (req, res) => {
    const { data, error } = await supabase
      .from("episodes")
      .select("id,title,description,audio_path,cover_path,published_at")
      .order("published_at", { ascending: false })
      .order("id", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, episodes: data.map(mapEpisode) });
  });

  api.post(
    "/podcast/episodes",
    requireCms,
    requireClient,
    uploadFields([{ name: "audio", maxCount: 1 }, { name: "cover", maxCount: 1 }]),
    async (req, res) => {
      const title = String((req.body.title || "")).trim();
      const description = String(req.body.description || "");
      const audio = firstFile(req, "audio");
      const cover = firstFile(req, "cover");
      if (!title) return res.status(400).json({ error: "title is required" });
      if (!audio) return res.status(400).json({ error: "an audio file is required" });

      let audioKey = null;
      let coverKey = null;
      try {
        audioKey = await uploadFile(audio, "audio", ".mp3");
        if (cover) coverKey = await uploadFile(cover, "covers", ".jpg");
        const { data, error } = await supabase
          .from("episodes")
          .insert({ title, description, audio_path: audioKey, cover_path: coverKey })
          .select("id,title,description,audio_path,cover_path,published_at")
          .single();
        if (error) throw new Error(error.message);
        res.status(201).json({ ok: true, episode: mapEpisode(data) });
      } catch (err) {
        await removeFiles([audioKey, coverKey]); // don't orphan blobs
        res.status(500).json({ error: err.message });
      }
    }
  );

  api.delete("/podcast/episodes/:id", requireCms, requireClient, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "bad episode id" });
    const { data: row, error: findErr } = await supabase
      .from("episodes")
      .select("id,audio_path,cover_path")
      .eq("id", id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "episode not found" });
    const { error } = await supabase.from("episodes").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    await removeFiles([row.audio_path, row.cover_path]);
    res.json({ ok: true, deleted: id });
  });

  // ---- articles ----
  api.get("/podcast/articles", requireCms, async (req, res) => {
    const { data, error } = await supabase
      .from("articles")
      .select("id,title,body,cover_path,published_at")
      .order("published_at", { ascending: false })
      .order("id", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, articles: data.map(mapArticle) });
  });

  api.post(
    "/podcast/articles",
    requireCms,
    requireClient,
    uploadFields([{ name: "cover", maxCount: 1 }]),
    async (req, res) => {
      const title = String(req.body.title || "").trim();
      const body = String(req.body.body || "").trim();
      const cover = firstFile(req, "cover");
      if (!title) return res.status(400).json({ error: "title is required" });
      if (!body) return res.status(400).json({ error: "body is required" });

      let coverKey = null;
      try {
        if (cover) coverKey = await uploadFile(cover, "covers", ".jpg");
        const { data, error } = await supabase
          .from("articles")
          .insert({ title, body, cover_path: coverKey })
          .select("id,title,body,cover_path,published_at")
          .single();
        if (error) throw new Error(error.message);
        res.status(201).json({ ok: true, article: mapArticle(data) });
      } catch (err) {
        await removeFiles([coverKey]);
        res.status(500).json({ error: err.message });
      }
    }
  );

  api.delete("/podcast/articles/:id", requireCms, requireClient, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "bad article id" });
    const { data: row, error: findErr } = await supabase
      .from("articles")
      .select("id,cover_path")
      .eq("id", id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!row) return res.status(404).json({ error: "article not found" });
    const { error } = await supabase.from("articles").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    await removeFiles([row.cover_path]);
    res.json({ ok: true, deleted: id });
  });

  console.log(
    enabled
      ? `Podcast CMS routes mounted (Supabase bucket "${SUPABASE_BUCKET}").`
      : "Podcast CMS routes mounted but DISABLED (missing CLIENT_PASSWORD / SUPABASE_URL / SUPABASE_SERVICE_KEY); they answer 503."
  );
}

module.exports = { mount, enabled };
