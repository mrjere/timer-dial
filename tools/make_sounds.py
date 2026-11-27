#!/usr/bin/env python3
"""
Synthesises the Timer Dial alarm sounds from scratch.

Why synthesise instead of downloading?
  Every sound here is generated from maths (sine waves, envelopes, a bit of
  noise), so there is no third-party recording involved and no licence to
  track. The output is dedicated to the public domain (CC0) - use, share,
  sell or modify freely. Downloaded "free" sounds are often CC-BY (needs
  attribution) or CC-BY-NC (no commercial use), which bites if you ever
  publish the plugin on the Elgato Marketplace.

Usage:
  python3 tools/make_sounds.py            # writes WAVs into the plugin folder
  python3 tools/make_sounds.py --list     # show the sound catalogue

Requires: numpy and scipy (pip install numpy scipy)

Format: 44.1 kHz, 16-bit PCM, mono WAV. PCM WAV is the one format that both
Windows (System.Media.SoundPlayer) and macOS (afplay) play natively, which is
why the plugin uses it.
"""

import argparse
import pathlib
import wave

import numpy as np
from scipy.signal import lfilter

SR = 44_100  # sample rate (Hz)
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "com.jere.timerdial.sdPlugin" / "sounds"
RNG = np.random.default_rng(seed=7)  # fixed seed -> identical output every run


# --------------------------------------------------------------------------
# Building blocks
# --------------------------------------------------------------------------

def t_axis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def silence(dur: float) -> np.ndarray:
    return np.zeros(int(dur * SR))


def fade(x: np.ndarray, fade_in: float = 0.004, fade_out: float = 0.008) -> np.ndarray:
    """Short raised-cosine fades stop the 'click' you hear when a waveform starts or stops abruptly."""
    x = x.copy()
    n_in, n_out = int(fade_in * SR), int(fade_out * SR)
    if n_in:
        x[:n_in] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n_in))
    if n_out:
        x[-n_out:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, n_out))
    return x


def bl_square(freq: float, dur: float, max_harmonic_hz: float = 12_000) -> np.ndarray:
    """Band-limited square wave (odd harmonics only, 1/n amplitude).

    A 'naive' square wave contains infinite harmonics, which alias into harsh
    inharmonic noise in digital audio. Summing only the harmonics below a
    ceiling gives the same chunky retro character without the grit.
    """
    t = t_axis(dur)
    out = np.zeros_like(t)
    n = 1
    while freq * n < max_harmonic_hz:
        out += np.sin(2 * np.pi * freq * n * t) / n
        n += 2
    return out * (4 / np.pi) * 0.7


def sine(freq: float, dur: float) -> np.ndarray:
    return np.sin(2 * np.pi * freq * t_axis(dur))


def exp_decay(dur: float, tau: float) -> np.ndarray:
    return np.exp(-t_axis(dur) / tau)


def bell(freq: float, dur: float, partials, strike: float = 0.15) -> np.ndarray:
    """Additive bell: a set of (ratio, amplitude, decay-seconds) partials.

    Real bells have *inharmonic* overtones (not whole-number multiples), which
    is what makes them sound metallic rather than like a flute.
    """
    t = t_axis(dur)
    out = np.zeros_like(t)
    for ratio, amp, tau in partials:
        out += amp * np.sin(2 * np.pi * freq * ratio * t) * np.exp(-t / tau)
    # A few ms of filtered noise imitates the hammer hitting the metal.
    n = int(0.006 * SR)
    click = RNG.standard_normal(n) * np.linspace(1, 0, n) * strike
    click = np.convolve(click, np.ones(4) / 4, mode="same")
    out[:n] += click
    return fade(out, 0.0005, 0.02)


def place(canvas: np.ndarray, sound: np.ndarray, at: float) -> None:
    """Mix `sound` into `canvas` starting at `at` seconds (in place)."""
    i = int(at * SR)
    j = min(len(canvas), i + len(sound))
    canvas[i:j] += sound[: j - i]


def note(name: str) -> float:
    """'A4' -> 440.0 Hz, using 12-tone equal temperament."""
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3,
             "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave - 4)) / 12)


# --------------------------------------------------------------------------
# The sounds
# --------------------------------------------------------------------------

