import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows' built-in player (System.Media.SoundPlayer) has no volume control,
 * so on Windows we make a quieter copy of the WAV ourselves. A 16-bit PCM WAV
 * is just a header followed by numbers from -32768..32767; multiplying every
 * sample by the gain (0..1) scales the volume.
 *
 * Returns the path of the scaled copy, or the original path when no scaling
 * is needed or the file isn't 16-bit PCM (it then plays at full volume).
 */
export function wavAtVolume(file: string, gain: number): string {
	if (gain >= 0.999) return file;
	try {
		const { mtimeMs } = statSync(file);
		const key = createHash("sha1").update(`${file}|${mtimeMs}|${gain.toFixed(3)}`).digest("hex").slice(0, 16);
		const dir = path.join(os.tmpdir(), "timer-dial-sounds");
		const out = path.join(dir, `${key}.wav`);
		if (existsSync(out)) return out; // cached from a previous ring

		const scaled = scalePcm16(readFileSync(file), gain);
		if (!scaled) return file;
		mkdirSync(dir, { recursive: true });
		writeFileSync(out, scaled);
		return out;
	} catch {
		return file;
	}
}

/** Exported for testing. Returns undefined for anything other than 16-bit PCM WAV. */
export function scalePcm16(input: Buffer, gain: number): Buffer | undefined {
	if (input.length < 12 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") {
		return undefined;
	}

	// A WAV file is a list of "chunks" (id + size + data). Walk them to find
	// the format description ("fmt ") and the audio samples ("data").
	let offset = 12;
	let format: { tag: number; bits: number } | undefined;
	let data: { start: number; size: number } | undefined;
	while (offset + 8 <= input.length) {
		const id = input.toString("ascii", offset, offset + 4);
		const size = input.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt " && size >= 16) {
			let tag = input.readUInt16LE(body);
			const bits = input.readUInt16LE(body + 14);
			// WAVE_FORMAT_EXTENSIBLE stores the real format in a sub-format GUID.
			if (tag === 0xfffe && size >= 26) tag = input.readUInt16LE(body + 24);
			format = { tag, bits };
		} else if (id === "data") {
			data = { start: body, size: Math.min(size, input.length - body) };
		}
		offset = body + size + (size % 2); // chunks are padded to even sizes
	}

	if (!format || !data || format.tag !== 1 || format.bits !== 16) return undefined;

	const out = Buffer.from(input); // copy, never modify the original
	const end = data.start + data.size - 1;
	for (let i = data.start; i < end; i += 2) {
		out.writeInt16LE(Math.round(input.readInt16LE(i) * gain), i);
	}
	return out;
}
