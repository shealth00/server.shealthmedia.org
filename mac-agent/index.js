#!/usr/bin/env node
/**
 * VirtualDJ Mac agent.
 *
 * Runs on the same Mac as VirtualDJ. Opens an OUTBOUND WebSocket
 * connection to the relay server on server.shealthmedia.org and
 * waits for commands, which it executes locally by sending
 * keystrokes to VirtualDJ via AppleScript/System Events — using
 * VirtualDJ's own default keyboard mapping. No VirtualDJ Pro
 * license required.
 *
 * Because the connection is outbound-only, this works from behind
 * a home router/NAT with no port forwarding or firewall changes.
 *
 * Requires: macOS, VirtualDJ running, and this process granted
 * Accessibility permission (System Settings > Privacy & Security
 * > Accessibility).
 *
 * Env vars:
 *   RELAY_URL    wss://server.shealthmedia.org/agent  (required)
 *   RELAY_TOKEN  shared secret, must match the relay server's
 *                RELAY_TOKEN (required)
 *   AGENT_ID     identifies this Mac if you run more than one
 *                (default "default")
 */

const WebSocket = require("ws");
const { execFile } = require("child_process");

const APP_NAME = "VirtualDJ";
const RELAY_URL = process.env.RELAY_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const AGENT_ID = process.env.AGENT_ID || "default";

if (!RELAY_URL || !RELAY_TOKEN) {
  console.error("RELAY_URL and RELAY_TOKEN env vars are required.");
  process.exit(1);
}

function sendKey(key, modifiers = []) {
  return new Promise((resolve, reject) => {
    const usingClause =
      modifiers.length > 0
        ? ` using {${modifiers.map((m) => `${m} down`).join(", ")}}`
        : "";
    const isKeyCode = typeof key === "number";
    const keyClause = isKeyCode
      ? `key code ${key}`
      : `keystroke "${String(key).replace(/(["\\])/g, "\\$1")}"`;
    const script = `
      tell application "System Events"
        tell application process "${APP_NAME}"
          set frontmost to true
        end tell
        ${keyClause}${usingClause}
      end tell
    `;
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Same mapping as the standalone local server — edit if you've
// customized VirtualDJ's keyboard mapping.
const DECK_KEYS = {
  A: {
    play: "1", cue: "2", stop: "3", loop: "4", loop_half: "5", loop_double: "6",
    sync: "\t", nudge_left: "q", nudge_right: "w", pitch_down: "e", pitch_up: "r",
    pitch_reset: "t", pad1: "a", pad2: "s", pad3: "d", pad4: "f", pad_page: "g",
    pad5: "z", pad6: "x", pad7: "c", pad8: "v",
  },
  B: {
    play: "7", cue: "8", stop: "9", loop: "0", loop_half: "-", loop_double: "=",
    sync: "y", nudge_left: "u", nudge_right: "i", pitch_down: "o", pitch_up: "p",
    pitch_reset: "[", pad1: "h", pad2: "j", pad3: "k", pad4: "l", pad_page: ";",
    pad5: "n", pad6: "m", pad7: ",", pad8: ".",
  },
};
const GLOBAL_KEYS = { mix_now: 51, emergency_play: " " };

async function handleMessage(msg) {
  switch (msg.type) {
    case "transport": {
      const key = DECK_KEYS[msg.deck]?.[msg.action];
      if (!key) throw new Error(`Unknown deck/action: ${msg.deck}/${msg.action}`);
      await sendKey(key);
      return { deck: msg.deck, action: msg.action };
    }
    case "mix_now":
      await sendKey(GLOBAL_KEYS.mix_now);
      return { triggered: "mix_now" };
    case "emergency_play":
      await sendKey(GLOBAL_KEYS.emergency_play);
      return { triggered: "emergency_play" };
    case "key": {
      const k = msg.keyCode !== undefined ? msg.keyCode : msg.key;
      if (k === undefined) throw new Error("Provide either 'key' or 'keyCode'.");
      await sendKey(k, msg.modifiers || []);
      return { key: k, modifiers: msg.modifiers || [] };
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
