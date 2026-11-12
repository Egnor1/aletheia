// 验证增量拉取端点：sudo pm2 start .../tools/test-since.js --name test-since --cwd /var/www/app/proactive --no-autorestart
const http = require('http');
const cfg = require('../config.json');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const id = process.argv[2] || cfg.target_conv_id;

function get(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, headers: { 'X-Auth-Token': TOKEN } }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

(async () => {
  const full = await get(`/api/conversations/${encodeURIComponent(id)}`);
  let total = 0;
  try { total = JSON.parse(full.body).messages.length; } catch {}
  console.log(`全量 GET: status=${full.status} body=${(full.body.length / 1048576).toFixed(2)}MB messages=${total}`);
  for (const after of [Math.max(0, total - 3), total]) {
    const r = await get(`/api/conversations/${encodeURIComponent(id)}/since?after=${after}`);
    let d = {}; try { d = JSON.parse(r.body); } catch {}
    console.log(`since?after=${after}: status=${r.status} total=${d.total} 返回 ${d.messages ? d.messages.length : '?'} 条 ${d.messages && d.messages.length ? '(role=' + d.messages.map(m => m.role).join(',') + ')' : ''} 体积=${r.body.length}B`);
  }
})();
