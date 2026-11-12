// 验证 [最近工具调用] 注入块（非 schedule_nudge 类工具）真的会长出来
// sudo pm2 start /var/www/app/proactive/tools/test-toolblock.js --name ttb --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');

const TOKEN = process.env.APP_TOKEN || loadEnv().APP_TOKEN || '';
const toolFile = path.join(__dirname, '..', 'state', 'tool-calls.json');

function call(method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers: { 'X-Auth-Token': TOKEN } }, (r) => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.end();
  });
}

(async () => {
  let backup = null;
  try { backup = fs.readFileSync(toolFile, 'utf8'); } catch {}
  // 写两条合成的工具调用记录（模拟 save_memory / lock_app）
  const fake = [
    { at: Date.now() - 42 * 60000, time: '10:05', tool: 'save_memory', status: 'ok', summary: '写入记忆（memo）：生生这周三次课都迟到了' },
    { at: Date.now() - 12 * 60000, time: '10:35', tool: 'lock_app', status: 'ok', summary: '锁定 1 个应用' },
  ];
  let arr = [];
  try { arr = JSON.parse(backup || '[]'); } catch {}
  fs.writeFileSync(toolFile, JSON.stringify([...arr, ...fake]), 'utf8');

  const b = await call('GET', '/api/proactive/blocks');
  console.log('--- [最近工具调用] 注入块 ---');
  console.log(b.tool_calls || '(空)');

  // 还原
  if (backup === null) { try { fs.unlinkSync(toolFile); } catch {} }
  else fs.writeFileSync(toolFile, backup, 'utf8');
  console.log('tool-calls.json 已恢复');
})();
