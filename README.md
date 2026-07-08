# suno-prep

Audio resampling tool that shifts pitch by semitones by resampling the source audio.

---

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later)
- FFmpeg

The app does not use a global FFmpeg installation. It looks only in the current working directory: first for `ffmpeg` and `ffprobe` directly in the folder, then in `libs/`. If they are missing, the app automatically downloads an OS-appropriate local copy into `libs/` in the working directory and uses that instead.

To package the app into binaries with Node SEA, run `npm run build:binaries`. This writes:

- `dist/suno-prep-win.exe`
- `dist/suno-prep-mac`

---

## Step 1 — Install FFmpeg

### Windows

1. Go to https://www.gyan.dev/ffmpeg/builds/ and download **ffmpeg-release-essentials.zip**
2. Extract the zip
3. Copy `ffmpeg.exe` from the `bin/` folder inside the zip
4. Paste it into `C:\Windows\System32\`
5. Open a new Command Prompt and verify:
   ```
   ffmpeg -version
   ```

### macOS

```bash
# Download the pre-built binary
curl -L https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip -o ffmpeg.zip

# Unzip
unzip ffmpeg.zip

# Move to bin
sudo mv ffmpeg /usr/local/bin/

# Verify
ffmpeg -version
```

---

## Step 2 — Install Node dependencies

In the project folder, run:

```bash
npm install
```

---

## Step 3 — Add input files

Place your audio files (e.g. `.mp3`, `.wav`) into the `input/` folder.

---

## Step 4 — Run
Use `app.js` to create resampled versions of a song.

- By default it creates `-24` semitones
- By default it creates `-26` semitones
- By default it creates `-28` semitones
- By default it creates `-30` semitones

If you want a single specific pitch shift instead, pass `--semitones <value>`.

### Run

```bash
node app.js input/song.mp3 --output-dir output
```

For a custom shift:

```bash
node app.js input/song.mp3 --output-dir output --semitones 7
```

You can also run it through npm:

```bash
npm run resample-octaves -- input/song.mp3 --output-dir output
```

Or:

```bash
npm run resample-octaves -- input/song.mp3 --output-dir output --semitones -5
```

### Options

- `-o, --output-dir <directory>`: optional output directory; defaults to the repo `output/` directory
- `-s, --semitones <value>`: optional semitone shift; when set, the script generates only that one resampled version

With the default behavior, the script writes:

- `<input>_down-24<ext>`
- `<input>_down-26<ext>`
- `<input>_down-28<ext>`
- `<input>_down-30<ext>`

With `--semitones 7`, it writes:

- `<input>_up-7<ext>`