def soft_pulse() -> np.ndarray:
    """Three slow, low swells. Quiet by design - for when someone is asleep nearby."""
    out = silence(2.1)
    for i in range(3):
        d = 0.42
        env = np.sin(np.pi * t_axis(d) / d) ** 2  # smooth swell up and down
        tone = sine(523.25, d) + 0.25 * sine(1046.5, d)
        place(out, tone * env, 0.05 + i * 0.62)
    return out


def gentle_chime() -> np.ndarray:
    """Descending E-major arpeggio with a soft, glassy timbre."""
    out = silence(2.6)
    for i, n in enumerate(["E6", "B5", "G#5", "E5"]):
        f = note(n)
        d = 1.6
        tone = sine(f, d) + 0.18 * sine(2 * f, d) + 0.06 * sine(3 * f, d)
        place(out, fade(tone * exp_decay(d, 0.55), 0.003, 0.05), i * 0.26)
    return out


def sonar() -> np.ndarray:
    """A single ping with a slight downward glide and two fading echoes."""
    d = 1.4
    t = t_axis(d)
    f = 1250 * (1 - 0.02 * t)  # tiny pitch drop
    phase = 2 * np.pi * np.cumsum(f) / SR
    ping = np.sin(phase) * np.exp(-t / 0.35)
    ping = fade(ping, 0.002, 0.05)
    out = silence(2.2)
    place(out, ping, 0.0)
    place(out, ping * 0.32, 0.38)
    place(out, ping * 0.12, 0.76)
    return out


def classic_beeper() -> np.ndarray:
    """The classic kitchen-timer: beep-beep-beep-beep."""
    out = silence(1.0)
    for i in range(4):
        b = fade(bl_square(2000, 0.085, max_harmonic_hz=9000), 0.003, 0.006)
        place(out, b, i * 0.15)
    return out


def digital_watch() -> np.ndarray:
    """Two quick, bright chirps like a wristwatch hourly signal."""
    out = silence(0.9)
    for i in range(2):
        d = 0.055
        b = sine(3200, d) + 0.3 * sine(6400, d)
        place(out, fade(b, 0.002, 0.008), i * 0.11)
    return out


DESK_BELL_PARTIALS = [(1.0, 1.0, 1.4), (2.32, 0.55, 0.8), (4.25, 0.30, 0.45), (6.63, 0.15, 0.25), (9.1, 0.07, 0.12)]


def desk_bell() -> np.ndarray:
    """Hotel-reception desk bell: ding-ding!"""
    out = silence(2.4)
    place(out, bell(1960, 2.2, DESK_BELL_PARTIALS), 0.0)
    place(out, bell(1960, 2.0, DESK_BELL_PARTIALS) * 0.85, 0.24)
    return out


def rise_and_shine() -> np.ndarray:
    """Upbeat ascending marimba-style arpeggio."""
    out = silence(1.5)
    for i, n in enumerate(["C5", "E5", "G5", "C6", "E6"]):
        f = note(n)
        d = 0.7
        # Marimba bars have a strong overtone near 4x the fundamental that dies away fast.
        tone = sine(f, d) * exp_decay(d, 0.22) + 0.35 * sine(3.93 * f, d) * exp_decay(d, 0.05)
        place(out, fade(tone, 0.002, 0.04), i * 0.11)
    return out


def retro_arcade() -> np.ndarray:
    """Chiptune flourish built from band-limited square waves."""
    out = silence(1.0)
    seq = ["C6", "G6", "E6", "C7", "G6", "C7"]
    for i, n in enumerate(seq):
        d = 0.075 if i < len(seq) - 1 else 0.2
        place(out, fade(bl_square(note(n), d, max_harmonic_hz=11000), 0.002, 0.01), i * 0.075)
    return out


def alarm_clock() -> np.ndarray:
    """Old-school twin-bell alarm clock: a hammer rattling between two bells."""
    partials_a = [(1.0, 1.0, 0.25), (2.7, 0.5, 0.12), (5.1, 0.25, 0.06)]
    partials_b = [(1.0, 1.0, 0.25), (2.6, 0.5, 0.12), (5.3, 0.25, 0.06)]
    out = silence(1.25)
    strikes = int(0.95 * 18)  # ~18 hammer strikes per second
    for i in range(strikes):
        f, p = (2350, partials_a) if i % 2 == 0 else (2610, partials_b)
        place(out, bell(f, 0.3, p, strike=0.3) * 0.55, i / 18)
    return out


