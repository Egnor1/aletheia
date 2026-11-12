// 验证 Gemini 能不能直接吃音频（inlineData）——顺便确认 key 有音频能力
// sudo pm2 start /var/www/app/proactive/tools/test-media-input.js --name test-media --cwd /var/www/app/proactive --no-autorestart
// sudo pm2 logs test-media --nostream --lines 40 ; sudo pm2 delete test-media
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
let KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';
if (!KEY) {
  try { KEY = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'runtime-keys.json'), 'utf8')) || {}).gemini || ''; } catch {}
}
const MODEL = process.env.TEST_MODEL || 'gemini-3.8-flash';

// 生成 2 秒 16kHz 单声道 WAV：440Hz 正弦 + 说一声「滴」
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
    // 前 1 秒 440Hz，后 1 秒静音 → 模型应该能说出「先有声后停顿」
    const v = t < 1 ? Math.sin(2 * Math.PI * freq * t) * 0.35 : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

function post(pathname, payload, timeoutMs = 120000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
      r.on('error', e => resolve({ status: 0, body: 'stream error ' + e.message }));
    });
    req.on('error', e => resolve({ status: 0, body: 'req error ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

(async () => {
  if (!KEY) { console.log('无 Gemini key，跳过'); process.exit(1); }
  const wav = makeWav();
  console.log(`WAV: ${wav.length} bytes, model=${MODEL}`);

  // 顺带问问它支持哪些输入模态
  const r = await post(`/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(KEY)}`, {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
        { text: '这段音频里是什么声音？有没有停顿？用一句话说。' },
      ],
    }],
    generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
  });
  console.log('status:', r.status);
  let data = null;
  try { data = JSON.parse(r.body); } catch {}
  if (data?.error) console.log('error:', JSON.stringify(data.error).slice(0, 400));
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('\n');
  console.log('回答:', text || '(空)');
  console.log('usage:', JSON.stringify(data?.usageMetadata || {}));
  console.log('finishReason:', data?.candidates?.[0]?.finishReason);
  process.exit(0);
})();
