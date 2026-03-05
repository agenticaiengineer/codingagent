import { readFileSync, statSync } from "fs";
import { resolve, extname } from "path";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import {
  requireFilePath,
  optionalString,
  ToolInputError,
  hasErrnoCode,
} from "./validate.js";

// ── Constants ──

/**
 * Supported audio formats, grouped by decoder.
 *
 * WAV:  decoded inline (parse RIFF header → Float32Array)
 * OGA/OGG: decoded via ogg-opus-decoder (pure WASM, Telegram voice messages)
 * MP3:  decoded via mpg123-decoder  (pure WASM)
 * FLAC: decoded via @wasm-audio-decoders/flac (pure WASM)
 *
 * No ffmpeg, no native deps, no Python — works on every platform.
 */
const SUPPORTED_EXTENSIONS = new Set([
  ".wav",
  ".oga",   // Telegram voice messages (Ogg Opus)
  ".ogg",   // Ogg Opus / Ogg Vorbis
  ".mp3",
  ".flac",
]);

const VALID_MODELS = new Set(["tiny", "base", "small", "medium"]);

/** Reject files larger than 100 MB to prevent OOM during decoding. */
const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;

/** Whisper expects 16 kHz mono audio. */
const WHISPER_SAMPLE_RATE = 16_000;

/**
 * Map from user-facing model size names to HuggingFace ONNX model IDs.
 */
const MODEL_IDS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
  medium: "onnx-community/whisper-medium",
};

// ── Singleton pipeline cache ──

let cachedPipeline: {
  modelSize: string;
  pipeline: any;
} | null = null;

/**
 * Get (or lazily create) the Whisper transcription pipeline.
 *
 * Dynamic import so ONNX runtime is only loaded on first use.
 * Models auto-download to ~/.cache/huggingface/ and are reused.
 */
async function getTranscriptionPipeline(modelSize: string): Promise<any> {
  if (cachedPipeline?.modelSize === modelSize) {
    return cachedPipeline.pipeline;
  }

  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = true;

  const transcriber = await pipeline(
    "automatic-speech-recognition",
    MODEL_IDS[modelSize],
    { dtype: "q8" }
  );

  cachedPipeline = { modelSize, pipeline: transcriber };
  return transcriber;
}

// ── Audio decoders (all pure WASM — zero native deps) ──

/**
 * Parse a WAV file buffer into a mono Float32Array at its native sample rate.
 * Handles 16-bit PCM, 32-bit float, and stereo→mono downmix.
 */
function decodeWav(buf: Buffer): { audio: Float32Array; sampleRate: number } {
  // Validate RIFF/WAVE header
  if (buf.length < 44) throw new Error("WAV file too short to contain a valid header");
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Not a valid WAV file (missing RIFF/WAVE header)");
  }

  const audioFormat = buf.readUInt16LE(20);   // 1=PCM, 3=IEEE float
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  // Find the "data" chunk (may not start at offset 44 if there are extra chunks)
  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
    const chunkSize = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === "data") {
      dataOffset += 8;
      dataSize = chunkSize;
      break;
    }
    dataOffset += 8 + chunkSize;
  }
  if (dataSize === 0) throw new Error("WAV file has no data chunk");

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const samplesPerChannel = Math.floor(totalSamples / numChannels);

  // Decode samples to Float32
  let samples: Float32Array;
  if (audioFormat === 3 && bitsPerSample === 32) {
    // IEEE 754 float
    samples = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = buf.readFloatLE(dataOffset + i * 4);
    }
  } else if (audioFormat === 1 && bitsPerSample === 16) {
    // 16-bit signed PCM
    samples = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
    }
  } else if (audioFormat === 1 && bitsPerSample === 8) {
    // 8-bit unsigned PCM
    samples = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = (buf[dataOffset + i] - 128) / 128;
    }
  } else {
    throw new Error(
      `Unsupported WAV encoding: format=${audioFormat}, bits=${bitsPerSample}. ` +
      `Supported: PCM 8/16-bit, IEEE float 32-bit.`
    );
  }

  // Downmix to mono if stereo
  if (numChannels === 1) {
    return { audio: samples, sampleRate };
  }

  const mono = new Float32Array(samplesPerChannel);
  const SCALING_FACTOR = Math.sqrt(2);
  if (numChannels === 2) {
    for (let i = 0; i < samplesPerChannel; i++) {
      mono[i] = SCALING_FACTOR * (samples[i * 2] + samples[i * 2 + 1]) / 2;
    }
  } else {
    // Multi-channel: average all channels
    for (let i = 0; i < samplesPerChannel; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += samples[i * numChannels + ch];
      }
      mono[i] = sum / numChannels;
    }
  }

  return { audio: mono, sampleRate };
}

