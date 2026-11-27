import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { scalePcm16 } from "../src/audio/wav.ts";

describe("WAV volume scaling (Windows volume control)", () => {
	const file = readFileSync(new URL("../com.jere.timerdial.sdPlugin/sounds/desk-bell.wav", import.meta.url));

	it("halves every sample and leaves the 44-byte header untouched", () => {
		const half = scalePcm16(file, 0.5);
		assert.ok(half);
		assert.equal(half.length, file.length);
		assert.deepEqual(half.subarray(0, 44), file.subarray(0, 44));
		for (const i of [44, 1000, 20_000, 100_000]) {
			assert.ok(Math.abs(half.readInt16LE(i) - file.readInt16LE(i) / 2) <= 0.5, `sample at byte ${i}`);
		}
	});

	it("does not modify the original buffer", () => {
		const copy = Buffer.from(file);
		scalePcm16(file, 0.1);
		assert.deepEqual(file, copy);
	});

	it("refuses things that aren't 16-bit PCM WAV", () => {
		assert.equal(scalePcm16(Buffer.from("ID3 definitely an mp3"), 0.5), undefined);
		const float32 = Buffer.from(file);
		float32.writeUInt16LE(3, 20); // format tag 3 = IEEE float
		assert.equal(scalePcm16(float32, 0.5), undefined);
	});
});
