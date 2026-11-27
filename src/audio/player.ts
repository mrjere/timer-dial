import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import { wavAtVolume } from "./wav";

export type PlayOptions = {
	file: string;
	/** 0-100, as shown on the slider. */
	volume: number;
	/** Repeat until stop() or maxMs. */
	loop: boolean;
	/** Hard limit on how long sound may play, even if nobody presses anything. */
	maxMs: number;
	/** Called once when playback ends for any reason. */
	onEnd?: () => void;
};

const LOOP_GAP_MS = 350;
const live = new Set<SoundPlayer>();

/**
 * Plays WAV files using the operating system's own tools, because Node.js has
 * no audio API and Stream Deck plugins can't load native add-ons:
 *   - macOS:   /usr/bin/afplay (ships with every Mac, has a volume flag)
 *   - Windows: PowerShell + System.Media.SoundPlayer (built into Windows)
 *
 * One SoundPlayer = one sound at a time; play() replaces whatever was playing.
 */
export class SoundPlayer {
	#child?: ChildProcess;
	#limit?: NodeJS.Timeout;
	#gap?: NodeJS.Timeout;
	#onEnd?: () => void;
	/** Bumped on every play/stop so callbacks from an old sound can tell they're stale. */
	#generation = 0;

	get playing(): boolean {
		return this.#onEnd !== undefined;
	}

	play(opts: PlayOptions): void {
		this.stop();
		const generation = ++this.#generation;
		this.#onEnd = opts.onEnd ?? (() => {});
		live.add(this);

		// Perceived loudness is roughly logarithmic, so a squared curve makes the
		// slider feel even: 50% sounds about half as loud, not barely quieter.
		const gain = Math.min(1, Math.max(0, opts.volume / 100)) ** 2;
		if (gain === 0) {
			this.#finish(generation);
			return;
		}

		this.#limit = setTimeout(() => this.stop(), opts.maxMs);

		if (process.platform === "win32") {
			this.#playWindows(opts, gain, generation);
		} else if (process.platform === "darwin") {
			this.#playMac(opts, gain, generation);
		} else {
			// Stream Deck only runs on Windows and macOS. Elsewhere (e.g. the
			// automated tests on Linux) pretend to play silently, so the rest of
			// the plugin behaves exactly as it would with real sound.
			if (!opts.loop) this.#gap = setTimeout(() => this.#finish(generation), 1500);
		}
	}

	stop(): void {
		this.#finish(this.#generation);
	}

	#playMac(opts: PlayOptions, gain: number, generation: number): void {
		const once = () => {
			if (generation !== this.#generation) return;
			const child = spawn("/usr/bin/afplay", ["-v", gain.toFixed(3), opts.file], { stdio: "ignore" });
			this.#child = child;
			child.on("error", () => this.#finish(generation));
			child.on("exit", () => {
				if (generation !== this.#generation || this.#child !== child) return;
				this.#child = undefined;
				// Looping lives here in Node, so if the plugin dies at most one clip finishes playing.
				if (opts.loop) this.#gap = setTimeout(once, LOOP_GAP_MS);
				else this.#finish(generation);
			});
		};
		once();
	}

	#playWindows(opts: PlayOptions, gain: number, generation: number): void {
		// The loop runs inside PowerShell to avoid PowerShell's ~0.5 s start-up
		// cost on every repeat. Two safety nets stop an orphaned loop (e.g. if
		// Stream Deck is closed mid-alarm): a deadline, and a check that the
		// plugin process is still alive.
		//
		// Everything variable travels in environment variables, never pasted into
		// the script text, so a strange file name can't break (or inject into)
		// the command. The script is a plain, readable -Command rather than
		// -EncodedCommand, which security software often treats as a red flag.
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$player = New-Object System.Media.SoundPlayer $env:TD_SOUND",
			"$player.Load()",
			"$deadline = [DateTime]::UtcNow.AddMilliseconds([double]$env:TD_MAX_MS)",
			"do { $player.PlaySync(); if ($env:TD_LOOP -ne '1') { break }; " +
				`Start-Sleep -Milliseconds ${LOOP_GAP_MS}; ` +
				"if (-not (Get-Process -Id ([int]$env:TD_PARENT) -ErrorAction SilentlyContinue)) { break } " +
				"} while ([DateTime]::UtcNow -lt $deadline)",
		].join("; ");

		const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

		const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: "ignore",
			windowsHide: true, // no console window flashing up
			env: {
				...process.env,
				TD_SOUND: wavAtVolume(opts.file, gain),
				TD_LOOP: opts.loop ? "1" : "0",
				TD_MAX_MS: String(opts.maxMs),
				TD_PARENT: String(process.pid),
			},
		});
		this.#child = child;
		child.on("error", () => this.#finish(generation));
		child.on("exit", () => {
			if (this.#child === child) this.#child = undefined;
			this.#finish(generation);
		});
	}

	#finish(generation: number): void {
		if (generation !== this.#generation) return;
		this.#generation++;
		clearTimeout(this.#limit);
		clearTimeout(this.#gap);
		const child = this.#child;
		this.#child = undefined;
		if (child && child.exitCode === null) child.kill();
		live.delete(this);

		const onEnd = this.#onEnd;
		this.#onEnd = undefined;
		onEnd?.();
	}
}

/** Make sure no sound outlives the plugin process. */
export function stopAllSounds(): void {
	for (const player of [...live]) player.stop();
}

process.once("exit", stopAllSounds);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		stopAllSounds();
		process.exit(0);
	});
}
