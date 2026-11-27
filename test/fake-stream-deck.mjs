/**
 * End-to-end check without hardware: pretends to be the Stream Deck app.
 *
 * Stream Deck talks to plugins over a local WebSocket using JSON messages.
 * This script starts a WebSocket server, launches the BUILT plugin
 * (bin/plugin.js) exactly the way Stream Deck does, then plays the part of a
 * user: turning, pressing, holding and tapping the dial, and checks what the
 * plugin draws on the touch strip.
 *
 * Run with: npm run build && npm run e2e
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const PLUGIN_DIR = fileURLToPath(new URL("../com.jere.timerdial.sdPlugin/", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../com.jere.timerdial.sdPlugin/bin/plugin.js", import.meta.url));
const UUID = "com.jere.timerdial";
const ACTION = "com.jere.timerdial.timer";
const CTX = "ctx-dial-1";
const DEVICE = "dev-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeStreamDeck {
	received = [];
	strip = {}; // latest value of every touch-strip item, merged from setFeedback calls
	globalSettings = {};
	socket;
	child;

	async start(globalSettings = {}) {
		this.globalSettings = globalSettings;
		this.received = [];
		this.strip = {};
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		this.wss = wss;
		await new Promise((resolve) => wss.once("listening", resolve));
		const port = wss.address().port;
		const connected = new Promise((resolve) => {
			wss.on("connection", (socket) => {
				this.socket = socket;
				socket.on("message", (raw) => this.#onMessage(JSON.parse(raw.toString()), resolve));
			});
		});
		const info = {
			application: { font: "", language: "en", platform: "mac", platformVersion: "14.0", version: "7.1.0.0" },
			colors: {},
			devicePixelRatio: 2,
			devices: [{ id: DEVICE, name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
			plugin: { uuid: UUID, version: "1.0.0.0" },
		};
		this.child = spawn(process.execPath, [PLUGIN, "-port", String(port), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
			cwd: PLUGIN_DIR, // Stream Deck runs plugins from their .sdPlugin folder (the SDK reads manifest.json from here)
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child.stderr.on("data", (d) => process.stderr.write(`[plugin stderr] ${d}`));
		await connected;
	}

	#onMessage(msg, onRegistered) {
		this.received.push(msg);
		if (msg.event === "registerPlugin") onRegistered();
		if (msg.event === "getGlobalSettings") {
			this.send({ event: "didReceiveGlobalSettings", id: msg.id, payload: { settings: this.globalSettings } });
		}
		if (msg.event === "setGlobalSettings") this.globalSettings = msg.payload;
		if (msg.event === "setFeedback") Object.assign(this.strip, msg.payload);
	}

	send(msg) {
		this.socket.send(JSON.stringify(msg));
	}

	actionEvent(event, payload = {}) {
		this.send({ event, action: ACTION, context: CTX, device: DEVICE, payload: { controller: "Encoder", coordinates: { column: 0, row: 0 }, settings: this.settings, resources: {}, ...payload } });
	}

	appear(settings) {
		this.settings = settings;
		this.actionEvent("willAppear", { isInMultiAction: false });
	}

	text(key) {
		return this.strip[key]?.value;
	}

	count(event, since = 0) {
		return this.received.slice(since).filter((m) => m.event === event).length;
	}

	async waitFor(pred, what, timeout = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (pred()) return;
			await sleep(20);
		}
		throw new Error(`Timed out waiting for: ${what}. Strip: ${JSON.stringify(this.strip)}`);
	}

	async stop() {
		this.child.kill();
		await new Promise((r) => this.wss.close(r));
	}

	// --- user gestures ---
	rotate(ticks, pressed = false) {
		this.actionEvent("dialRotate", { ticks, pressed });
	}
	async press(holdMs = 80) {
		this.actionEvent("dialDown");
		await sleep(holdMs);
		this.actionEvent("dialUp");
		await sleep(60);
	}
	tap(hold = false) {
		this.actionEvent("touchTap", { hold, tapPos: [100, 50] });
	}
}

const sd = new FakeStreamDeck();
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
	console.log("Streamlined scheme");
	await sd.start();
	sd.appear({ startTime: "0:03", alarmLength: "once", sound: "desk-bell" });
	await sd.waitFor(() => sd.text("time") === "0:03" && sd.text("status") === "READY", "initial draw");
	// On dials, the SDK's setTitle() is sent as feedback for the layout's "title" item.
	assert.ok(sd.received.some((m) => m.event === "setFeedback" && m.payload.title === "Timer"));
	assert.ok(sd.received.some((m) => m.event === "setTriggerDescription" && /Set time/.test(m.payload.rotate)));
	ok("draws 0:03 READY, sets title and trigger descriptions");

	sd.rotate(1);
	await sd.waitFor(() => sd.text("time") === "0:05", "snap up to 0:05");
	sd.rotate(1);
	await sd.waitFor(() => sd.text("time") === "0:10", "0:10");
	sd.rotate(-3);
	await sd.waitFor(() => sd.text("time") === "0:00", "down to 0:00 (clamped)");
	ok("turning steps 0:03 → 0:05 → 0:10 → 0:00 (never negative)");

	const alerts = sd.count("showAlert");
	await sd.press();
	await sd.waitFor(() => sd.count("showAlert") === alerts + 1, "alert when starting at 0:00");
	ok("pressing at 0:00 shows an alert instead of starting");

	sd.rotate(1);
	await sd.waitFor(() => sd.text("time") === "0:05", "0:05");
	await sd.press();
	await sd.waitFor(() => sd.text("status") === "RUNNING", "running");
	ok("press starts the countdown");

	const before = sd.count("setFeedback");
	await sleep(1500);
	const perSecond = (sd.count("setFeedback") - before) / 1.5;
	assert.ok(perSecond <= 3, `too many updates: ${perSecond}/s`);
	assert.ok(["0:04", "0:03"].includes(sd.text("time")), `time was ${sd.text("time")}`);
	ok(`counts down (${sd.text("time")}), ${perSecond.toFixed(1)} strip updates/s (guideline max 10)`);

	sd.tap();
	await sd.waitFor(() => sd.text("status") === "PAUSED", "paused via tap");
	const frozen = sd.text("time");
	await sleep(1200);
	assert.equal(sd.text("time"), frozen);
	ok(`tap pauses and the time stays frozen at ${frozen}`);

	sd.tap();
	await sd.waitFor(() => sd.text("status") === "RUNNING", "resumed");
	await sd.waitFor(() => sd.text("status") === "TIME'S UP", "alarm", 6000);
	const bg1 = sd.strip.bg.background;
	await sd.waitFor(() => sd.strip.bg.background !== bg1, "background flashes");
	ok("alarm fires: TIME'S UP with flashing background");

	sd.actionEvent("dialDown");
	await sd.waitFor(() => sd.text("status") === "READY", "dismissed on press-down");
	sd.actionEvent("dialUp");
	await sleep(150);
	assert.equal(sd.text("status"), "READY", "the release after dismissing must not start the timer");
	assert.equal(sd.text("time"), "0:05", "back to the time it was started with");
	ok("press dismisses (on the way down) and restores 0:05; release is swallowed");

	sd.rotate(2);
	await sd.waitFor(() => sd.text("time") === "0:15", "0:15");
	sd.actionEvent("dialDown");
	await sd.waitFor(() => sd.text("time") === "0:03", "long press resets while still held", 1500);
	sd.actionEvent("dialUp");
	await sleep(150);
	assert.equal(sd.text("status"), "READY");
	ok("hold resets to the start time (0:03) before release; release doesn't start it");

	sd.actionEvent("dialDown");
	await sleep(50);
	sd.rotate(1, true);
	await sd.waitFor(() => sd.text("time") === "5:00", "push+turn coarse jump");
	await sleep(600); // past the long-press threshold - must NOT reset
	sd.actionEvent("dialUp");
	await sleep(150);
	assert.equal(sd.text("time"), "5:00");
	assert.equal(sd.text("status"), "READY");
	ok("push + turn jumps 0:03 → 5:00 and cancels both the press and the long press");

	await sd.press();
	await sd.waitFor(() => sd.text("status") === "RUNNING", "running 5:00");
	sd.rotate(2);
	await sd.waitFor(() => /^5:[56]\d$/.test(sd.text("time")), "nudged up ~1 min");
	ok(`turning while running nudges the time (${sd.text("time")})`);

	sd.actionEvent("willDisappear");
	await sleep(1200);
	sd.strip = {};
	sd.appear(sd.settings);
	await sd.waitFor(() => sd.text("status") === "RUNNING" && /^5:[45]\d$/.test(sd.text("time")), "still running after page switch");
	ok(`kept running while off-screen; full redraw on return (${sd.text("time")})`);

	await sleep(700); // let the debounced save land
	const saved = sd.globalSettings;
	assert.equal(Object.values(saved.timers ?? {})[0]?.status, "running");
	ok("running timer saved to global settings");

	console.log("Survives a Stream Deck restart");
	await sd.stop();
	await sd.start(saved);
	sd.appear({ startTime: "0:03", alarmLength: "once", sound: "desk-bell" });
	await sd.waitFor(() => sd.text("status") === "RUNNING" && /^5:[45]\d$/.test(sd.text("time")), "restored after restart");
	ok(`restored the running timer after restart (${sd.text("time")})`);

	sd.tap(true);
	await sd.waitFor(() => sd.text("status") === "READY" && sd.text("time") === "5:00", "long-touch reset");
	ok("long-touch on the strip resets");

	console.log("Classic scheme");
	sd.settings = { ...sd.settings, scheme: "classic" };
	sd.actionEvent("didReceiveSettings", { isInMultiAction: false });
	await sd.waitFor(() => sd.received.some((m) => m.event === "setTriggerDescription" && /amount/.test(m.payload.rotate)), "classic triggers");
	await sd.waitFor(() => /\+1:00 on press/.test(sd.text("hint") ?? ""), "classic hint");
	ok("switching to Classic updates trigger descriptions and the hint (+1:00 on press)");

	sd.rotate(1);
	await sd.waitFor(() => /\+1:30 on press/.test(sd.text("hint")), "pending 1:30");
	assert.equal(sd.text("time"), "5:00", "turning must not change the timer in classic");
	await sd.press();
	await sd.waitFor(() => sd.text("time") === "6:30", "added 1:30");
	await sd.press();
	await sd.waitFor(() => sd.text("time") === "8:00", "added again");
	ok("turn sets the amount, each press adds it (5:00 → 6:30 → 8:00)");

	sd.tap();
	await sd.waitFor(() => sd.text("status") === "RUNNING", "tap starts in classic");
	ok("tap starts the timer in Classic");

	sd.settings = { ...sd.settings, startTime: "2:00", scheme: "streamlined" };
	sd.actionEvent("didReceiveSettings", { isInMultiAction: false });
	await sleep(200);
	assert.equal(sd.text("status"), "RUNNING", "changing settings must not disturb a running timer");
	ok("editing settings doesn't disturb a running timer");

	sd.send({ event: "sendToPlugin", action: ACTION, context: CTX, payload: { event: "preview", sound: "sonar", volume: 50 } });
	sd.send({ event: "sendToPlugin", action: ACTION, context: CTX, payload: { event: "stop" } });
	await sleep(200);
	assert.equal(sd.child.exitCode, null, "plugin still alive");
	ok("preview/stop messages from the settings panel are handled");

	await sd.stop();
	console.log(`\nAll ${step} checks passed.`);
} catch (err) {
	console.error("\nFAILED:", err.message);
	await sd.stop().catch(() => {});
	process.exit(1);
}
