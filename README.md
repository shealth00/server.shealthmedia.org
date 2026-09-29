# server.shealthmedia.org

## Remote control: VirtualDJ + GarageBand

One relay, two independent Mac agents, split because the Mac running these
apps is behind NAT and this server can't connect into it directly:

- **`relay-server/`** — deploys on server.shealthmedia.org. Exposes a public
  HTTP API and a WebSocket endpoint, both mounted under `/api` so the same
  domain can also serve a static site at `/`. Logs every command to Supabase Postgres.
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
  CLIENT_PASSWORD=<portal-password> \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SERVICE_KEY=<service_role key> \
  PORT=3000 node index.js
```

The server refuses to start if any of `RELAY_TOKEN`, `API_TOKEN`,
`CLIENT_PASSWORD`, `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is missing —
there is no "insecure default" mode.

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
| `/history` | `limit` | recent command log from Supabase Postgres |

All (except `/health`) require `?token=<API_TOKEN>` or header `X-API-Token`.

### Supabase setup (one time)

1. In the Supabase project, run `supabase/schema.sql` (SQL Editor) to
   create the `commands`, `episodes` and `articles` tables. RLS is enabled
   with no policies — the relay reaches them with the `service_role` key,
   and nothing else can.
2. Create a **public** Storage bucket named `podcast` (or whatever you set
   `SUPABASE_BUCKET` to). Public is deliberate: podcast audio is meant to
   be fetched by any player, and public URLs let the CDN serve it.
3. Copy the project URL and the `service_role` key into the relay's env.
   The `service_role` key bypasses RLS — it belongs on the server only,
   never in the website's JavaScript.

### Content API (podcast CMS)

Used by the website's client portal and public player.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/login` | POST | — | exchange `CLIENT_PASSWORD` for a 24h session token |
| `/logout` | POST | client | drop the session |
| `/podcast/episodes` | GET | public | list episodes, newest first |
| `/podcast/episodes` | POST | client | publish an episode (`title`, `description`, `audio`, optional `cover`) |
| `/podcast/episodes/:id` | DELETE | client | delete episode + its Storage objects |
| `/podcast/articles` | GET | public | list articles, newest first |
| `/podcast/articles` | POST | client | publish an article (`title`, `body`, optional `cover`) |
| `/podcast/articles/:id` | DELETE | client | delete article + its cover |

Client-authenticated calls send the token as `X-Client-Token`. Sessions
live in memory, so a relay restart signs the portal out — by design, it
keeps the blast radius of a leaked token to one process lifetime.

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
- `relay-server` stores everything in Supabase: Postgres for the command
  log and the podcast content, Supabase Storage for uploaded audio and
  cover images. There is no local database file and no native module to
  compile, which matters on shared hosting.
- Podcast audio is served straight from Storage's public CDN URLs, so
  episode downloads never pass through this process or the web host's
  disk quota. API responses carry `audio_url` / `cover_url` alongside the
  stored `audio_path` / `cover_path`.
- `@supabase/supabase-js` warns on Node 20 and wants Node 22+. It runs on
  20, but set the hPanel Node app to 22 when you can.
