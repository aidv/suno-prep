# suno-prep

Audio processing tool that generates pitch-shifted and time-stretched variants of audio files using FFmpeg. Drop files into `input/` and get all combinations in `output/`.

---

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later)
- FFmpeg

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

### Windows

Double-click `run-process-audio.bat`, or run it from Command Prompt with an optional concurrency number:

```bat
run-process-audio.bat 4
```

### macOS / Linux

```bash
node process-audio.js
```

With custom concurrency (faster):

```bash
FFMPEG_CONCURRENCY=8 node process-audio.js
```

---

## Output

Processed files are saved to `output/`, organized by input file name, then speed, then pitch.

