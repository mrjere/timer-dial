import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type PropertyInspectorDidDisappearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { SoundPlayer } from "../audio/player";
import { CUSTOM_SOUND, DEFAULT_SOUND, resolveSoundFile } from "../audio/sounds";
import { view } from "../render";
import { TimerStore } from "../store";
import * as timer from "../timer/timer";

/** Settings edited in the property inspector (ui/timer-dial.html). */
export type TimerSettings = {
	scheme?: timer.Scheme;
	startTime?: string;
	sound?: string;
	customSound?: string;
	volume?: number;
	alarmLength?: string;
};

/** Defaults live in the plugin, not the UI: settings can be empty for a freshly-dropped action. */
const DEFAULTS = {
	scheme: "streamlined" as timer.Scheme,
	startMs: 5 * timer.MINUTE,
	volume: 80,
	alarmLength: "30",
};

const LONG_PRESS_MS = 500;
/** After a turn dismisses the alarm, ignore the rest of that turn so it doesn't also change the time. */
const DISMISS_GRACE_MS = 600;
const TICK_MS = 100;

type Press = { longTimer?: NodeJS.Timeout; longFired: boolean; rotated: boolean; swallow: boolean };

/** Everything we track per timer on the device. */
type Entry = {
	state: timer.TimerState;
	settings: TimerSettings;
	customResource?: string;
	alarm: SoundPlayer;
	press?: Press;
	ignoreRotateUntil: number;
	/** Last values sent to the touch strip, so we only send what changed. */
	sent: Record<string, string>;
};

/** JSON value type, borrowed from the SDK's own signature (it isn't exported directly). */
type JsonValue = Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0];

const log = streamDeck.logger.createScope("TimerDial");
const previewPlayer = new SoundPlayer();

@action({ UUID: "com.jere.timerdial.timer" })
export class TimerDial extends SingletonAction<TimerSettings> {
	/**
	 * State is keyed by action id and deliberately NOT deleted when an action
	 * disappears (e.g. you flip to another page) - the countdown keeps going
	 * and the alarm still rings. One SingletonAction instance serves every
	 * copy of the action, so per-copy state has to live in a map like this.
	 */
	readonly #entries = new Map<string, Entry>();
	readonly #store = new TimerStore();
	#ticker?: NodeJS.Timeout;

	// ---------------------------------------------------------------- lifecycle

	override async onWillAppear(ev: WillAppearEvent<TimerSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		await this.#store.ready;

		const settings = ev.payload.settings ?? {};
		let entry = this.#entries.get(ev.action.id);
		if (!entry) {
			const restored = this.#store.restore(ev.action.id, Date.now());
			entry = {
				state: restored ?? timer.createTimer(startMsOf(settings)),
				settings,
				alarm: new SoundPlayer(),
				ignoreRotateUntil: 0,
				sent: {},
			};
			this.#entries.set(ev.action.id, entry);
			if (restored) log.info(`Restored ${restored.status} timer ${ev.action.id}`);
		}
		entry.settings = settings;
		entry.customResource = ev.payload.resources?.customSound;
		entry.sent = {}; // the strip was redrawn by Stream Deck: send everything again

		await ev.action.setTitle("Timer"); // ignored if the user typed their own title
		await this.#describeTriggers(ev.action, settings);
		this.#render(ev.action.id);
		this.#syncTicker();
	}

