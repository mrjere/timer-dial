# Timer Dial for Stream Deck +

A free countdown timer for the Elgato Stream Deck + that lives on a single dial. Turn it to set the
time and press to start. The countdown shows on the touch strip, and an alarm sounds when time is
up.

Everything happens on the dial and its strip of touch screen: no extra keys, no account, and
nothing to set up before you use it.

## Features

- **One dial does everything**: set, start, pause, reset and stop the alarm without any extra keys
- **Smart steps**: 5 seconds at a time under a minute, 30 seconds up to 10 minutes, then whole
  minutes, so every click of the dial moves the time by a useful amount
- **Push and turn** to jump in 5-minute steps
- **Change a running timer**: turn to add or take off time without stopping it
- **Nine built-in alarm sounds**, from a quiet pulse to an old-school alarm clock, or your own WAV
  file
- **Matched loudness**: every built-in sound plays at about the same volume, so switching sounds
  never blasts you
- **Respects your touch strip background**: the timer draws on top of it, and only the alarm
  flash covers it
- **Keeps counting in the background**: switch pages or close a folder and the alarm still goes
  off
- **Survives restarts**: a running timer carries on after the Stream Deck app restarts
- **As many timers as you have dials**, each with its own sound and settings
- **Two control styles**: Streamlined (the default) or Classic, where you turn to choose an amount
  and press to add it

## Requirements

- A Stream Deck +. Timer Dial is a dial control, so it doesn't work on keys.
- Stream Deck app 7.1 or newer, on Windows 10+ or macOS 12+

## Installation

1. Download `com.jere.timerdial.streamDeckPlugin` from the
   [latest release](../../releases/latest).
2. Double-click the file. The Stream Deck app installs it and adds a **Timer Dial** category to
   the actions list.
3. Drag **Timer Dial** onto a dial. It starts at 5:00, ready to go.

The [changelog](CHANGELOG.md) lists what's new in each version.

## Controls

### Streamlined (default)

| Gesture | What it does |
|---|---|
| **Turn** | Set the time. While running, add or take off time. |
| **Push and turn** | Jump in 5-minute steps |
| **Press** | Start / pause |
| **Hold (half a second)** | Reset to the time you started with. Hold again for your **Start time**. |
| **Tap the strip** | Start / pause |
| **Hold the strip** | Reset |

The reset happens while you're still holding the dial, so you know it worked before you let go.
Turning a running timer all the way down to zero cancels it rather than setting off the alarm.

### Classic

| Gesture | What it does |
|---|---|
| **Turn** | Choose how much a press adds (shown at the bottom of the strip) |
| **Press** | Add that amount. Works while the timer is running too. |
| **Hold (half a second)** | Reset |
| **Tap the strip** | Start / pause |
| **Hold the strip** | Reset |

The amount stays set after you press, so pressing three times with **+5:00** adds 15 minutes.

### When the alarm goes off

Any press, tap or turn stops it, and the timer goes back to the time you started with, so a
single press runs it again. If you stop it by turning, the rest of that turn is ignored so the
time doesn't change by accident.

### The touch strip

| Part | Shows |
|---|---|
| Top left | The timer's name. Use the **Title** box in the Stream Deck app to rename it, for example to "Tea". |
| Top right | **READY**, **RUNNING**, **PAUSED** or **TIME'S UP** |
| Middle | The time left |
| Bottom | A hint for what the dial does next, then a progress bar |

The bar is green while running and turns orange for the last 10% (or the last 10 seconds). It's
amber while paused. When time is up, the strip flashes red while the alarm plays, then stays dark
red and counts how long ago the timer finished (for example **+1:23**) until you stop it.

### Settings

| Setting | What it does |
|---|---|
| **Controls** | Streamlined or Classic |
| **Start time** | What the dial shows after a reset. Accepts `5` (minutes), `4:30`, `90s`, `1h30m` or `1:15:00`. Leave it blank for 0:00. |
| **Alarm sound** | One of the built-in sounds, or **Custom WAV file** |
| **Volume** | 0 to 100 (default 80) |
| **Ring for** | Play once, 10 seconds, 30 seconds (default), 1 minute, 2 minutes, or until stopped (up to 10 minutes) |
| **Preview** | Play and stop the chosen sound |

### Alarm sounds

| Gentle | Classic | Lively | Urgent |
|---|---|---|---|
| Soft Pulse (quiet) | Classic Beeper | Rise & Shine | Alarm Clock |
| Gentle Chime | Digital Watch | Retro Arcade | |
| Sonar Ping | Desk Bell | | |

A custom sound is embedded in the action, so it goes with the profile when you export it.

## Troubleshooting

**The alarm makes no sound.**
Press **Play** in the settings to check. If you hear nothing, check that **Volume** isn't at 0
and that your computer's sound is on and going to the right speakers. The plugin plays sound
through Windows' built-in sound player (via PowerShell) or macOS's `afplay`, both on the
default output device. If a custom sound file has been moved or deleted, Classic Beeper plays
instead.

**The volume slider doesn't change my custom sound (Windows).**
Windows' built-in player has no volume control, so the plugin makes a quieter copy of the file.
That only works for 16-bit PCM WAV files, which is the most common kind. Other WAV files play at
full volume. To convert one, open it in a free audio editor such as Audacity and export it as
"WAV (Microsoft), signed 16-bit PCM".

**A timer I deleted still rang.**
Stream Deck tells plugins the same thing when you delete a control as when you switch pages, so
the plugin can't tell the two apart. A timer deleted while it's running rings once, for no longer
than its **Ring for** setting. Reset a timer before deleting it.

**A timer didn't ring after the Stream Deck app restarted.**
A running timer picks up again once its page is on screen. If it finished more than 2 minutes
before that, it resets quietly instead of ringing.