/**
 * Decode Ogg Opus audio (.oga, .ogg) to mono Float32Array.
 * Uses ogg-opus-decoder — pure WASM, no native deps.
 */
async function decodeOggOpus(data: Uint8Array): Promise<{ audio: Float32Array; sampleRate: number }> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const decoder = new OggOpusDecoder();
  await decoder.ready;

  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    // channelData is Float32Array[] (one per channel). Downmix to mono.
    const mono = downmixToMono(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally {
    decoder.free();
  }
}

/**
 * Decode MP3 audio to mono Float32Array.
 * Uses mpg123-decoder — pure WASM, no native deps.
 */
async function decodeMp3(data: Uint8Array): Promise<{ audio: Float32Array; sampleRate: number }> {
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;

  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    const mono = downmixToMono(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally {
    decoder.free();
  }
}

/**
 * Decode FLAC audio to mono Float32Array.
 * Uses @wasm-audio-decoders/flac — pure WASM, no native deps.
 */
async function decodeFlac(data: Uint8Array): Promise<{ audio: Float32Array; sampleRate: number }> {
  const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
  const decoder = new FLACDecoder();
  await decoder.ready;

  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(data);
    const mono = downmixToMono(channelData, samplesDecoded);
    return { audio: mono, sampleRate };
  } finally {
    decoder.free();
  }
}

/**
 * Downmix multi-channel Float32Array[] to a single mono Float32Array.
 */
function downmixToMono(channelData: Float32Array[], samplesDecoded: number): Float32Array {
  if (channelData.length === 1) return channelData[0];

  const mono = new Float32Array(samplesDecoded);
  const numChannels = channelData.length;
  const SCALING_FACTOR = numChannels === 2 ? Math.sqrt(2) : 1;
  const divisor = numChannels;

  for (let i = 0; i < samplesDecoded; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += channelData[ch][i];
    }
    mono[i] = (SCALING_FACTOR * sum) / divisor;
  }
  return mono;
}

/**
 * Resample audio from sourceSampleRate to targetSampleRate using
 * linear interpolation. Good enough for speech transcription.
 */
function resample(
  audio: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate === targetSampleRate) return audio;

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(audio.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const srcIdxFloor = Math.floor(srcIdx);
    const frac = srcIdx - srcIdxFloor;
    const a = audio[srcIdxFloor] ?? 0;
    const b = audio[Math.min(srcIdxFloor + 1, audio.length - 1)] ?? 0;
    output[i] = a + frac * (b - a);
  }

  return output;
}

/**
 * Load an audio file and return a mono Float32Array at 16 kHz
 * (the format Whisper expects). All decoding is pure WASM.
 */
async function loadAudio(filePath: string): Promise<Float32Array> {
  const ext = extname(filePath).toLowerCase();
  const raw = readFileSync(filePath);
  const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  let audio: Float32Array;
  let sampleRate: number;

  switch (ext) {
    case ".wav": {
      const wav = decodeWav(raw);
      audio = wav.audio;
      sampleRate = wav.sampleRate;
      break;
    }
    case ".oga":
    case ".ogg": {
      const ogg = await decodeOggOpus(data);
      audio = ogg.audio;
      sampleRate = ogg.sampleRate;
      break;
    }
    case ".mp3": {
      const mp3 = await decodeMp3(data);
      audio = mp3.audio;
      sampleRate = mp3.sampleRate;
      break;
    }
    case ".flac": {
      const flac = await decodeFlac(data);
      audio = flac.audio;
      sampleRate = flac.sampleRate;
      break;
    }
    default:
      throw new Error(`No built-in decoder for "${ext}".`);
  }

  // Resample to 16 kHz (Whisper's expected sample rate)
  return resample(audio, sampleRate, WHISPER_SAMPLE_RATE);
}

// ── Format helpers ──

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ── Tool definition ──

