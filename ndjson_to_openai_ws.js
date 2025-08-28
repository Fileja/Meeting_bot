#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const WebSocket = require('ws');

const WS_URL = process.env.OPENAI_WS_URL || 'wss://api.openai.com/v1/realtime?intent=transcription';
const MODEL  = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const LANG   = process.env.LANG_CODE || 'en';
const API_KEY_FILE = process.env.API_KEY_FILE || 'data.json';
const DEBUG  = process.env.DEBUG === '1';

const FORCE_MANUAL = process.env.FORCE_MANUAL_COMMITS === '1';
const CHUNK_MS = Math.max(1, Number(process.env.CHUNK_MS || 20));
const MIN_COMMIT_MS = Math.max(CHUNK_MS, Number(process.env.MIN_COMMIT_MS || 800));
const TAIL_COMMIT_MS = Math.max(0, Number(process.env.TAIL_COMMIT_MS || 120));
const CHUNKS_PER_COMMIT = Math.max(1, Math.ceil(MIN_COMMIT_MS / CHUNK_MS));
const MIN_TAIL_CHUNKS = Math.max(1, Math.ceil(TAIL_COMMIT_MS / CHUNK_MS));
const FORWARD_ALL = process.env.FORWARD_ALL === '1';

const { API_KEY } = JSON.parse(fs.readFileSync(API_KEY_FILE, 'utf8'));
if (!API_KEY) { console.error(`Missing API_KEY in ${API_KEY_FILE}`); process.exit(2); }

if (typeof fetch === 'undefined') {
  global.fetch = (...a) => import('node-fetch').then(({default:f})=>f(...a));
}

async function getEphemeralToken() {
  const r = await fetch('https://api.openai.com/v1/realtime/transcription_sessions', {
    method:'POST',
    headers:{ Authorization:`Bearer ${API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({})
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.client_secret.value;
}

(async () => {
  let ws, configured = false;
  let manualCommit = FORCE_MANUAL;
  let chunksSinceCommit = 0;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const token = await getEphemeralToken();
  ws = new WebSocket(WS_URL, {
    headers: { Authorization: `Bearer ${token}`, 'OpenAI-Beta': 'realtime=v1' }
  });

  ws.on('open', () => {
    DEBUG && console.error('[producer] connected');
    ws.send(JSON.stringify({
      type:'transcription_session.update',
      session:{
        input_audio_format:'pcm16',
        input_audio_transcription:{ model: MODEL, language: LANG },
        turn_detection: FORCE_MANUAL ? null : {
          type:'server_vad', 
          threshold:0.5, 
          prefix_padding_ms:300, 
          silence_duration_ms:200
        }
      }
    }));
  });

  ws.on('message', (buf) => {
    const raw = buf.toString('utf8');
    let evt; try { evt = JSON.parse(raw); } catch { return; }

    if (evt.type === 'transcription_session.updated') {
      configured = true;
      return;
    }

    if (FORWARD_ALL) {
      process.stdout.write(raw + '\n');
      return;
    }

    if (evt.type === 'conversation.item.input_audio_transcription.delta' ||
        evt.type === 'conversation.item.input_audio_transcription.completed') {
      process.stdout.write(raw + '\n');  // RAW passthrough
    }
  });

  rl.on('line', (line) => {
    if (!configured) return; // start after session updated
    let obj;
    try { obj = JSON.parse(line.trim()); } catch { return; }
    if (obj?.type === 'input_audio_buffer.append' && typeof obj.audio === 'string') {
      ws.send(line.trim());
      if (manualCommit && ++chunksSinceCommit >= CHUNKS_PER_COMMIT) {
        ws.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
        chunksSinceCommit = 0;
      }
    }
  });

  rl.on('close', () => {
    if (manualCommit && chunksSinceCommit >= MIN_TAIL_CHUNKS) {
      try { ws.send(JSON.stringify({ type:'input_audio_buffer.commit' })); } catch {}
    }
    try { ws.close(); } catch {}
  });

  ws.on('error', (e) => console.error('[producer] WS error:', e.message));
  ws.on('close', () => DEBUG && console.error('[producer] closed'));
})();
