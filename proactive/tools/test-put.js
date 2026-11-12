// 用「真对话的副本」验证整段 PUT（16MB 级别）能不能落盘 —— 不碰真对话
// sudo pm2 start /var/www/app/proactive/tools/test-put.js --name test-put --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const SRC = process.argv[2] || 'conv_rec_1776439659724_7eba19';
const DIR = '/var/www/app/conversations';

function req(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Auth-Token': TOKEN };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers, timeout: 180000 }, (res) => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const src = JSON.parse(fs.readFileSync(path.join(DIR, SRC + '.json'), 'utf8'));
  const testId = 'puttest_' + Date.now().toString(36);
  const conv = { ...src, id: testId };
  const removed = conv.messages[conv.messages.length - 3];
  conv.messages = conv.messages.slice(0, -1);                    // 模拟"删掉最后一条"
  const bodyMB = (JSON.stringify(conv).length / 1048576).toFixed(1);
  console.log(`测试对话 ${testId}：messages ${src.messages.length} → ${conv.messages.length}，PUT body ≈ ${bodyMB} MB`);

  const mk = await req('POST', '/api/conversations', conv);
  console.log(`POST 建副本 → ${mk.status}`);
  const put = await req('PUT', '/api/conversations/' + testId, conv);
  console.log(`PUT 整段覆盖 → ${put.status} ${put.status === 200 ? 'OK' : put.body.slice(0, 200)}`);

  const back = await req('GET', '/api/conversations/' + testId);
  let got = null;
  try { got = JSON.parse(back.body); } catch {}
  if (got) console.log(`回读 → GET ${back.status}，messages=${got.messages.length}（期望 ${conv.messages.length}）${got.messages.length === conv.messages.length ? ' ✅ 落盘成功' : ' ❌ 没落盘'}`);
  else console.log(`回读失败：GET ${back.status}`);

  const del = await req('DELETE', '/api/conversations/' + testId);
  console.log(`清理 → DELETE ${del.status}`);
})();
