#!/usr/bin/env node
const readline = require('readline');
const WebSocket = require('ws');

// Read configuration from environment variables set by create_session.sh
const OUT_WS_URL   = process.env.OUT_WS_URL || 'ws://127.0.0.1:9090/ingest';
const DEBUG        = process.env.DEBUG === '1';
const OUT_RETRY_MS = Math.max(250, Number(process.env.OUT_RETRY_MS || 1000));

// Debug values
const OUTPUT_MODE   = (process.env.OUTPUT_MODE || 'both').toLowerCase();
const SMART_SPACING = process.env.SMART_SPACING === '1';
const MIRROR_STDOUT = process.env.MIRROR_STDOUT === '1';

let outWs = null, outReady = false;
const outQueue = [];

function flushOutQueue() {
  if (!outReady) return;
  while (outQueue.length) {
    const msg = outQueue.shift();
    try { outWs.send(msg); } catch (e) {
      console.error('[forward] send error (flush):', e.message);
      outQueue.unshift(msg);
      break;
    }
  }
}

function outSend(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (outReady && outWs && outWs.readyState === WebSocket.OPEN) {
    try { outWs.send(str); } catch (e) { console.error('[forward] send error:', e.message); outQueue.push(str); }
  } else {
    outQueue.push(str);
  }
}

function connectOutWS() {
  try { outWs && outWs.terminate(); } catch {}
  outReady = false;
  outWs = new WebSocket(OUT_WS_URL);
  outWs.on('open', () => { outReady = true; DEBUG && console.error('[forward] connected ->', OUT_WS_URL); flushOutQueue(); });
  outWs.on('close', (c,r) => { outReady = false; console.error(`[forward] closed: ${c} ${r||''} — retry in ${OUT_RETRY_MS}ms`); setTimeout(connectOutWS, OUT_RETRY_MS); });
  outWs.on('error', (e) => console.error('[forward] error:', e.message));
}
connectOutWS();

// spacing helpers
let lastOutChar = '\n';
const isSpace       = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isAlphaNum    = (ch) => !!ch && /[A-Za-z0-9Ā-ž]/.test(ch);
const isSentenceEnd = (ch) => ch === '.' || ch === '!' || ch === '?';
function needsSpace(prev, nextFirst) {
  if (!prev || !nextFirst) return false;
  if (isSpace(prev)) return false;
  if (isSentenceEnd(prev) && isAlphaNum(nextFirst)) return true;
  if (isAlphaNum(prev) && isAlphaNum(nextFirst)) return true;
  if ((prev === ')' || prev === '"' || prev === '\'') && isAlphaNum(nextFirst)) return true;
  return false;
}
function stitch(delta) {
  if (!SMART_SPACING) return delta;
  let out = '';
  if (needsSpace(lastOutChar, delta[0])) out += ' ';
  out += delta;
  lastOutChar = out[out.length - 1] || lastOutChar;
  return out;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let evt; try { evt = JSON.parse(s); } catch { return; }

  // Only process transcription events
  if (evt.type === 'conversation.item.input_audio_transcription.delta') {
    if (OUTPUT_MODE === 'completed') return;
    const itemId = evt.item?.id || evt.item_id || null;
    const text = typeof evt.delta === 'string' ? stitch(evt.delta) : '';
    const out = { type:'delta', text, item_id: itemId, t: Date.now() };
    outSend(out);
    DEBUG && console.error('[Δ]', text.replace(/\n/g,'\\n'));
    if (MIRROR_STDOUT) process.stdout.write(text);
    return;
  }

  if (evt.type === 'conversation.item.input_audio_transcription.completed') {
    if (OUTPUT_MODE === 'delta') return;
    const itemId = evt.item?.id || evt.item_id || null;
    const text = typeof evt.text === 'string' ? evt.text : '';
    const out = { type:'completed', text, item_id: itemId, t: Date.now() };
    outSend(out);
    DEBUG && console.error('[✓]', text.replace(/\n/g,'\\n'));
    lastOutChar = '\n';
    if (MIRROR_STDOUT) process.stdout.write('\n');
    return;
  }
  // ignore other OpenAI events
});

rl.on('close', () => {
  DEBUG && console.error('[forward] stdin closed');
  try { outWs && outWs.close(); } catch {}
});