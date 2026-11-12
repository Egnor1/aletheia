// 媒体附件链路自检：/api/media/upload（Gemini Files API 代理）→ /api/chat/stream 用 file_data 引用
// sudo pm2 start /var/www/app/proactive/tools/test-media-upload.js --name test-media-up --cwd /var/www/app/proactive --no-autorestart
// sudo pm2 logs test-media-up --nostream --lines 60 ; sudo pm2 delete test-media-up
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const APP_TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
let GEMINI_KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';
if (!GEMINI_KEY) {
  try { GEMINI_KEY = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'runtime-keys.json'), 'utf8')) || {}).gemini || ''; } catch {}
}
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.TEST_MODEL || 'gemini-3.8-flash';

function makeWav(seconds = 2, rate = 16000, freq = 440) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t < 1 ? Math.sin(2 * Math.PI * freq * t) * 0.35 : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

function postRaw(pathname, buf, mimeType, extraHeaders = {}, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': buf.length,
        'X-Auth-Token': APP_TOKEN,
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: 'error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(buf);
    req.end();
  });
}

(async () => {
  console.log('APP_TOKEN:', APP_TOKEN ? `已配置(${APP_TOKEN.length})` : '缺失');
  console.log('GEMINI_KEY:', GEMINI_KEY ? `已配置(${GEMINI_KEY.length})` : '缺失');
  if (!APP_TOKEN || !GEMINI_KEY) process.exit(1);

  const wav = makeWav(2);
  console.log(`\n=== 1. 上传 2 秒 WAV (${(wav.length / 1024).toFixed(0)}KB) 到 /api/media/upload ===`);
  const t0 = Date.now();
  const up = await postRaw(`/api/media/upload?mimeType=audio/wav&name=test-2s.wav`, wav, 'audio/wav', { 'X-Gemini-Key': GEMINI_KEY });
  console.log(`status=${up.status} 耗时=${Date.now() - t0}ms`);
  let filed = null;
  try { filed = JSON.parse(up.body); } catch {}
  console.log('resp:', JSON.stringify(filed).slice(0, 400));
  if (!filed || !filed.uri) { console.log('上传失败，停'); process.exit(1); }

  console.log('\n=== 2. 用 file_data 引用它发一条 chat（model=' + MODEL + '）===');
  const payload = {
    apiKey: GEMINI_KEY,
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { file_data: { mime_type: filed.mimeType || 'audio/wav', file_uri: filed.uri } },
        { text: '这段音频里有什么？有没有停顿？一句话回答。' },
      ],
    }],
    generationConfig: { maxOutputTokens: 300, thinkingConfig: { thinkingLevel: 'LOW' } },
    systemInstruction: { parts: [{ text: '' }] },
    contextLine: '当前日期时间：2026-10-29 22:30:00',
  };
  const t1 = Date.now();
  const chat = await postRaw('/api/chat/stream', Buffer.from(JSON.stringify(payload), 'utf8'), 'application/json', {}, 240000);
  console.log(`status=${chat.status} 耗时=${Date.now() - t1}ms`);
  const events = chat.body.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  const types = {};
  for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
  console.log('事件统计:', JSON.stringify(types));
  for (const e of events) if (e.type === 'error') console.log('ERROR →', e.message);
  const answer = events.filter(e => e.type === 'answer').map(e => e.text).join('');
  console.log('answer 长度:', answer.length);
  console.log('answer:', answer.slice(0, 300).replace(/\n/g, ' '));
  const done = events.find(e => e.type === 'done');
  if (done?.usageMetadata) console.log('usage:', JSON.stringify(done.usageMetadata).slice(0, 300));
  console.log('\n=== done ===');
  process.exit(0);
})();
