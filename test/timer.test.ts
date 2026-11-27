/**
 * Unit tests for the timer state machine. Run with: npm test
 *
 * Uses Node's built-in test runner (node:test) - no extra framework needed.
 * Because the logic is pure, "time passing" is just a bigger `now` value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	addPending,
	createTimer,
	dismiss,
	formatElapsed,
	formatTime,
	fractionLeft,
	HOUR,
	MAX_MS,
	MINUTE,
	parseDuration,
	remainingMs,
	reset,
	rotate,
	SECOND,
	stepValue,
	tick,
	toggle,
} from "../src/timer/timer.ts";

const T0 = 1_000_000; // an arbitrary "now"

describe("smart steps", () => {
	it("uses 5 s steps under a minute", () => {
		assert.equal(stepValue(0, 1, true), 5 * SECOND);
		assert.equal(stepValue(55 * SECOND, 1, true), MINUTE);
	});
	it("uses 30 s steps from 1 to 10 minutes and snaps to the grid", () => {
		assert.equal(stepValue(MINUTE, 1, true), 90 * SECOND);
		assert.equal(stepValue(4 * MINUTE + 37 * SECOND, 1, true), 5 * MINUTE);
		assert.equal(stepValue(4 * MINUTE + 37 * SECOND, -1, true), 4 * MINUTE + 30 * SECOND);
	});
	it("steps down using the band below (10:00 -> 9:30, 1:00 -> 0:55)", () => {
		assert.equal(stepValue(10 * MINUTE, -1, true), 9 * MINUTE + 30 * SECOND);
		assert.equal(stepValue(MINUTE, -1, true), 55 * SECOND);
	});
	it("uses whole minutes between 10 and 60 minutes", () => {
		assert.equal(stepValue(10 * MINUTE, 1, true), 11 * MINUTE);
	});
	it("never goes below zero or above 24 h", () => {
		assert.equal(stepValue(0, -1, true), 0);
		assert.equal(stepValue(MAX_MS, 1, true), MAX_MS);
	});
	it("nudges by an exact step when not snapping", () => {
		assert.equal(stepValue(4 * MINUTE + 37 * SECOND, 1, false), 5 * MINUTE + 7 * SECOND);
	});
});

describe("streamlined scheme", () => {
	it("turning sets the time while idle", () => {
		let s = createTimer(0);
		s = rotate(s, 12, T0, "streamlined"); // 12 x 5 s
		assert.equal(s.valueMs, MINUTE);
		s = rotate(s, 2, T0, "streamlined"); // 2 x 30 s
		assert.equal(s.valueMs, 2 * MINUTE);
	});

	it("a fast spin (many ticks in one event) crosses step bands correctly", () => {
		const s = rotate(createTimer(50 * SECOND), 4, T0, "streamlined");
		// 0:55, 1:00, 1:30, 2:00
		assert.equal(s.valueMs, 2 * MINUTE);
	});

	it("push-and-turn jumps in 5 minute steps", () => {
		const s = rotate(createTimer(3 * MINUTE), 2, T0, "streamlined", true);
		assert.equal(s.valueMs, 10 * MINUTE);
	});

	it("start, pause, resume keeps the right remaining time", () => {
		let s = toggle(createTimer(5 * MINUTE), T0);
		assert.equal(s.status, "running");
		assert.equal(remainingMs(s, T0 + 2 * MINUTE), 3 * MINUTE);

		s = toggle(s, T0 + 2 * MINUTE); // pause
		assert.equal(s.status, "paused");
		assert.equal(remainingMs(s, T0 + 99 * MINUTE), 3 * MINUTE, "paused time must not drain");

		s = toggle(s, T0 + 10 * MINUTE); // resume later
		assert.equal(remainingMs(s, T0 + 11 * MINUTE), 2 * MINUTE);
	});

	it("does nothing when started at 0:00", () => {
		const s = createTimer(0);
		assert.equal(toggle(s, T0), s);
	});

	it("turning while running nudges the remaining time", () => {
		let s = toggle(createTimer(5 * MINUTE), T0);
		s = rotate(s, 1, T0 + MINUTE, "streamlined"); // 4:00 left + 30 s
		assert.equal(remainingMs(s, T0 + MINUTE), 4 * MINUTE + 30 * SECOND);
		assert.equal(s.status, "running");
	});

	it("spinning a running timer down to zero cancels it instead of ringing", () => {
		let s = toggle(createTimer(10 * SECOND), T0);
		s = rotate(s, -5, T0, "streamlined");
		assert.equal(s.status, "idle");
		assert.equal(s.valueMs, 0);
	});

	it("fires the alarm exactly at the end time", () => {
		const running = toggle(createTimer(MINUTE), T0);
		assert.equal(tick(running, T0 + MINUTE - 1).fired, false);
		const { state, fired } = tick(running, T0 + MINUTE + 50);
		assert.equal(fired, true);
		assert.equal(state.status, "alarm");
		assert.equal(state.firedAt, T0 + MINUTE, "firedAt is the true end time, not when we noticed");
	});

	it("dismissing the alarm restores the time it was started with", () => {
		let s = toggle(createTimer(4 * MINUTE), T0);
		s = rotate(s, 2, T0, "streamlined"); // nudges don't change the reset point
		s = tick(s, T0 + HOUR).state;
		s = dismiss(s);
		assert.equal(s.status, "idle");
		assert.equal(s.valueMs, 4 * MINUTE);
	});

	it("toggle while ringing dismisses, and the dial is ignored while ringing", () => {
		const ringing = tick(toggle(createTimer(MINUTE), T0), T0 + 2 * MINUTE).state;
		assert.equal(rotate(ringing, 3, T0, "streamlined"), ringing);
		assert.equal(toggle(ringing, T0).status, "idle");
	});

	it("long press: running -> start time, idle -> configured default", () => {
		let s = toggle(createTimer(4 * MINUTE), T0);
		s = reset(s, 10 * MINUTE);
		assert.deepEqual([s.status, s.valueMs], ["idle", 4 * MINUTE]);
		s = reset(s, 10 * MINUTE);
		assert.deepEqual([s.status, s.valueMs], ["idle", 10 * MINUTE]);
	});

	it("progress fraction drains from 1 to 0", () => {
		const s = toggle(createTimer(4 * MINUTE), T0);
		assert.equal(fractionLeft(s, T0), 1);
		assert.equal(fractionLeft(s, T0 + MINUTE), 0.75);
		assert.equal(fractionLeft(tick(s, T0 + 5 * MINUTE).state, T0 + 5 * MINUTE), 0);
	});
});

describe("classic scheme", () => {
	it("turning changes the amount to add, not the timer", () => {
		let s = createTimer(0);
		s = rotate(s, 1, T0, "classic"); // default pending 1:00 -> 1:30
		assert.equal(s.pendingMs, 90 * SECOND);
		assert.equal(s.valueMs, 0);
	});

	it("press adds the amount, repeatedly", () => {
		let s = createTimer(0, 5 * MINUTE);
		s = addPending(s, T0);
		s = addPending(s, T0);
		assert.equal(s.valueMs, 10 * MINUTE);
	});

	it("press while running extends the countdown", () => {
		let s = toggle(createTimer(MINUTE, 2 * MINUTE), T0);
		s = addPending(s, T0 + 30 * SECOND);
		assert.equal(remainingMs(s, T0 + 30 * SECOND), 2 * MINUTE + 30 * SECOND);
		assert.equal(fractionLeft(s, T0 + 30 * SECOND), 1, "bar total grows with added time");
	});

	it("press while ringing dismisses", () => {
		const ringing = tick(toggle(createTimer(MINUTE), T0), T0 + 2 * MINUTE).state;
		assert.equal(addPending(ringing, T0).status, "idle");
	});
});

describe("formatting and parsing", () => {
	it("formats with ceil-to-second semantics", () => {
		assert.equal(formatTime(0), "0:00");
		assert.equal(formatTime(1), "0:01");
		assert.equal(formatTime(4 * MINUTE + 30 * SECOND), "4:30");
		assert.equal(formatTime(4 * MINUTE + 29_001), "4:30");
		assert.equal(formatTime(HOUR + 5 * SECOND), "1:00:05");
		assert.equal(formatElapsed(1_999), "0:01");
	});

	it("parses the formats people type", () => {
		assert.equal(parseDuration("5"), 5 * MINUTE);
		assert.equal(parseDuration("2.5"), 150 * SECOND);
		assert.equal(parseDuration("4:30"), 270 * SECOND);
		assert.equal(parseDuration("1:15:00"), HOUR + 15 * MINUTE);
		assert.equal(parseDuration("90s"), 90 * SECOND);
		assert.equal(parseDuration("1h30m"), 90 * MINUTE);
		assert.equal(parseDuration(" 25 min "), 25 * MINUTE);
		assert.equal(parseDuration(""), undefined);
		assert.equal(parseDuration("soon"), undefined);
		assert.equal(parseDuration("99:00:00"), MAX_MS);
	});
});
