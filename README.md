# SoundApp

A fast, keyboard-driven audio player for musicians and anyone who works with large collections of audio files.

![SoundApp Screenshot](https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/screenshot.png)

---

## The Story

Back in the System 7 days, there was a Mac app called [SoundApp](http://www-cs-students.stanford.edu/~franke/SoundApp/) by Norman Franke. It was a simple, lightweight audio player that musicians loved — you could throw any audio file at it, navigate with the keyboard, and it just worked. No library to manage, no playlists to curate. Just you and your files.

I used it constantly. I also ran a website about psychoacoustic compression (MP3 was exotic back then), and SoundApp got full marks in my player reviews.

Years later, I found myself missing that workflow. Modern players had become bloated media centers. I wanted something fast and simple again — something I could use while making music. So I built my own. First in Adobe AIR, then in Electron. Almost a decade of daily use has shaped every detail.

This is that app. I finally decided to share it.

---

![Controls](https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/screenshot_controls.png)
**For the non-SoundApp purists and mouse-handling cowboys, there is an optional control bar. Press `C` to toggle.**


## What Makes It Different

**Speed, everywhere.** Double-click an audio file and it plays instantly. Drop a folder with thousands of files and the playlist builds in moments. Skip through tracks as fast as you can press the arrow keys — playback starts immediately, every time.

**No library, no database.** SoundApp works directly with your filesystem. Open a file, and it automatically adds everything in that folder to the playlist. Open a folder, and it scans recursively. This isn't a media library — it's a tool for exploring what you have.

**The shuffle workflow.** Drop a massive folder of samples, stems, or reference tracks. Hit `R` to shuffle. Skip through with the arrow keys until something catches your ear. This is how I find inspiration — fast, random, unplanned.

**Gapless looping.** Press `L` and the current track loops seamlessly — no gap, no click. I use this constantly: find a loop, let it run, jam over it.

**Multi-track preview.** Press `M` to open the mixer with all the files from the current folder. Perfect for checking stems or bounces from your DAW. Solo individual tracks, mute others, hear them in context — without launching a full session. This feature is new, and it's already changed how I work.

**Format icons you can read.** SoundApp registers as a handler for audio formats and gives each one a distinct color: green for FLAC, red for MP3, gray for PCM, orange for AAC, purple for OGG, yellow for tracker modules. You can see what's what at a glance in your file manager.

---

## Who It's For

I built this for myself — a musician who needs to quickly audition files while working. But it's useful for anyone who works with audio: producers, sound designers, podcast editors, sample collectors, or just music lovers with large collections who are tired of waiting for their player to load.

---

## The Mixer

![Multitrack Mixer Screenshot](https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/multitrack_screenshot.png)

The multi-track mixer lets you play up to 20 audio files simultaneously, perfectly synced. Drop a folder of stems onto the "Multitrack Preview" zone, or press `M` to open the mixer with files from the current folder.

- Solo any track with `F1`–`F10` or `1`–`0`
- Hold `Shift` for exclusive solo (mutes all others)
- Seek with arrow keys, adjust master volume with up/down

I used to open my DAW just to check a bounce. Now I don't.

---

## Keyboard Shortcuts

SoundApp is built for keyboard use. You can do almost everything without touching the mouse.

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `L` | Toggle gapless loop |
| `R` | Shuffle playlist |
| `←` / `→` | Previous / Next track |
| `Ctrl+←` / `Ctrl+→` | Skip 10 seconds |
| `↑` / `↓` | Volume up / down |
| `M` | Open mixer with current folder |
| `I` | Show file in folder |
| `H` | Help |
| `S` | Settings |
| `C` | Toggle controls bar |
| `X` | Toggle dark/light theme |
| `Esc` | Exit |

---

## Supported Formats

**Pretty much everything.** MP3, FLAC, WAV, AIFF, OGG, M4A, AAC, WMA, APE, WavPack, and anything else FFmpeg can decode.

**Tracker modules too.** MOD, XM, IT, S3M, and 70+ tracker formats via libopenmpt — with proper playback, not just "technically works."

---

## Installation

Download the latest release from the [Releases page](https://github.com/herrbasan/SoundApp/releases). Run the installer and you're ready to go. SoundApp will offer to register as the default handler for audio formats.

---

## A Note on Themes

SoundApp is designed for dark mode. There's a light mode (`X` to toggle), but it's not as polished. I work in the dark.

---

## Optional Controls Bar

SoundApp is built for keyboard-first use, so the interface is deliberately minimal. Press `C` to toggle the controls bar at the bottom of the window. It shows play/pause, loop, shuffle, prev/next, quick access to settings and help, plus a volume slider.

The controls bar is shown by default, but can be hidden with `C`. You can also adjust volume with the mouse wheel.

---

## Technical Details

For architecture, format details, and contributor information, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Roadmap

A few things I'd like to add eventually:

- **Playback speed control** — time stretching and pitch shifting
- **Playlist window** — for when you actually want to see what's queued
- **Waveform display** — if performance allows
- **Markers** — save positions within a file for A/B comparison
- **Quick tag editor** — fix metadata without leaving the app

---

## Acknowledgments

To Norman Franke, who made the original SoundApp. I never forgot how good simple software can be.

To the [FFmpeg](https://ffmpeg.org/) project — the engine that makes universal format support possible. SoundApp wouldn't exist without it.

---

## License

MIT
