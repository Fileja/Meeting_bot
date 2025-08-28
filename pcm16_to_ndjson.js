#!/usr/bin/env node
const SR = parseInt(process.env.RATE || "16000", 10);
const CHUNK_MS = parseInt(process.env.CHUNK_MS || "20", 10);
const BYTES_PER_SAMPLE = 2;
const CHUNK_BYTES = Math.max(1, Math.round(SR * BYTES_PER_SAMPLE * (CHUNK_MS / 1000)));

let buf = Buffer.alloc(0);

function emit(b) {
  if (!b?.length) return;
  process.stdout.write(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: b.toString("base64")
    }) + "\n"
  );
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= CHUNK_BYTES) {
    emit(buf.subarray(0, CHUNK_BYTES));
    buf = buf.subarray(CHUNK_BYTES);
  }
});

process.stdin.on("end", () => {
  if (buf.length) emit(buf);
});