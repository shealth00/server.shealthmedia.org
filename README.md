# server.shealthmedia.org

## Remote control: VirtualDJ + GarageBand

One relay, two independent Mac agents, split because the Mac running these
apps is behind NAT and this server can't connect into it directly:

- **`relay-server/`** — deploys on server.shealthmedia.org. Exposes a public
  HTTP API and a WebSocket endpoint, both mounted under `/api` so the same
  domain can also serve a static site at `/`. Logs every command to SQLite.
  Supports multiple named agents over the same WS endpoint (`?agentId=`).
- **`mac-agent/`** — runs on the Mac next to VirtualDJ, registers as agent
  `default`. Connects *out* to the relay's WebSocket endpoint and holds the
  connection open. Executes commands locally by sending keystrokes to
  VirtualDJ via AppleScript, using VirtualDJ's own default keyboard mapping.
- **`garageband-agent/`** — same architecture, registers as agent
  `garageband`. Unlike VirtualDJ, GarageBand exposes real macOS
  accessibility elements for its transport controls (Play, Stop, Record,
  Cycle, Rewind, Forward, Tuner, Count In, Metronome Click), so this agent
  presses those named UI elements via System Events instead of guessing
  keyboard shortcuts.

No VirtualDJ Pro license required — this doesn't touch VirtualDJ's Network
Control plugin (which is Pro-only); it drives both apps the same way a
keyboard/mouse would.

```
[HTTP client / your app] --> [relay-server on server.shealthmedia.org]
                                    ^  (WebSocket, outbound from Mac)
                                    |
                    +---------------+---------------+
                    |                               |
            [mac-agent] --AppleScript--> [VirtualDJ] |
                                                      |
                            [garageband-agent] --System Events UI--> [GarageBand]
```

### Both agents run as LaunchAgents

Backgrounded shell processes (`node index.js &`) do not reliably stay alive
on this Mac — they get reaped between automation sessions. Both agents are
installed as real LaunchAgent daemons instead:

- `~/Library/LaunchAgents/org.shealthmedia.vdj-mac-agent.plist`
- `~/Library/LaunchAgents/org.shealthmedia.gb-agent.plist`

Both set `RunAtLoad` + `KeepAlive`, so they survive reboots and auto-restart
on crash. Logs go to `~/Library/Logs/vdj-mac-agent.log` and
`~/Library/Logs/gb-agent.log`. After editing either agent's `index.js`,
reload with:

```bash
launchctl unload ~/Library/LaunchAgents/org.shealthmedia.<name>.plist
launchctl load ~/Library/LaunchAgents/org.shealthmedia.<name>.plist
```

### macOS permissions both agents need

- **Accessibility** (System Settings → Privacy & Security → Accessibility):
  needed to send keystrokes/UI actions at all.
- **Automation** (System Settings → Privacy & Security → Automation): the
  entry appears as **`node`** (not Terminal, not the agent by name) once
  LaunchAgent-run, since `node` itself is the process sending Apple Events
  to System Events. If the toggle won't stick (flips back off), it's a
  stale/corrupted TCC record — run `tccutil reset AppleEvents`, then
  trigger a command again and grant the fresh prompt when it appears.

### Hosting-tier gotcha: Passenger recycling

On Hostinger Business hosting (shared, Passenger/LiteSpeed-managed — not a
VPS), the relay-server's Node process gets recycled aggressively by
default, silently dropping the WebSocket connection every 20–30s. Fixed by
adding to `.htaccess` alongside the existing Passenger directives:

```
PassengerMinInstances 1
PassengerMaxInstancesPerApp 1
PassengerPoolIdleTime 0
PassengerStartTimeout 90
```

Also disable Hostinger's CDN for this subdomain if enabled — it doesn't
reliably proxy persistent WebSocket connections.

### Deploy relay-server

```bash
cd relay-server
npm install
RELAY_TOKEN=<long-random-string> API_TOKEN=<another-long-random-string> \
  PORT=3000 node index.js
```

Put this behind your existing reverse proxy / process manager (pm2,
systemd, whatever server.shealthmedia.org already uses) so it survives
reboots and gets TLS via your normal domain setup — commands should end up
going over `wss://server.shealthmedia.org/api/agent` and
`https://server.shealthmedia.org/api/...`, not plain `ws://`/`http://`, once
it's behind your TLS termination. The webserver should route only `/api/*`
to this app (e.g. Passenger `PassengerBaseURI /api`) and serve everything
else (the public site) as static files.

Generate strong tokens, e.g.:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Run mac-agent (on the Mac with VirtualDJ)

```bash
cd mac-agent
npm install
```

Grant Accessibility permission: System Settings → Privacy & Security →
Accessibility → add/enable Terminal (or whatever runs this process).

```bash
RELAY_URL=wss://server.shealthmedia.org/api/agent \
  RELAY_TOKEN=<same-long-random-string-as-relay-server> \
  node index.js
```

Keep it running (pm2, a LaunchAgent, `screen`, whatever you prefer) so it
reconnects automatically — it already retries every 5s if the connection
drops.

### Using it

