// 睡眠聚合自检：确认「一天多段」被合并、平均按天算
// sudo pm2 start /var/www/app/proactive/tools/test-sleep.js --name test-sleep --cwd /var/www/app/proactive --no-autorestart
// sudo pm2 logs test-sleep --nostream --lines 80 ; sudo pm2 delete test-sleep
const http = require('http');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const APP_TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

function get(path) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { 'X-Auth-Token': APP_TOKEN },
      timeout: 15000,
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: 'error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

const fmt = min => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;

(async () => {
  console.log('APP_TOKEN:', APP_TOKEN ? `已配置(长度 ${APP_TOKEN.length})` : '缺失');

  // 1) /api/health 的 sleep（按天聚合）+ sleep_stats
  const h = await get('/api/health');
  console.log('\n=== /api/health ===', 'status=' + h.status);
  if (h.status === 200) {
    const data = JSON.parse(h.body);
    const days = data.sleep || [];
    console.log('sleep_days:', days.length, '| sleep_stats:', JSON.stringify(data.sleep_stats));
    for (const d of days) {
      const sum = d.segments.reduce((a, s) => a + s.minutes, 0);
      const flag = sum === d.totalMinutes ? 'OK' : 'MISMATCH';
      console.log(`  ${d.date}  ${d.count} 段  合计 ${d.totalMinutes}min (${fmt(d.totalMinutes)})  sum(segments)=${sum} ${flag}`
        + (d.count > 1 ? `  ${d.segments.map(s => `${new Date(s.bed + 8 * 3600e3).toISOString().slice(11, 16)}-${new Date(s.wake + 8 * 3600e3).toISOString().slice(11, 16)}(${s.minutes})`).join(' | ')}` : ''));
    }
    if (data.sleep_stats) {
      console.log(`→ 近 ${data.sleep_stats.days} 天平均 ${data.sleep_stats.avgMinutes}min (${fmt(data.sleep_stats.avgMinutes)})`);
    }
  } else {
    console.log(h.body.slice(0, 300));
  }

  // 2) 模型注入块
  const b = await get('/api/proactive/blocks');
  console.log('\n=== /api/proactive/blocks ===', 'status=' + b.status);
  if (b.status === 200) {
    const data = JSON.parse(b.body);
    console.log('--- sleep_block ---');
    console.log((data.sleep_block || '(空)').trim());
  } else {
    console.log(b.body.slice(0, 300));
  }

  // 3) 周视图图表数据（/api/health-history）
  const hi = await get('/api/health-history?range=week');
  console.log('\n=== /api/health-history?range=week ===', 'status=' + hi.status);
  if (hi.status === 200) {
    const data = JSON.parse(hi.body);
    const s = data.sleep || {};
    for (const k of Object.keys(s).sort()) {
      const v = s[k];
      console.log(`  ${k}  totalMinutes=${v.totalMinutes} (${fmt(v.totalMinutes)})  count=${v.count ?? (v.segments || []).length}`);
    }
  } else {
    console.log(hi.body.slice(0, 300));
  }
  console.log('\n=== done ===');
  process.exit(0);
})();
