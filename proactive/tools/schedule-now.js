// 直接排一条主动消息（给用户/我手动触发用）：node schedule-now.js <delay_minutes> "<condition>" [category] [tone]
// sudo pm2 start /var/www/app/proactive/tools/schedule-now.js --name sched --cwd /var/www/app/proactive --no-autorestart -- 5 "条件" soft_care "验收口吻"
const http = require('http');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const [delay, condition, category, tone] = process.argv.slice(2);
if (!condition) { console.log('用法: schedule-now.js <delay_minutes> "<condition>" [category] [tone]'); process.exit(1); }
const body = JSON.stringify({ delay_minutes: Number(delay) || 5, condition, category: category || undefined, tone: tone || undefined, source: 'manual' });
const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/proactive/directive', method: 'POST',
  headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  const c = []; res.on('data', d => c.push(d));
  res.on('end', () => { try { const j = JSON.parse(Buffer.concat(c).toString()); console.log('已排期:', JSON.stringify(j.directive)); } catch { console.log(Buffer.concat(c).toString().slice(0, 200)); } });
});
r.on('error', e => console.log('失败:', e.message));
r.write(body); r.end();
