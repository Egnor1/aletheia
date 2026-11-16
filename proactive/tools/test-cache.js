// 一次性自检：验证 Gemini cachedContents 全链路（建缓存 → 带缓存请求 → 看 cachedContentTokenCount → 删缓存）
// 跑法：sudo pm2 start /var/www/app/proactive/tools/test-cache.js --name test-cache --cwd /var/www/app --no-autorestart
const fs = require('fs');
const https = require('https');

const MODEL = process.env.CACHE_TEST_MODEL || 'gemini-3.8-flash';

function key() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const o = JSON.parse(fs.readFileSync('/var/www/app/proactive/state/runtime-keys.json', 'utf8'));
    if (o.gemini) return String(o.gemini).trim();
  } catch {}
  return '';
}

function call(method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const rq = https.request({
      hostname: 'generativelanguage.googleapis.com', path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 90000,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    rq.on('error', e => resolve({ status: 0, body: String(e) }));
    rq.on('timeout', () => { rq.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    if (data) rq.write(data);
    rq.end();
  });
}

(async () => {
  const k = key();
  if (!k) { console.log('NO_KEY：runtime-keys.json 里没有缓存的 Gemini key，也没设 GEMINI_API_KEY'); return; }
  console.log('KEY', 'len=' + k.length, 'sha12=' + require('crypto').createHash('sha256').update(k).digest('hex').slice(0, 12));

  // 造一段够长的前缀（≈ 2 万 token）
  const para = '这是一段用来测试上下文缓存的占位文字，包含一些中文和数字 1234567890，重复很多次以拉长 token 数。';
  const longText = para.repeat(700);

  const t0 = Date.now();
  const created = await call('POST', `/v1beta/cachedContents?key=${encodeURIComponent(k)}`, {
    model: `models/${MODEL}`,
    contents: [{ role: 'user', parts: [{ text: longText }] }],
    ttl: '600s',
  });
  console.log('CREATE', created.status, (Date.now() - t0) + 'ms', String(created.body).slice(0, 220));
  if (created.status !== 200) return;
  const cacheName = JSON.parse(created.body).name;
  const cachedTokens = (JSON.parse(created.body).usageMetadata || {}).totalTokenCount;
  console.log('CACHE_NAME', cacheName, 'cachedTokens=' + cachedTokens);

  const t1 = Date.now();
  const gen = await call('POST', `/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(k)}`, {
    cachedContent: cacheName,
    contents: [{ role: 'user', parts: [{ text: '用一句话回答：你刚才读到的占位文字里出现了哪个数字串？' }] }],
    generationConfig: { maxOutputTokens: 200, temperature: 0 },
  });
  const dt = Date.now() - t1;
  console.log('GENERATE', gen.status, dt + 'ms');
  let um = null;
  try {
    const d = JSON.parse(gen.body);
    um = d.usageMetadata;
    console.log('USAGE', JSON.stringify(um));
    const txt = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || []).map(p => p.text || '').join('');
    console.log('ANSWER', String(txt).slice(0, 120));
  } catch (e) {
    console.log('BODY', String(gen.body).slice(0, 300));
  }
  if (um) {
    const hit = um.cachedContentTokenCount || 0;
    console.log(hit > 0 ? `✅ 缓存命中 ${hit} tokens（输入只有 ${um.promptTokenCount} 全量小计里的缓存部分）` : '❌ 没命中（cachedContentTokenCount=0）');
  }

  const del = await call('DELETE', `/v1beta/${cacheName}?key=${encodeURIComponent(k)}`);
  console.log('DELETE', del.status);
})();
