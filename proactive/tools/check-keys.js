// 检查两个 key 的可用性：DeepSeek 余额 + 缓存到的 Gemini key 是否在
// sudo pm2 start /var/www/app/proactive/tools/check-keys.js --name check-keys --cwd /var/www/app/proactive --no-autorestart
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const dsKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';

function get(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 20000 }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8').slice(0, 400) }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('DEEPSEEK_API_KEY:', dsKey ? `已配置(${dsKey.slice(0, 6)}…)` : '缺失');
  if (dsKey) {
    const r = await get('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${dsKey}` });
    console.log('DeepSeek /user/balance →', r.status, r.body.replace(/\s+/g, ' ').slice(0, 300));
  }
  const p = path.join(__dirname, '..', 'state', 'runtime-keys.json');
  let cached = '';
  try { cached = (JSON.parse(fs.readFileSync(p, 'utf8')) || {}).gemini || ''; } catch {}
  console.log('缓存的 Gemini key:', cached ? `有(${cached.slice(0, 8)}…, 长度 ${cached.length})` : '无（需要你在 App 里发一条消息，server 会顺手缓存）');
})();