**Something else.**
The plugin writes logs to the `logs` folder inside the plugin's folder:

- Windows: `%appdata%\Elgato\StreamDeck\Plugins\com.jere.timerdial.sdPlugin\logs`
- macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.jere.timerdial.sdPlugin/logs`

Please attach the latest log file if you open an issue.

## Building from source

You need Node.js 24 or newer and the Stream Deck app 7.1 or newer. The Elgato CLI comes with the
project's dependencies, so there's nothing else to install. To regenerate the alarm sounds you
also need Python 3 with `numpy` and `scipy` (on Windows, if `python3` isn't found, run
`py tools/make_sounds.py` instead). Clone or download this repository, then from its folder:

```
npm install                                       # project dependencies, including the Elgato CLI
npm test                                          # unit tests for the timer logic (no deck needed)
npm run e2e                                       # build, then drive the plugin with a fake Stream Deck
npm run typecheck                                 # check the TypeScript types
npm run validate                                  # Elgato's manifest and layout checks
npm run build                                     # build the plugin into the .sdPlugin folder
npx streamdeck link com.jere.timerdial.sdPlugin   # install your build in the Stream Deck app
npm run watch                                     # rebuild and restart the plugin on every save
npx streamdeck dev                                # settings-page debugger on http://localhost:23654
npm run sounds                                    # regenerate the alarm sounds (Python, numpy, scipy)
npm run pack                                      # make dist/com.jere.timerdial.streamDeckPlugin
```

Uninstall the released version before running `streamdeck link`, because both use the same ID.

### Adding an alarm sound

1. Write a function in `tools/make_sounds.py` that returns the sound as a numpy array, and add it
   to `CATALOGUE` with a name and a target loudness.
2. Run `npm run sounds`.
3. Add its ID to `BUILT_IN_SOUNDS` in `src/audio/sounds.ts`, and an `<option>` for it in
   `com.jere.timerdial.sdPlugin/ui/timer-dial.html`.

### Project structure

```
src/
  timer/timer.ts        The timer rules. No Stream Deck code and no clock, so it can be tested on its own.
  render.ts             Turns a timer's state into what the touch strip shows.
  actions/timer-dial.ts The dial control: gestures, the long press, the shared clock and the alarm.
  audio/
    player.ts           Plays sound with the operating system's own tools.
    sounds.ts           The list of built-in sounds and which file to play.
    wav.ts              Makes quieter copies of WAV files for Windows.
  store.ts              Remembers running timers across a restart.
  plugin.ts             Registers the control.
com.jere.timerdial.sdPlugin/
  manifest.json         The control, its icons and what each gesture does.
  layouts/              The touch strip layout (200 x 100 px).
  imgs/                 Icons for the action list and the plugin.
  sounds/               The alarm sounds.
  ui/                   The settings page, using Elgato's sdpi-components.
test/                   Tests for the timer rules and WAV scaling, plus an end-to-end test against
                        a fake Stream Deck.
tools/make_sounds.py    Generates the alarm sounds.
```

### How it works

- **Rules with no Stream Deck code.** Every timer rule is a plain function that takes the current
  state and the time, and returns a new state. Tests can skip ahead an hour just by passing a
  bigger number, with no hardware and no waiting.
- **An end time, not a counter.** Subtracting a second every second drifts, and stops while the
  computer sleeps. The plugin stores when the timer will finish, which is right whenever you look.
- **One clock for every timer.** A single ticker serves all the dials, and only runs while a
  timer is counting or ringing. The strip is only sent the parts that changed, about once a
  second, well under Elgato's limit of 10 updates a second.
- **A home-made long press.** Dials have no built-in long-press event, so the plugin times the
  press itself. Letting go after a hold, or after a push-and-turn, doesn't count as a press.
- **Sound without add-ons.** Node.js has no audio support, and Stream Deck plugins can't load
  native add-ons, so the plugin uses the tools that come with the operating system: `afplay` on
  macOS and PowerShell's `System.Media.SoundPlayer` on Windows. The file name is passed in an
  environment variable rather than pasted into the command, so an unusual name can't break it.
- **Fail safe.** Every alarm has a hard time limit, and on Windows the sound loop checks that the
  plugin is still running, so an alarm can't keep ringing if the Stream Deck app closes.
- **Running timers kept apart from settings.** The settings page saves the whole settings object
  at once, so running timers are stored separately, in the plugin's global settings, where the
  page can't overwrite them.
- **Sounds made from maths.** The alarm sounds are synthesised from sine waves and envelopes by
  `tools/make_sounds.py`, then matched for loudness using the same measure (LUFS) that streaming
  services use.

## Contributing

Bug reports, ideas and pull requests are welcome. By contributing, you agree that your changes are
released under the same licence as the rest of the project.

## Licence

Timer Dial is free, and meant to stay that way. It is released under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). In plain words:

- **You can** use it, copy it, change it and share it for free, for any noncommercial purpose:
  at home, for a hobby, or in a school, charity or other noncommercial organisation.
- **You can't** sell it, charge for changed versions of it, or use it to make money.
- If you share it or a changed version, include the licence and the copyright notice.

This is a summary, and the licence text is what counts. Because it doesn't allow commercial use,
the project is "source-available" rather than "open source" by the Open Source Initiative's
definition.

The alarm sounds are the exception. They are released into the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so you can use them for anything,
commercial or not, without credit.

## Credits

The settings page uses Elgato's [sdpi-components](https://sdpi-components.dev), used under the
MIT licence (see `com.jere.timerdial.sdPlugin/ui/sdpi-components.LICENSE.md`).

This is an independent project. It is not affiliated with or endorsed by Elgato. Stream Deck is a
trademark of its owner.
