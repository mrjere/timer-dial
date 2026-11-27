import streamDeck from "@elgato/streamdeck";

import { type TimerState } from "./timer/timer";

/**
 * Remembers running/paused timers across a Stream Deck restart (app update,
 * reboot of the app, etc.).
 *
 * Why *global* settings rather than the action's own settings? The settings
 * panel (property inspector) also writes the action's settings, and it sends
 * the whole object each time. If the plugin wrote countdown state into the
 * same object, the panel could overwrite it with a stale copy. Keeping
 * runtime state in a separate store avoids that race entirely.
 */
type Saved = Pick<TimerState, "status" | "valueMs" | "endsAt" | "totalMs" | "resetToMs" | "pendingMs"> & { savedAt: number };
type GlobalSettings = { timers?: Record<string, Saved> };

const FORGET_AFTER_MS = 48 * 60 * 60 * 1000;
/** A timer that ran out while Stream Deck was closed still rings if it's this recent. */
const LATE_RING_WINDOW_MS = 2 * 60 * 1000;

export class TimerStore {
	#data: Record<string, Saved> = {};
	#writeTimer?: NodeJS.Timeout;
	readonly ready: Promise<void>;

	constructor() {
		this.ready = this.#load();
	}

	async #load(): Promise<void> {
		try {
			const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
			const now = Date.now();
			for (const [id, saved] of Object.entries(settings.timers ?? {})) {
				if (now - saved.savedAt < FORGET_AFTER_MS) this.#data[id] = saved;
			}
		} catch (err) {
			streamDeck.logger.warn("Could not load saved timers", err);
		}
	}

	/** Returns the saved state for an action, adjusted for the time that passed while we were away. */
	restore(id: string, now: number): TimerState | undefined {
		const saved = this.#data[id];
		if (!saved) return undefined;
		const base: TimerState = { ...saved, firedAt: 0 };
		if (saved.status === "running" && now - saved.endsAt > LATE_RING_WINDOW_MS) {
			// Long finished: don't blast an alarm for something that ended ages ago.
			return { ...base, status: "idle", valueMs: saved.resetToMs, totalMs: saved.resetToMs };
		}
		return base; // a running timer whose end has passed fires on the next tick
	}

	save(id: string, s: TimerState): void {
		if (s.status === "running" || s.status === "paused") {
			const { status, valueMs, endsAt, totalMs, resetToMs, pendingMs } = s;
			this.#data[id] = { status, valueMs, endsAt, totalMs, resetToMs, pendingMs, savedAt: Date.now() };
		} else if (this.#data[id]) {
			delete this.#data[id];
		} else {
			return; // nothing changed
		}
		// Debounce: spinning the dial on a running timer shouldn't write to disk 20 times a second.
		clearTimeout(this.#writeTimer);
		this.#writeTimer = setTimeout(() => {
			streamDeck.settings.setGlobalSettings<GlobalSettings>({ timers: this.#data }).catch((err) => {
				streamDeck.logger.warn("Could not save timers", err);
			});
		}, 500);
	}
}
