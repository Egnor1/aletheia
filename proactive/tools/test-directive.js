// 端到端验证「管理员指令」链路：改配置为 dryrun → 排一条 1 分钟后的指令 → 打印结果
// sudo pm2 start /var/www/app/proactive/tools/test-directive.js --name test-dir --cwd /var/www/app/proactive --no-autorestart
const http = require('http');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const MODE = process.argv[2] || 'test';     // test = 排指令；restore = 恢复 termux

function call(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Auth-Token': TOKEN };
    if (payload) headers['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { resolve({}); } });
    });
    r.on('error', e => resolve({ error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  if (MODE === 'restore') {
    const c = await call('POST', '/api/proactive/config', { delivery: { channel: 'termux', keep_pending_max: 50 } });
    console.log('已恢复投递管道:', JSON.stringify(c.config && c.config.delivery));
    return;
  }
  const c1 = await call('POST', '/api/proactive/config', { delivery: { channel: 'dryrun', keep_pending_max: 50 } });
  console.log('临时切 dryrun:', JSON.stringify(c1.config && c1.config.delivery));
  const r = await call('POST', '/api/proactive/directive', {
    delay_minutes: 1, condition: '测试：schedule_nudge 链路是否打通', tone: '验收口吻', category: 'homework_progress', source: 'test',
  });
  console.log('排期结果:', JSON.stringify(r.directive));
  const list = await call('GET', '/api/proactive/directive');
  console.log('当前指令表:', JSON.stringify(list.directives));
})();
