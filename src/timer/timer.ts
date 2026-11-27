/**
 * Timer logic: a small, pure state machine.
 *
 * "Pure" means every function takes the current state (and the current time)
 * and returns a NEW state, without touching the Stream Deck, the clock or the
 * speakers. That separation is deliberate:
 *   - it can be unit-tested in milliseconds, with no hardware (see test/timer.test.ts);
 *   - time is passed in (`now`) rather than read from Date.now(), so tests can
 *     "fast-forward" by just passing a bigger number;
 *   - the Stream Deck glue (src/actions/timer-dial.ts) stays thin and boring.
 *
 * Timing is stored as an absolute end time (`endsAt`) rather than a counter
 * decremented every tick. Counters drift (timers fire late, the PC sleeps);
 * an end time is always correct whenever you look at it.
 *
 * NOTE: this file must stay free of other local imports and TypeScript-only
 * runtime features (enums etc.) so Node can run the tests directly.
 */

export type Status = "idle" | "running" | "paused" | "alarm";
export type Scheme = "streamlined" | "classic";

export type TimerState = {
	readonly status: Status;
	/** idle: the dialled time. paused: the time remaining. */
	readonly valueMs: number;
	/** running: epoch ms when the timer reaches zero. */
	readonly endsAt: number;
	/** Length used for the progress bar (grows if time is added while running). */
	readonly totalMs: number;
	/** What a reset (or dismissing the alarm) goes back to: the time you started with. */
	readonly resetToMs: number;
	/** Classic scheme only: the amount a short press adds. */
	readonly pendingMs: number;
	/** alarm: epoch ms when the timer hit zero (used to show overtime). */
	readonly firedAt: number;
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const MAX_MS = 24 * HOUR;
export const COARSE_STEP_MS = 5 * MINUTE;

/**
 * "Smart" step sizes: small steps for short times, bigger ones as the value grows.
 * One detent of the dial therefore always feels like a sensible amount.
 */
const STEP_BANDS: ReadonlyArray<readonly [below: number, step: number]> = [
	[1 * MINUTE, 5 * SECOND],
	[10 * MINUTE, 30 * SECOND],
	[60 * MINUTE, 1 * MINUTE],
	[3 * HOUR, 5 * MINUTE],
	[Infinity, 15 * MINUTE],
];

export function stepFor(valueMs: number): number {
	for (const [below, step] of STEP_BANDS) {
		if (valueMs < below) return step;
	}
	return STEP_BANDS[STEP_BANDS.length - 1][1];
}

const clamp = (ms: number): number => Math.min(MAX_MS, Math.max(0, ms));

/**
 * Moves a value one step up or down.
 * @param snap Round onto the step grid (4:37 -> 5:00 going up, 4:30 going down).
 *             Used when *setting* a time. When nudging a live countdown we add an
 *             exact step instead, because snapping a moving number feels random.
 * @param fixedStep Override the smart step (used for push-and-turn coarse jumps).
 */
export function stepValue(valueMs: number, direction: 1 | -1, snap: boolean, fixedStep?: number): number {
	// Going down uses the band *below* the value, so 10:00 -> 9:30 rather than 9:00.
	const step = fixedStep ?? stepFor(direction > 0 ? valueMs : valueMs - 1);
	if (!snap) return clamp(valueMs + direction * step);
	const next = direction > 0 ? Math.floor(valueMs / step) * step + step : Math.ceil(valueMs / step) * step - step;
	return clamp(next);
}

function applyTicks(valueMs: number, ticks: number, snap: boolean, fixedStep?: number): number {
	const direction = ticks > 0 ? 1 : -1;
	let value = valueMs;
	// Apply one detent at a time so a fast spin crosses band boundaries correctly.
	for (let i = 0; i < Math.abs(ticks); i++) value = stepValue(value, direction, snap, fixedStep);
	return value;
}

export function createTimer(startMs: number, pendingMs = MINUTE): TimerState {
	const value = clamp(startMs);
	return { status: "idle", valueMs: value, endsAt: 0, totalMs: value, resetToMs: value, pendingMs, firedAt: 0 };
}

export function remainingMs(s: TimerState, now: number): number {
	switch (s.status) {
		case "running":
			return Math.max(0, s.endsAt - now);
		case "alarm":
			return 0;
		default:
			return s.valueMs;
	}
}

/** 0..1, how much of the countdown is left (for the progress bar). */
export function fractionLeft(s: TimerState, now: number): number {
	if (s.status === "idle") return 1;
	if (s.status === "alarm" || s.totalMs <= 0) return 0;
	return Math.min(1, remainingMs(s, now) / s.totalMs);
}

/** Turning the dial. `coarse` = the dial is being held down while turning. */
export function rotate(s: TimerState, ticks: number, now: number, scheme: Scheme, coarse = false): TimerState {
	if (ticks === 0 || s.status === "alarm") return s;
	const fixed = coarse ? COARSE_STEP_MS : undefined;

	if (scheme === "classic") {
		// Classic: the dial chooses how much a press will add.
		return { ...s, pendingMs: applyTicks(s.pendingMs, ticks, true, fixed) };
	}

	switch (s.status) {
		case "idle":
			return { ...s, valueMs: applyTicks(s.valueMs, ticks, true, fixed) };

		case "paused": {
			const value = applyTicks(s.valueMs, ticks, true, fixed);
			if (value <= 0) return { ...s, status: "idle", valueMs: 0 };
			return { ...s, valueMs: value, totalMs: Math.max(s.totalMs, value) };
		}

		case "running": {
			const left = applyTicks(remainingMs(s, now), ticks, false, fixed);
			// Spinning a running timer all the way down cancels it rather than
			// setting the alarm off, which would be a nasty surprise.
			if (left <= 0) return { ...s, status: "idle", valueMs: 0 };
			return { ...s, endsAt: now + left, totalMs: Math.max(s.totalMs, left) };
		}
	}
}

/** Start if stopped, pause if running, dismiss if ringing. */
export function toggle(s: TimerState, now: number): TimerState {
	switch (s.status) {
		case "idle":
			if (s.valueMs <= 0) return s; // nothing to count down
			return { ...s, status: "running", endsAt: now + s.valueMs, totalMs: s.valueMs, resetToMs: s.valueMs };
		case "running":
			return { ...s, status: "paused", valueMs: remainingMs(s, now) };
		case "paused":
			return { ...s, status: "running", endsAt: now + s.valueMs };
		case "alarm":
			return dismiss(s);
	}
}

/** Classic scheme short press: add the dialled amount (works while running too). */
export function addPending(s: TimerState, now: number): TimerState {
	if (s.status === "alarm") return dismiss(s);
	if (s.pendingMs <= 0) return s;
	switch (s.status) {
		case "idle":
			return { ...s, valueMs: clamp(s.valueMs + s.pendingMs) };
		case "paused": {
			const value = clamp(s.valueMs + s.pendingMs);
			return { ...s, valueMs: value, totalMs: Math.max(s.totalMs, value) };
		}
		case "running": {
			const left = clamp(remainingMs(s, now) + s.pendingMs);
			return { ...s, endsAt: now + left, totalMs: Math.max(s.totalMs, left) };
		}
	}
}

/**
 * Long press. A running/paused/ringing timer goes back to the time it was
 * started with (so "go again" is one press); an idle one goes back to the
 * configured start time.
 */
export function reset(s: TimerState, defaultMs: number): TimerState {
	const value = s.status === "idle" ? clamp(defaultMs) : s.resetToMs;
	return { ...s, status: "idle", valueMs: value, totalMs: value, endsAt: 0, firedAt: 0 };
}

export function dismiss(s: TimerState): TimerState {
	if (s.status !== "alarm") return s;
	return { ...s, status: "idle", valueMs: s.resetToMs, totalMs: s.resetToMs, firedAt: 0 };
}

/** Called regularly; flips a running timer into the alarm state when it reaches zero. */
export function tick(s: TimerState, now: number): { state: TimerState; fired: boolean } {
	if (s.status === "running" && now >= s.endsAt) {
		return { state: { ...s, status: "alarm", valueMs: 0, firedAt: s.endsAt }, fired: true };
	}
	return { state: s, fired: false };
}

/**
 * 4:30, 12:05, 1:00:00. Rounds UP to the next whole second, the convention for
 * countdowns: it shows "0:01" until the time has truly run out, and shows the
 * full time (not one second less) the instant you press start.
 */
export function formatTime(ms: number): string {
	const total = Math.ceil(Math.max(0, ms) / SECOND);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	const ss = String(sec).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** For elapsed time (overtime), round DOWN so it ticks up in whole seconds from +0:00. */
export function formatElapsed(ms: number): string {
	return formatTime(Math.floor(Math.max(0, ms) / SECOND) * SECOND);
}

/**
 * Parses what a person might type into the "Start time" box:
 *   "5"  -> 5 minutes        "90s" -> 1:30        "1h30m" -> 1:30:00
 *   "4:30" -> 4 min 30 s     "1:15:00" -> 1 h 15 min
 * Returns undefined for blank or unrecognised input.
 */
export function parseDuration(text: string | undefined): number | undefined {
	const t = (text ?? "").trim().toLowerCase();
	if (!t) return undefined;

	if (/^\d+(\.\d+)?$/.test(t)) return clamp(Math.round(parseFloat(t) * MINUTE));

	const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
	if (colon) {
		const [a, b, c] = colon.slice(1).map((v) => (v === undefined ? undefined : parseInt(v, 10)));
		if (c === undefined) return clamp(a! * MINUTE + b! * SECOND);
		return clamp(a! * HOUR + b! * MINUTE + c * SECOND);
	}

	const units = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/.exec(t);
	if (units && (units[1] || units[2] || units[3])) {
		const [h, m, s] = units.slice(1).map((v) => (v ? parseInt(v, 10) : 0));
		return clamp(h * HOUR + m * MINUTE + s * SECOND);
	}
	return undefined;
}
