// 用真对话的副本验证 /op（删除/编辑/截断）—— 不碰真对话
// sudo pm2 start /var/www/app/proactive/tools/test-op.js --name test-op --cwd /var/www/app/proactive --no-autorestart
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
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers, timeout: 120000 }, (res) => {
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
  const testId = 'optest_' + Date.now().toString(36);
  const src = JSON.parse(fs.readFileSync(path.join(DIR, SRC + '.json'), 'utf8'));
  // 只留尾部一点内容当副本，避免又造一个 34MB 文件（/op 的意义就在这）
  const conv = { ...src, id: testId, messages: src.messages.slice(-30), history: src.history.slice(-30) };
  fs.writeFileSync(path.join(DIR, testId + '.json'), JSON.stringify(conv));
  console.log(`副本 ${testId}：messages=${conv.messages.length}`);

  const lastText = (conv.messages[conv.messages.length - 1].text || '').slice(0, 30);
  const delIdx = conv.messages.length - 1;
  const rDel = await req('POST', `/api/conversations/${testId}/op`, { op: 'delete', index: delIdx });
  console.log(`OP delete idx=${delIdx} → ${rDel.status} ${rDel.body.slice(0, 120)}`);

  const rGet = await req('GET', `/api/conversations/${testId}`);
  const after = JSON.parse(rGet.body);
  const stillThere = after.messages.some(m => (m.text || '').slice(0, 30) === lastText);
  console.log(`回读 messages=${after.messages.length} history=${after.history.length}，被删那条${stillThere ? ' ❌ 还在' : ' ✅ 已删掉'}`);

  const rEdit = await req('POST', `/api/conversations/${testId}/op`, { op: 'edit', index: after.messages.length - 1, text: '【编辑测试】改过的正文' });
  console.log(`OP edit → ${rEdit.status}`);
  const rGet2 = await req('GET', `/api/conversations/${testId}`);
  const a2 = JSON.parse(rGet2.body);
  const lastH = (a2.history[a2.history.length - 1].parts || []).map(p => p.text || '').join('');
  console.log(`编辑后：messages 末条=${(a2.messages[a2.messages.length - 1].text || '').slice(0, 20)} | history 末条=${lastH.slice(0, 20)} ${lastH.startsWith('【编辑测试】') ? '✅ history 同步了' : '❌ history 没同步'}`);

  const rTr = await req('POST', `/api/conversations/${testId}/op`, { op: 'truncate', index: 5 });
  const rGet3 = await req('GET', `/api/conversations/${testId}`);
  const a3 = JSON.parse(rGet3.body);
  console.log(`OP truncate idx=5 → ${rTr.status}，回读 messages=${a3.messages.length} history=${a3.history.length}`);

  const del = await req('DELETE', '/api/conversations/' + testId);
  console.log(`清理 → DELETE ${del.status}`);
})();
