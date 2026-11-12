const http = require('http');
const fs = require('fs');
const { loadEnv } = require('/var/www/app/proactive/lib/env');
const TOKEN = loadEnv().APP_TOKEN || '';
function call(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method: 'GET', headers: { 'X-Auth-Token': TOKEN } }, (r) => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch { resolve({}); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}
(async () => {
  const h = await call('/api/health');
  console.log('presence →', JSON.stringify(h.presence));
  console.log('activity →', JSON.stringify(h.activity));
  if (h.screen_time) {
    const age = Math.round((Date.now() - (h.screen_time._received_ts || 0)) / 60000);
    console.log(`最近一次屏幕时长上报: ${age} 分钟前，${(h.screen_time.data || []).length} 个 App`);
  } else {
    console.log('屏幕时长缓存: 空');
  }
  const f = '/var/www/app/health/screentime-' + new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '.jsonl';
  try {
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    console.log(`今天的 screentime 文件: ${lines.length} 条` + (lines.length ? `，最后一条时间 ${new Date(JSON.parse(lines[lines.length-1]).timestamp).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}` : ''));
  } catch (e) { console.log('读 screentime 文件失败:', e.message); }
  const b = await call('/api/proactive/blocks');
  console.log('\n--- [生生此刻的手机状态] 现在的样子 ---');
  console.log(b.presence || '(空)');
})();