	override onWillDisappear(ev: WillDisappearEvent<TimerSettings>): void {
		const entry = this.#entries.get(ev.action.id);
		if (entry?.press) {
			clearTimeout(entry.press.longTimer);
			entry.press = undefined;
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TimerSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const entry = this.#entries.get(ev.action.id);
		if (!entry) return;

		const old = entry.settings;
		const settings = ev.payload.settings ?? {};
		entry.settings = settings;

		// Changing "Start time" in the panel shows the new time straight away (if the timer isn't in use).
		if (settings.startTime !== old.startTime && entry.state.status === "idle") {
			entry.state = timer.reset(entry.state, startMsOf(settings));
		}

		// Embed the custom sound in the action, so exporting the profile takes the file along with it.
		if (settings.customSound !== old.customSound) {
			await ev.action.setResources(settings.customSound ? { customSound: settings.customSound } : {});
			entry.customResource = settings.customSound;
		}

		if (settings.scheme !== old.scheme) await this.#describeTriggers(ev.action, settings);
		this.#render(ev.action.id);
	}

	// ------------------------------------------------------------- dial + touch

	override onDialRotate(ev: DialRotateEvent<TimerSettings>): void {
		const entry = this.#entries.get(ev.action.id);
		if (!entry) return;
		const now = Date.now();

		if (entry.state.status === "alarm") {
			entry.ignoreRotateUntil = now + DISMISS_GRACE_MS;
			return this.#update(ev.action.id, timer.dismiss(entry.state));
		}
		if (now < entry.ignoreRotateUntil) return;

		// Turning while held = coarse 5-minute jumps. It also cancels the pending
		// press, so letting go afterwards doesn't start/stop the timer.
		const coarse = ev.payload.pressed;
		if (coarse && entry.press) {
			entry.press.rotated = true;
			clearTimeout(entry.press.longTimer);
		}
		this.#update(ev.action.id, timer.rotate(entry.state, ev.payload.ticks, now, schemeOf(entry), coarse));
	}

	override onDialDown(ev: DialDownEvent<TimerSettings>): void {
		const entry = this.#entries.get(ev.action.id);
		if (!entry) return;

		// Ringing? Stop it on the way DOWN for instant response, and swallow the release.
		if (entry.state.status === "alarm") {
			entry.press = { longFired: false, rotated: false, swallow: true };
			return this.#update(ev.action.id, timer.dismiss(entry.state));
		}

		// There is no built-in "long press" event, so time it ourselves. Reset fires
		// while the dial is still held (at 500 ms) - you feel/see it happen, rather
		// than having to guess when it's safe to let go.
		const press: Press = { longFired: false, rotated: false, swallow: false };
		press.longTimer = setTimeout(() => {
			if (press.rotated || entry.press !== press) return;
			press.longFired = true;
			this.#update(ev.action.id, timer.reset(entry.state, startMsOf(entry.settings)));
		}, LONG_PRESS_MS);
		entry.press = press;
	}

	override async onDialUp(ev: DialUpEvent<TimerSettings>): Promise<void> {
		const entry = this.#entries.get(ev.action.id);
		const press = entry?.press;
		if (!entry || !press) return;
		entry.press = undefined;
		clearTimeout(press.longTimer);
		if (press.swallow || press.longFired || press.rotated) return;

		// A short press is only known to be short once it's released.
		const before = entry.state;
		const after = schemeOf(entry) === "classic" ? timer.addPending(before, Date.now()) : timer.toggle(before, Date.now());
		if (after === before) return void (await ev.action.showAlert()); // e.g. start at 0:00
		this.#update(ev.action.id, after);
	}

	override async onTouchTap(ev: TouchTapEvent<TimerSettings>): Promise<void> {
		const entry = this.#entries.get(ev.action.id);
		if (!entry) return;
		const s = entry.state;

		if (s.status === "alarm") return this.#update(ev.action.id, timer.dismiss(s));
		if (ev.payload.hold) return this.#update(ev.action.id, timer.reset(s, startMsOf(entry.settings)));

		const after = timer.toggle(s, Date.now());
		if (after === s) return void (await ev.action.showAlert());
		this.#update(ev.action.id, after);
	}

	// ------------------------------------------------- property inspector chat

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, TimerSettings>): Promise<void> {
		const msg = ev.payload as { event?: string; sound?: string; customSound?: string; volume?: number };
		if (msg?.event === "preview") {
			const entry = this.#entries.get(ev.action.id);
			// The panel sends its current values so the preview matches what's on screen,
			// even if the (debounced) settings save hasn't landed yet.
			previewPlayer.play({
				file: resolveSoundFile(msg.sound, [msg.customSound, entry?.customResource]),
				volume: typeof msg.volume === "number" ? msg.volume : DEFAULTS.volume,
				loop: false,
				maxMs: 15_000,
			});
		} else if (msg?.event === "stop") {
			previewPlayer.stop();
		}
	}

	override onPropertyInspectorDidDisappear(_ev: PropertyInspectorDidDisappearEvent<TimerSettings>): void {
		previewPlayer.stop();
	}

