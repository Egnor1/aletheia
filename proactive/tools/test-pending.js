// 端到端验证「待推队列」：塞一条假件 → 取件 → 回执 → 确认清空（不碰对话）
// sudo pm2 start /var/www/app/proactive/tools/test-pending.js --name test-pending --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const PENDING = path.join(__dirname, '..', 'state', 'pending.json');

function call(method, p, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers: Object.assign({ 'X-Auth-Token': TOKEN }, payload ? { 'Content-Type': 'application/json' } : {}) }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const item = { id: 'pro_test_' + Date.now().toString(36), convId: 'test', text: '（队列自测：这条不会进对话）', category: 'soft_care', trigger: 'test', at: Date.now(), consumed: false };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(PENDING, 'utf8')) || []; } catch {}
  const before = arr.length;
  arr.push(item);
  fs.writeFileSync(PENDING, JSON.stringify(arr), 'utf8');
  console.log(`塞入假件：${before} → ${arr.length} 条`);

  const p1 = await call('GET', '/api/proactive/pending');
  console.log(`GET /pending → status=${p1.status} body=${p1.body.slice(0, 120)}`);

  const c1 = await call('POST', '/api/proactive/consume', { ids: [item.id] });
  console.log(`POST /consume → status=${c1.status} body=${c1.body}`);

  const p2 = await call('GET', '/api/proactive/pending');
  console.log(`再 GET /pending → status=${p2.status} ${p2.status === 204 ? '(空 ✓)' : p2.body.slice(0, 80)}`);

  try {
    const left = JSON.parse(fs.readFileSync(PENDING, 'utf8')).filter(x => !x.consumed);
    console.log('文件里剩余未消费:', left.length);
  } catch (e) { console.log('读 pending.json 失败:', e.message); }
})();
