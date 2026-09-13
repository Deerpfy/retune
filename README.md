# Retune

Retune changes the tempo and pitch of audio files in the browser, arranges the results on lanes, and exports WAV.

## What it does

- Reads any audio file the browser decodes, then draws the waveform and estimates the BPM.
- Sets tempo by target BPM or by percent, and pitch by semitones and cents, independently or linked.
- Layers clips on lanes, trims them, fades them, and loops a selection range.
- Exports the whole project, the selection range, or one WAV per lane, as 16 bit PCM or 32 bit float.
- Saves a project file that holds every setting and references each source by file name.

Audio never leaves the page: Retune loads no library and makes no network request.

## How to run it

Open `index.html` with a double click, or publish this repository to GitHub Pages and open the project URL.

A local server also works and matches the GitHub Pages path:

```
python3 -m http.server 8000
```

The command prints `Serving HTTP on 0.0.0.0 port 8000`. Open `http://localhost:8000/` in a browser.

The first screen asks for audio files. Drop a track on the window and the source card shows its waveform, its length, and a detected BPM within a few seconds. The clip lands on the first lane, and `Space` plays it.

## Which files load

Retune hands every file to the browser decoder and reports each result separately. WAV, MP3, AAC in M4A, FLAC, OGG Vorbis, Opus and WebM normally decode. A file that fails names itself in a message, and the rest of the batch continues.

## What the transform costs

Tempo and pitch ratios far from the source smear transients, so drums soften first, and a ratio past half speed, double speed or seven semitones is audible on most material.

## Keyboard

Focus the timeline first, except for `Space`, which works anywhere outside a field.

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `Left` or `Right` | Move the selected clip by one snap step |
| `Up` or `Down` | Move the selected clip to the previous lane or the next lane |
| `Delete` or `Backspace` | Remove the selected clip |

## Which browsers run it

Retune needs the Web Audio API, `OfflineAudioContext` and pointer events. Current Chrome, Edge, Firefox and Safari all qualify.
