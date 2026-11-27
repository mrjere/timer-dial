import { formatElapsed, formatTime, remainingMs, type Scheme, SECOND, type TimerState } from "./timer/timer";

/**
 * Turns a timer state into touch-strip content. The keys match the item keys
 * in layouts/timer-dial.json. Kept free of Stream Deck calls so it's easy to
 * reason about (and test): state in, plain object out.
 */
export type StripView = {
	/** Full-strip colour panel. Hidden except during the alarm, so the user's own
	 *  touch-strip background (set in the Stream Deck app) shows through. */
	bg: { enabled: boolean; background: string };
	status: { value: string; color: string };
	time: { value: string; color: string };
	hint: { value: string; color: string };
	bar: { value: number; bar_fill_c: string };
};

const COLOR = {
	white: "#FFFFFF",
	grey: "#8E8E93",
	dim: "#48484A",
	green: "#30D158",
	amber: "#FFD60A",
	orange: "#FF9F0A",
	red: "#FF453A",
	alarmBg: "#B3001B",
	alarmBgDim: "#3D0009",
};

const HIDDEN_BG = { enabled: false, background: COLOR.alarmBg };

export function view(s: TimerState, now: number, scheme: Scheme, soundOn: boolean): StripView {
	const left = remainingMs(s, now);
	// Move the bar in whole-second steps, in sync with the digits. A smooth bar
	// would change on every 100 ms tick for short timers - far more strip
	// updates than needed (Elgato asks for at most 10 per second).
	const shownLeft = Math.ceil(left / SECOND) * SECOND;
	const pct = s.status === "idle" ? 100 : s.totalMs > 0 ? Math.round(Math.min(1, shownLeft / s.totalMs) * 100) : 0;
	const add = `+${formatTime(s.pendingMs)} on press`;

	switch (s.status) {
		case "idle":
			return {
				bg: HIDDEN_BG,
				status: { value: "READY", color: COLOR.grey },
				time: { value: formatTime(left), color: s.valueMs > 0 ? COLOR.white : COLOR.grey },
				hint: {
					value: scheme === "classic" ? `${add} · tap: start` : s.valueMs > 0 ? "Press to start" : "Turn to set a time",
					color: COLOR.grey,
				},
				bar: { value: 100, bar_fill_c: COLOR.dim },
			};

		case "running": {
			// Warn colour for the last 10% (or last 10 seconds of a short timer).
			const ending = left <= 10 * SECOND || pct <= 10;
			const accent = ending ? COLOR.orange : COLOR.green;
			return {
				bg: HIDDEN_BG,
				status: { value: "RUNNING", color: accent },
				time: { value: formatTime(left), color: COLOR.white },
				hint: { value: scheme === "classic" ? `${add} · tap: pause` : "Turn ± · press to pause", color: COLOR.grey },
				bar: { value: pct, bar_fill_c: accent },
			};
		}

		case "paused":
			return {
				bg: HIDDEN_BG,
				status: { value: "PAUSED", color: COLOR.amber },
				time: { value: formatTime(left), color: COLOR.amber },
				hint: { value: scheme === "classic" ? `${add} · tap: go` : "Press to resume · hold: reset", color: COLOR.grey },
				bar: { value: pct, bar_fill_c: COLOR.amber },
			};

		case "alarm": {
			const over = now - s.firedAt;
			// Flash twice a second while the sound plays (red panel on/off, with your
			// background showing in the "off" beats), then settle on a steady dark
			// red so a forgotten timer is obvious but not distracting.
			const flashOn = soundOn && Math.floor(over / 500) % 2 === 0;
			return {
				bg: soundOn ? { enabled: flashOn, background: COLOR.alarmBg } : { enabled: true, background: COLOR.alarmBgDim },
				status: { value: "TIME'S UP", color: soundOn && !flashOn ? COLOR.red : COLOR.white },
				time: { value: "0:00", color: COLOR.white },
				hint: { value: `+${formatElapsed(over)} · press to stop`, color: COLOR.white },
				bar: { value: 0, bar_fill_c: COLOR.red },
			};
		}
	}
}