# id -> (display name, generator, target loudness in LUFS)
CATALOGUE = {
    "soft-pulse": ("Soft Pulse", soft_pulse, -25),
    "gentle-chime": ("Gentle Chime", gentle_chime, -19),
    "sonar": ("Sonar Ping", sonar, -18),
    "classic-beeper": ("Classic Beeper", classic_beeper, -16),
    "digital-watch": ("Digital Watch", digital_watch, -17),
    "desk-bell": ("Desk Bell", desk_bell, -16),
    "rise-and-shine": ("Rise & Shine", rise_and_shine, -16),
    "retro-arcade": ("Retro Arcade", retro_arcade, -16),
    "alarm-clock": ("Alarm Clock", alarm_clock, -14),
}


# --------------------------------------------------------------------------
# Loudness + output
# --------------------------------------------------------------------------

def _k_weighting(fs: int):
    """ITU-R BS.1770 'K-weighting': a high-shelf (+4 dB above ~1.5 kHz) then a
    low-cut, approximating how loud the human ear perceives different pitches."""
    # High-shelf (RBJ cookbook biquad)
    G, Q, fc = 4.0, 1 / np.sqrt(2), 1681.97
    A, w0 = 10 ** (G / 40), 2 * np.pi * fc / fs
    alpha, cw = np.sin(w0) / (2 * Q), np.cos(w0)
    b1 = [A * ((A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha),
          -2 * A * ((A - 1) + (A + 1) * cw),
          A * ((A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha)]
    a1 = [(A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha,
          2 * ((A - 1) - (A + 1) * cw),
          (A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha]
    # High-pass
    Q, fc = 0.5003, 38.135
    w0 = 2 * np.pi * fc / fs
    alpha, cw = np.sin(w0) / (2 * Q), np.cos(w0)
    b2 = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    a2 = [1 + alpha, -2 * cw, 1 - alpha]
    return (b1, a1), (b2, a2)


def loudness_lufs(x: np.ndarray) -> float:
    """Integrated loudness (LUFS) per BS.1770: K-weight, 400 ms blocks, gating."""
    (b1, a1), (b2, a2) = _k_weighting(SR)
    y = lfilter(b2, a2, lfilter(b1, a1, x))
    block, hop = int(0.4 * SR), int(0.1 * SR)
    y = np.concatenate([y, np.zeros(block)])  # let short sounds fill one block
    powers = np.array([np.mean(y[i:i + block] ** 2) for i in range(0, len(y) - block, hop)])
    lufs = -0.691 + 10 * np.log10(powers + 1e-12)
    gated = powers[lufs > -70]                       # absolute gate
    rel = -0.691 + 10 * np.log10(np.mean(gated)) - 10
    gated = powers[(lufs > -70) & (lufs > rel)]      # relative gate
    return -0.691 + 10 * np.log10(np.mean(gated))


def normalise(x: np.ndarray, target_lufs: float, peak_ceiling_db: float = -1.0) -> np.ndarray:
    """Match *perceived* loudness between sounds (LUFS), without ever clipping.

    Plain peak-normalising would make a short beep sound far quieter than a
    ringing bell. LUFS models the ear, so every sound lands at a similar
    loudness; the gain is then capped so no sample exceeds -1 dBFS.
    """
    x = x - np.mean(x)  # remove any DC offset
    gain_db = target_lufs - loudness_lufs(x)
    gain = 10 ** (gain_db / 20)
    peak_limit = 10 ** (peak_ceiling_db / 20) / max(np.max(np.abs(x)), 1e-9)
    return x * min(gain, peak_limit)


def write_wav(path: pathlib.Path, x: np.ndarray) -> None:
    pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="list sounds and exit")
    args = parser.parse_args()

    if args.list:
        for key, (name, *_rest) in CATALOGUE.items():
            print(f"{key:16} {name}")
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key, (name, fn, loudness) in CATALOGUE.items():
        audio = normalise(fn(), loudness)
        path = OUT_DIR / f"{key}.wav"
        write_wav(path, audio)
        peak_db = 20 * np.log10(np.max(np.abs(audio)))
        print(f"{path.name:22} {name:16} {len(audio) / SR:4.2f}s  "
              f"{loudness_lufs(audio):6.1f} LUFS (target {loudness})  peak {peak_db:5.1f} dBFS")


if __name__ == "__main__":
    main()
