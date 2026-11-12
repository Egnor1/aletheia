// 守护进程 → server.js 的内网 HTTP 客户端（带 APP_TOKEN）
const http = require('http');
const { loadEnv } = require('./env');

const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const BASE = process.env.PROACTIVE_API_BASE || 'http://127.0.0.1:3000';

function call(method, p, body, timeoutMs = 150000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${p}`, {
      method,
      headers: Object.assign(
        { 'X-Auth-Token': TOKEN },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 204) return resolve({ ok: true, empty: true });
        try { resolve(JSON.parse(txt)); }
        catch { resolve({ ok: false, error: `HTTP ${res.statusCode}: ${txt.slice(0, 200)}` }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); resolve({ ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  base: BASE,
  snapshot: () => call('GET', '/api/proactive/snapshot', null, 15000),
  decide: (body) => call('POST', '/api/proactive/decide', body, 60000),
  generate: (body) => call('POST', '/api/proactive/generate', body, 180000),
  deliver: (body) => call('POST', '/api/proactive/deliver', body, 30000),
  log: (body) => call('POST', '/api/proactive/log', body, 10000),
  config: () => call('GET', '/api/proactive/config', null, 10000),
};
