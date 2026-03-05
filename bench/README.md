# Benchmark: WASM Decoders vs ffmpeg

Audio decode performance comparison for a 10-second audio file.

**Test environment:** Windows, Node.js v24, ffmpeg 8.0.1

## Results

| Format | WASM (median) | ffmpeg (median) | Speedup |
|--------|--------------|-----------------|---------|
| **WAV** | 0.5 ms | 91.1 ms | **171×** |
| **OGA** (Telegram voice) | 19.3 ms | 99.2 ms | **5×** |
| **MP3** | 7.3 ms | 88.3 ms | **12×** |
| **FLAC** | 8.5 ms | 91.6 ms | **11×** |

## Why WASM is faster

ffmpeg pays **~85–90 ms of process spawn overhead** per call:
1. `execFileSync` → fork/spawn process
2. Load ffmpeg binary (~100 MB)
3. Decode audio
4. Write WAV to temp file
5. Read WAV back into Node.js
6. Delete temp file

WASM decoders run **in-process** with zero I/O — just memory-to-memory decoding.

## How to run

```bash
# Generate test files (requires ffmpeg for generation only)
ffmpeg -y -f lavfi -i sine=frequency=440:sample_rate=16000:duration=10 -ac 1 bench/test.wav
ffmpeg -y -i bench/test.wav -c:a libopus -b:a 24k bench/test.oga
ffmpeg -y -i bench/test.wav -c:a libmp3lame -b:a 64k bench/test.mp3
ffmpeg -y -i bench/test.wav -c:a flac bench/test.flac

# Run benchmark
npx tsx bench/decode-bench.ts
```