```bash
curl "https://server.shealthmedia.org/api/transport?deck=A&action=play&token=<API_TOKEN>"
curl "https://server.shealthmedia.org/api/transport?deck=B&action=sync&token=<API_TOKEN>"
curl -X POST "https://server.shealthmedia.org/api/mix_now?token=<API_TOKEN>"
curl "https://server.shealthmedia.org/api/history?token=<API_TOKEN>&limit=20"
curl -X POST "https://server.shealthmedia.org/api/gb/transport?action=play&token=<API_TOKEN>"
```

All endpoints below are under `/api` (e.g. `/api/health`, `/api/transport`).

| Endpoint | Params | Effect |
|---|---|---|
| `GET /health` | — | `{ ok, agentConnected }`, no auth |
| `/transport` | `deck` (A\|B), `action` | play, cue, stop, sync, loop, loop_half, loop_double, pitch_up/down/reset, nudge_left/right, pad1..pad8, pad_page |
| `/mix_now` | — | Automix "Mix Now" |
| `/emergency_play` | — | Emergency Play |
| `/key` | `key` or `keyCode`, `modifiers` | raw keystroke passthrough (VirtualDJ agent) |
| `/gb/transport` | `action` | GarageBand: play, stop, record, cycle, rewind, forward, tuner, count_in, metronome |
| `/history` | `limit` | recent command log from SQLite |

All (except `/health`) require `?token=<API_TOKEN>` or header `X-API-Token`.

### Notes / limitations

- No state feedback (now-playing, BPM, deck status) — that requires
  VirtualDJ's Pro-only Network Control plugin. This is action-only.
- If you've customized your VirtualDJ keyboard mapping, edit `DECK_KEYS` in
  `mac-agent/index.js` to match.
- GarageBand only supports the transport actions actually exposed as named
  accessibility elements (see `CONTROLS` in `garageband-agent/index.js`) —
  no upload, playlist, video-control, mixer, or other DAW features.
- If the Mac sleeps or the agent process dies, commands will 502 with
  `"Mac agent ... is not connected."` — `/health` tells you connection
  state before you rely on it.
- `relay-server` uses SQLite (`better-sqlite3`) for the command log by
  default; swap `relay-server/index.js`'s DB calls for this server's real
  database if you'd rather keep it centralized there.

## Podcast CMS (client portal)

`relay-server/podcast.js` adds the API the public site's client portal calls.
It is mounted onto the same `/api` router and changes nothing about
`/health`, `/history`, the transport routes or the WebSocket agent endpoint.
If `CLIENT_PASSWORD`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are not all
set, the new routes still mount but answer `503`, so this code can be
deployed before it is configured without disturbing a running relay.

Rows live in Supabase Postgres (project **Media**, ref `yatasgixudnowtrzqteu`)
and media files in the public Storage bucket `podcast` — see
`supabase/schema.sql`. The relay must use the **service_role** key: RLS is on
with no policies, so an anon/publishable key gets `new row violates row-level
security policy` on every write.

Sessions are in memory, deliberately: the site's `script.js` treats any `401`
as "sign in again", so a relay restart simply re-prompts.

| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `POST /api/login` | — | JSON `{password}` | `200 {ok:true, token}` / `401 {error}` |
| `POST /api/logout` | `X-Client-Token` | — | `200 {ok:true}` |
| `GET /api/podcast/episodes` | public | — | `{ok:true, episodes:[…]}`, newest first |
| `POST /api/podcast/episodes` | `X-Client-Token` | multipart: `title`, `description`, `audio` (required), `cover` (optional) | `201 {ok:true, episode}` |
| `DELETE /api/podcast/episodes/:id` | `X-Client-Token` | — | `{ok:true, deleted}` / `404 {error}` |
| `GET /api/podcast/articles` | public | — | `{ok:true, articles:[…]}`, newest first |
| `POST /api/podcast/articles` | `X-Client-Token` | multipart: `title`, `body`, `cover` (optional) | `201 {ok:true, article}` |
| `DELETE /api/podcast/articles/:id` | `X-Client-Token` | — | `{ok:true, deleted}` / `404 {error}` |

Episode rows are `{id, title, description, audio_url, cover_url,
published_at}`; article rows are `{id, title, body, cover_url,
published_at}`. `id` is a number (the site compares it with `===` against a
`parseInt`), the `*_url` fields are absolute Supabase Storage URLs (`null`
when absent), and `published_at` is `"YYYY-MM-DD HH:MM:SS"` UTC because the
site's `formatDate()` does `new Date(value.replace(" ", "T") + "Z")`.
Errors always come back as JSON with an `error` field — the site's XHR
uploader reads it.

### Local single-origin testing

The site calls a relative `/api`, so the page and the API must share an
origin. Set `SITE_DIR` to serve the static site from this process — a
development convenience only, off unless set, and mounted after the API
router so it can never shadow `/api/*`. Production serves the site from the
webserver, so leave `SITE_DIR` unset there.

```bash
cd relay-server
npm install
cp .env.example .env    # fill in CLIENT_PASSWORD + SUPABASE_SERVICE_KEY
SITE_DIR=/home/izzy/SHIP1/shealthmedia-website PORT=8080 node index.js
# then open http://127.0.0.1:8080/
```