export const transcribeTool: Tool = {
  name: "Transcribe",
  description:
    "Transcribe an audio file to text using a local Whisper model. " +
    "Runs entirely locally with no API calls and no external dependencies (no ffmpeg, no Python). " +
    "Auto-downloads the model on first use (~150 MB for base). " +
    "Supports .wav, .oga (Telegram voice), .ogg, .mp3, .flac.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description:
          "Path to the audio file to transcribe (absolute or relative to cwd). " +
          "Supports .wav, .oga (Telegram voice messages), .ogg, .mp3, .flac.",
      },
      model: {
        type: "string",
        description:
          'Whisper model size: "tiny" (~75 MB, fastest), "base" (~150 MB, default), ' +
          '"small" (~500 MB, more accurate), "medium" (~1.5 GB, most accurate). ' +
          "Larger models are more accurate but slower. Downloaded once and cached.",
      },
      language: {
        type: "string",
        description:
          'Optional ISO 639-1 language code (e.g., "en", "es", "fr", "zh", "ja"). ' +
          "Auto-detected if not specified.",
      },
    },
    required: ["file_path"],
  },
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    // ── 1. Input validation ──

    let rawPath: string;
    let modelSize: string;
    let language: string | undefined;

    try {
      rawPath = requireFilePath(input, "file_path");
      const rawModel = optionalString(input, "model");
      modelSize = rawModel ?? "base";
      language = optionalString(input, "language");
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    if (!VALID_MODELS.has(modelSize)) {
      return {
        content:
          `Invalid model "${modelSize}". Valid models: ${[...VALID_MODELS].join(", ")}. ` +
          `Default is "base" (good accuracy/speed balance).`,
        is_error: true,
      };
    }

    const filePath = resolve(context.cwd, rawPath);

    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        content:
          `Unsupported audio format "${ext}". ` +
          `Supported formats: ${[...SUPPORTED_EXTENSIONS].join(", ")}.`,
        is_error: true,
      };
    }

    // ── 2. Pre-abort check ──

    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    // ── 3. File validation ──

    let fileSize: number;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return {
          content: `Error: "${filePath}" is not a file (it may be a directory).`,
          is_error: true,
        };
      }
      fileSize = stat.size;
    } catch (err: unknown) {
      if (hasErrnoCode(err) && err.code === "ENOENT") {
        return { content: `Error: File not found: ${filePath}`, is_error: true };
      }
      if (hasErrnoCode(err) && err.code === "EACCES") {
        return {
          content: `Error: Permission denied reading: ${filePath}`,
          is_error: true,
        };
      }
      return {
        content: `Error accessing file: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }

    if (fileSize === 0) {
      return { content: "Error: Audio file is empty (0 bytes).", is_error: true };
    }

    if (fileSize > MAX_AUDIO_SIZE_BYTES) {
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
      return {
        content:
          `Error: Audio file is too large (${sizeMB} MB, max ${MAX_AUDIO_SIZE_BYTES / (1024 * 1024)} MB).`,
        is_error: true,
      };
    }

    // ── 4. Load & decode audio (pure WASM, no external deps) ──

    let audioData: Float32Array;
    try {
      audioData = await loadAudio(filePath);
    } catch (err: unknown) {
      return {
        content: `Error decoding audio: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }

    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    // ── 5. Load/get transcription pipeline ──

    let transcriber: any;
    try {
      transcriber = await getTranscriptionPipeline(modelSize);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ENOTFOUND") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("fetch failed") ||
        msg.includes("network")
      ) {
        return {
          content:
            `Error: Failed to download Whisper model "${modelSize}". ` +
            `Check your internet connection.\n` +
            `The model is downloaded once to ~/.cache/huggingface/ and reused on subsequent calls.\n` +
            `If you're behind a proxy, set HTTPS_PROXY or HF_ENDPOINT environment variables.`,
          is_error: true,
        };
      }
      return {
        content: `Error loading Whisper model "${modelSize}": ${msg}`,
        is_error: true,
      };
    }

    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    // ── 6. Run transcription ──

    let result: any;
    try {
      const pipelineOptions: Record<string, unknown> = {
        return_timestamps: true,
      };
      if (language) {
        pipelineOptions.language = language;
      }

      // Pass the raw Float32Array — the pipeline handles feature extraction
      result = await transcriber(audioData, pipelineOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no speech") || msg.includes("empty")) {
        return {
          content: "No speech detected in the audio file.",
          is_error: false,
        };
      }
      return {
        content: `Error during transcription: ${msg}`,
        is_error: true,
      };
    }

    // ── 7. Format output ──

    const text: string = result.text?.trim() ?? "";
    const chunks: Array<{ text: string; timestamp: [number, number | null] }> =
      result.chunks ?? [];

    const detectedLang: string | undefined = result.language;
    const langDisplay = language
      ? language
      : detectedLang
        ? `${detectedLang} (detected)`
        : "auto-detected";

    const lines: string[] = [];
    lines.push("=== Transcription ===");
    lines.push(`File: ${filePath}`);
    lines.push(`Model: ${modelSize}`);
    lines.push(`Language: ${langDisplay}`);

    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      const endTime = lastChunk.timestamp?.[1];
      if (typeof endTime === "number") {
        lines.push(`Duration: ${formatDuration(endTime)}`);
      }
    }

    lines.push("");

    if (!text) {
      lines.push("(No speech detected)");
    } else {
      lines.push(text);
    }

    if (chunks.length > 1) {
      lines.push("");
      lines.push("=== Timestamps ===");
      for (const chunk of chunks) {
        const [start, end] = chunk.timestamp;
        const startStr = formatDuration(start);
        const endStr = end !== null ? formatDuration(end) : "?";
        lines.push(`[${startStr} – ${endStr}] ${chunk.text.trim()}`);
      }
    }

    return { content: lines.join("\n") };
  },
};
