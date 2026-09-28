# server.shealthmedia.org

## VirtualDJ remote control

Two pieces, split because the Mac running VirtualDJ is behind NAT and this
server can't connect into it directly:

- **`relay-server/`** — deploys on server.shealthmedia.org. Exposes a public
  HTTP API and a WebSocket endpoint, both mounted under `/api` so the same
  domain can also serve a static site at `/`. Logs every command to SQLite.
- **`mac-agent/`** — runs on the Mac next to VirtualDJ. Connects *out* to the
  relay's WebSocket endpoint and holds the connection open. When a command
  arrives, it executes it locally by sending keystrokes to VirtualDJ via
  AppleScript, using VirtualDJ's own default keyboard mapping.

No VirtualDJ Pro license required — this doesn't touch VirtualDJ's Network
Control plugin (which is Pro-only); it drives the app the same way a
keyboard would.

```
[HTTP client / your app] --> [relay-server on server.shealthmedia.org]
                                    ^  (WebSocket, outbound from Mac)
                                    |
                              [mac-agent on your Mac] --AppleScript--> [VirtualDJ]
```

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
```

All endpoints below are under `/api` (e.g. `/api/health`, `/api/transport`).

| Endpoint | Params | Effect |
|---|---|---|
| `GET /health` | — | `{ ok, agentConnected }`, no auth |
| `/transport` | `deck` (A\|B), `action` | play, cue, stop, sync, loop, loop_half, loop_double, pitch_up/down/reset, nudge_left/right, pad1..pad8, pad_page |
| `/mix_now` | — | Automix "Mix Now" |
| `/emergency_play` | — | Emergency Play |
| `/key` | `key` or `keyCode`, `modifiers` | raw keystroke passthrough |
| `/history` | `limit` | recent command log from SQLite |

All (except `/health`) require `?token=<API_TOKEN>` or header `X-API-Token`.

### Notes / limitations

- No state feedback (now-playing, BPM, deck status) — that requires
  VirtualDJ's Pro-only Network Control plugin. This is action-only.
- If you've customized your VirtualDJ keyboard mapping, edit `DECK_KEYS` in
  `mac-agent/index.js` to match.
- If the Mac sleeps or the agent process dies, commands will 502 with
  `"Mac agent ... is not connected."` — `/health` tells you connection
  state before you rely on it.
- `relay-server` uses SQLite (`better-sqlite3`) for the command log by
  default; swap `relay-server/index.js`'s DB calls for this server's real
  database if you'd rather keep it centralized there.
