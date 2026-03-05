/**
 * Benchmark: WASM decoders vs ffmpeg for audio decoding.
 *
 * Measures decode-only time (not Whisper inference) for each format.
 * Each approach converts the file to 16 kHz mono Float32Array.
 *
 * Usage: npx tsx bench/decode-bench.ts
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync } from "fs";

const BENCH_DIR = join(import.meta.dirname!, "..");
const ITERATIONS = 5;

// ────────────────────────────────────────────────────────────────
// WASM decoders (same code as src/tools/transcribe.ts)
// ────────────────────────────────────────────────────────────────

function decodeWav(buf: Buffer): { audio: Float32Array; sampleRate: number } {
  if (buf.length < 44) throw new Error("WAV too short");
  const audioFormat = buf.readUInt16LE(20);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
    const chunkSize = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === "data") { dataOffset += 8; dataSize = chunkSize; break; }
    dataOffset += 8 + chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const samplesPerChannel = Math.floor(totalSamples / numChannels);

  const samples = new Float32Array(totalSamples);
  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
    }
  }

  if (numChannels === 1) return { audio: samples, sampleRate };
  const mono = new Float32Array(samplesPerChannel);
  for (let i = 0; i < samplesPerChannel; i++) {
    mono[i] = (samples[i * 2] + samples[i * 2 + 1]) / 2;
  }
  return { audio: mono, sampleRate };
}

async function decodeOga(data: Uint8Array) {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    const mono = channelData.length === 1 ? channelData[0] : mixdown(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally { decoder.free(); }
}

async function decodeMp3(data: Uint8Array) {
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    const mono = channelData.length === 1 ? channelData[0] : mixdown(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally { decoder.free(); }
}

async function decodeFlac(data: Uint8Array) {
  const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
  const decoder = new FLACDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    const mono = channelData.length === 1 ? channelData[0] : mixdown(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally { decoder.free(); }
}

function mixdown(channelData: Float32Array[], samples: number): Float32Array {
  const mono = new Float32Array(samples);
  const ch = channelData.length;
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += channelData[c][i];
    mono[i] = sum / ch;
  }
  return mono;
}

// ────────────────────────────────────────────────────────────────
// ffmpeg decoder (spawns process, converts to WAV, reads back)
// ────────────────────────────────────────────────────────────────

function decodeViaFfmpeg(filePath: string): Float32Array {
  const tmpWav = join(tmpdir(), `bench-ffmpeg-${Date.now()}.wav`);
  try {
    execFileSync("ffmpeg", [
      "-i", filePath,
      "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", "-f", "wav", "-y", tmpWav,
    ], { timeout: 30_000, stdio: "pipe" });
    const buf = readFileSync(tmpWav);
    return decodeWav(buf).audio;
  } finally {
    try { unlinkSync(tmpWav); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────
// Benchmark runner
// ────────────────────────────────────────────────────────────────

interface BenchResult {
  format: string;
  method: string;
  samples: number;
  timings: number[];
  avgMs: number;
  medianMs: number;
  minMs: number;
}

async function bench(
  label: string,
  fn: () => Promise<{ audio: Float32Array }> | { audio: Float32Array },
  iterations: number
): Promise<{ samples: number; timings: number[] }> {
  // Warmup
  const warmup = await fn();
  const samples = warmup.audio.length;

  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  return { samples, timings };
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const formats = [
    { ext: "wav", file: join(BENCH_DIR, "bench", "test.wav") },
    { ext: "oga", file: join(BENCH_DIR, "bench", "test.oga") },
    { ext: "mp3", file: join(BENCH_DIR, "bench", "test.mp3") },
    { ext: "flac", file: join(BENCH_DIR, "bench", "test.flac") },
  ];

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Audio Decode Benchmark: WASM decoders vs ffmpeg         ║");
  console.log("║     10s audio, " + ITERATIONS + " iterations each (+ 1 warmup)                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results: BenchResult[] = [];

  for (const { ext, file } of formats) {
    const raw = readFileSync(file);
    const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const fileSize = (raw.length / 1024).toFixed(1);

    console.log(`── ${ext.toUpperCase()} (${fileSize} KB) ──`);

    // WASM decode
    let wasmFn: () => Promise<{ audio: Float32Array }> | { audio: Float32Array };
    switch (ext) {
      case "wav": wasmFn = () => Promise.resolve(decodeWav(raw)); break;
      case "oga": wasmFn = () => decodeOga(data); break;
      case "mp3": wasmFn = () => decodeMp3(data); break;
      case "flac": wasmFn = () => decodeFlac(data); break;
      default: throw new Error(`Unknown format: ${ext}`);
    }

    const wasm = await bench(`WASM ${ext}`, wasmFn, ITERATIONS);
    const wasmAvg = wasm.timings.reduce((a, b) => a + b, 0) / wasm.timings.length;
    const wasmMed = median(wasm.timings);
    const wasmMin = Math.min(...wasm.timings);

    results.push({
      format: ext,
      method: "WASM",
      samples: wasm.samples,
      timings: wasm.timings,
      avgMs: wasmAvg,
      medianMs: wasmMed,
      minMs: wasmMin,
    });

    console.log(`  WASM:   avg ${wasmAvg.toFixed(1)}ms  median ${wasmMed.toFixed(1)}ms  min ${wasmMin.toFixed(1)}ms  (${wasm.samples} samples)`);

    // ffmpeg decode
    const ffmpeg = await bench(`ffmpeg ${ext}`, () => Promise.resolve({ audio: decodeViaFfmpeg(file) }), ITERATIONS);
    const ffmpegAvg = ffmpeg.timings.reduce((a, b) => a + b, 0) / ffmpeg.timings.length;
    const ffmpegMed = median(ffmpeg.timings);
    const ffmpegMin = Math.min(...ffmpeg.timings);

    results.push({
      format: ext,
      method: "ffmpeg",
      samples: ffmpeg.samples,
      timings: ffmpeg.timings,
      avgMs: ffmpegAvg,
      medianMs: ffmpegMed,
      minMs: ffmpegMin,
    });

    console.log(`  ffmpeg: avg ${ffmpegAvg.toFixed(1)}ms  median ${ffmpegMed.toFixed(1)}ms  min ${ffmpegMin.toFixed(1)}ms  (${ffmpeg.samples} samples)`);

    // Comparison
    const ratio = ffmpegMed / wasmMed;
    const winner = ratio > 1 ? "WASM" : "ffmpeg";
    const speedup = ratio > 1 ? ratio : 1 / ratio;
    console.log(`  → ${winner} is ${speedup.toFixed(1)}× faster (median)\n`);
  }

  // Summary table
  console.log("╔════════╦═════════╦══════════╦══════════╦══════════╗");
  console.log("║ Format ║ Method  ║  Avg ms  ║ Med ms   ║  Min ms  ║");
  console.log("╠════════╬═════════╬══════════╬══════════╬══════════╣");
  for (const r of results) {
    console.log(
      `║ ${r.format.padEnd(6)} ║ ${r.method.padEnd(7)} ║ ${r.avgMs.toFixed(1).padStart(8)} ║ ${r.medianMs.toFixed(1).padStart(8)} ║ ${r.minMs.toFixed(1).padStart(8)} ║`
    );
  }
  console.log("╚════════╩═════════╩══════════╩══════════╩══════════╝");
}

main().catch(console.error);