	// ------------------------------------------------------------------ helpers

	/** Single place where state changes land: side effects (sound, saving, drawing) follow from here. */
	#update(id: string, next: timer.TimerState): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		const prev = entry.state;
		entry.state = next;

		if (prev.status === "alarm" && next.status !== "alarm") entry.alarm.stop();
		if (prev.status !== next.status) log.info(`${id.slice(0, 8)}: ${prev.status} -> ${next.status}`);

		this.#store.save(id, next);
		this.#render(id);
		this.#syncTicker();
	}

	#ring(id: string, entry: Entry): void {
		const { settings } = entry;
		const length = settings.alarmLength ?? DEFAULTS.alarmLength;
		const once = length === "once";
		const maxMs = once ? 30_000 : length === "until" ? 10 * timer.MINUTE : (Number(length) || 30) * 1000;

		entry.alarm.play({
			file: resolveSoundFile(settings.sound ?? DEFAULT_SOUND, [entry.customResource, settings.customSound]),
			volume: settings.volume ?? DEFAULTS.volume,
			loop: !once,
			maxMs,
			onEnd: () => this.#render(id), // switch from flashing to steady red
		});
		if (settings.sound === CUSTOM_SOUND && !entry.customResource && !settings.customSound) {
			log.warn("Custom sound selected but no file chosen; using the default sound");
		}
	}

	/** One shared clock for all timers, running only while something needs it. */
	#syncTicker(): void {
		const needed = [...this.#entries.values()].some((e) => e.state.status === "running" || e.state.status === "alarm");
		if (needed && !this.#ticker) {
			this.#ticker = setInterval(() => this.#onTick(), TICK_MS);
		} else if (!needed && this.#ticker) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	#onTick(): void {
		const now = Date.now();
		for (const [id, entry] of this.#entries) {
			const { state, fired } = timer.tick(entry.state, now);
			if (fired) {
				entry.state = state;
				log.info(`${id.slice(0, 8)}: time's up`);
				this.#store.save(id, state);
				this.#ring(id, entry); // rings even if the dial is on another page
			}
			if (entry.state.status === "running" || entry.state.status === "alarm") this.#render(id);
		}
		this.#syncTicker();
	}

	/**
	 * Draws the touch strip - but only sends the parts that changed. The ticker
	 * runs 10x a second, yet the display only changes about once a second, and
	 * Elgato's guidelines ask for no more than 10 updates per second.
	 */
	#render(id: string): void {
		const entry = this.#entries.get(id);
		const action = streamDeck.actions.getActionById(id); // undefined when not on screen
		if (!entry || !action?.isDial()) return;

		const full = view(entry.state, Date.now(), schemeOf(entry), entry.alarm.playing);
		const changed: Record<string, object> = {};
		for (const [key, value] of Object.entries(full)) {
			const json = JSON.stringify(value);
			if (entry.sent[key] !== json) {
				changed[key] = value;
				entry.sent[key] = json;
			}
		}
		if (Object.keys(changed).length === 0) return;
		action.setFeedback(changed).catch((err) => log.error("setFeedback failed", err));
	}

	async #describeTriggers(action: DialAction<TimerSettings>, settings: TimerSettings): Promise<void> {
		// Shown in the Stream Deck app when the dial is selected - free, built-in documentation.
		await action.setTriggerDescription(
			(settings.scheme ?? DEFAULTS.scheme) === "classic"
				? { rotate: "Choose amount to add", push: "Add time (hold: reset)", touch: "Start / pause", longTouch: "Reset" }
				: { rotate: "Set time (push + turn: ±5 min)", push: "Start / pause (hold: reset)", touch: "Start / pause", longTouch: "Reset" },
		);
	}
}

function schemeOf(entry: Entry): timer.Scheme {
	return entry.settings.scheme === "classic" ? "classic" : DEFAULTS.scheme;
}

/** Start time from settings: missing -> 5:00, deliberately blank -> 0:00, typo -> 5:00. */
function startMsOf(settings: TimerSettings): number {
	if (settings.startTime === undefined) return DEFAULTS.startMs;
	if (settings.startTime.trim() === "") return 0;
	return timer.parseDuration(settings.startTime) ?? DEFAULTS.startMs;
}
