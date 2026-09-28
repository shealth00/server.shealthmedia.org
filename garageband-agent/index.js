#!/usr/bin/env node
/**
 * GarageBand Mac agent.
 *
 * Same architecture as ../mac-agent (VirtualDJ), connecting outbound to the
 * relay's WebSocket endpoint and executing commands locally. Registers as
 * a distinct named agent ("garageband" by default) so the same relay can
 * talk to both the VirtualDJ agent and this one independently.
 *
 * Unlike VirtualDJ, GarageBand exposes real macOS accessibility elements
 * for its transport controls (Play, Stop, Record, Cycle, Rewind, Forward,
 * Tuner, Count In, Metronome Click) — confirmed via inspection. So instead
 * of guessing keyboard shortcuts, this agent drives GarageBand by pressing
 * those named UI elements through System Events, which is more reliable.
 *
 * Requires: macOS, GarageBand running with a project open, and this
 * process granted Accessibility permission (System Settings > Privacy &
 * Security > Accessibility).
 *
 * Env vars:
 *   RELAY_URL    wss://server.shealthmedia.org/api/agent  (required)
 *   RELAY_TOKEN  shared secret, must match the relay server's
 *                RELAY_TOKEN (required)
 *   AGENT_ID     identifies this agent to the relay (default "garageband")
 */

const WebSocket = require("ws");
const { execFile } = require("child_process");

const APP_NAME = "GarageBand";
const RELAY_URL = process.env.RELAY_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const AGENT_ID = process.env.AGENT_ID || "garageband";

if (!RELAY_URL || !RELAY_TOKEN) {
  console.error("RELAY_URL and RELAY_TOKEN env vars are required.");
  process.exit(1);
}

// Transport controls confirmed present as named accessibility elements in
// GarageBand's main "Tracks" window (checkbox for toggles, button for
// momentary actions). Edit this map only if a future GarageBand version
// renames these controls.
const CONTROLS = {
  play: "Play",
  stop: "Stop",
  record: "Record",
  cycle: "Cycle",
  rewind: "Rewind",
  forward: "Forward",
  tuner: "Tuner",
  count_in: "Count In",
  metronome: "Metronome Click",
};

function clickControl(title) {
  return new Promise((resolve, reject) => {
    const escaped = title.replace(/(["\\])/g, "\\$1");
    const script = `
      tell application "System Events"
        tell process "${APP_NAME}"
          set frontmost to true
          set targetElement to missing value
          repeat with w in windows
            set allEls to entire contents of w
            repeat with el in allEls
              try
                if (name of el is "${escaped}") and ((class of el is checkbox) or (class of el is button)) then
                  set targetElement to el
                  exit repeat
                end if
              end try
            end repeat
            if targetElement is not missing value then exit repeat
          end repeat
          if targetElement is missing value then
            error "Control not found: ${escaped}"
          end if
          click targetElement
        end tell
      end tell
    `;
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "gb_transport": {
      const title = CONTROLS[msg.action];
      if (!title) throw new Error(`Unknown GarageBand action: ${msg.action}`);
      await clickControl(title);
      return { action: msg.action };
    }
    default:
      throw new Error(`Unknown command type: ${msg.type}`);
  }
}

function connect() {
  const url = `${RELAY_URL}?token=${encodeURIComponent(RELAY_TOKEN)}&agentId=${encodeURIComponent(AGENT_ID)}`;
  const ws = new WebSocket(url);

  ws.on("open", () => console.log(`Connected to relay as agent "${AGENT_ID}".`));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      const result = await handleMessage(msg);
      ws.send(JSON.stringify({ requestId: msg.requestId, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ requestId: msg.requestId, ok: false, error: err.message }));
    }
  });

  ws.on("close", () => {
    console.log("Disconnected from relay, retrying in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

connect();
