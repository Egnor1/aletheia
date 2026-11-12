// 纯本地测：连续使用某 App 几小时 → 是否触发 screen_time_audit 异常
// node proactive/tools/test-screen-trigger.js
const T = require('../triggers');

const cfg = require('../config.json');
const now = Date.now();
const mkSnap = (screen) => ({ health: { hr: 78, steps_5min: 20 }, screen });
const st = () => ({ anomalyLastFired: {} });

function run(label, screen, state = st(), nowTs = now) {
  const out = T.anomalyCheck(nowTs, mkSnap(screen), state, cfg);
  const hit = out.find(a => a.kind === 'screen');
  console.log(`${hit ? '✅ 触发' : '❌ 不触发'}  ${label}${hit ? ' → ' + hit.reason + ' | ' + JSON.stringify(hit.detail) : ''}`);
  return hit;
}

console.log('阈值：screen_single_app_minutes =', cfg.anomaly.screen_single_app_minutes,
  '｜冷却 screen_min_gap_minutes =', cfg.anomaly.screen_min_gap_minutes,
  '｜安静时段', JSON.stringify(cfg.anomaly.screen_quiet_hours));

// 用 10:00 这个"非安静时段"当 now，避免当前真实时间落在 23:30-01:30 里影响结果
const ten = new Date('2026-10-24T10:00:00+08:00').getTime();

run('usage_delta 连续 210 分钟（没有 MacroDroid）', {
  current_app: null, current_foreground_minutes: 0, top_app: '抖音', top_app_minutes: 210,
  streak: { app: '抖音', minutes: 210, live: false, ended_minutes_ago: 0, source: 'usage_delta' },
}, st(), ten);

run('usage_delta 只有 120 分钟（未到阈值）', {
  current_app: null, current_foreground_minutes: 0,
  streak: { app: '抖音', minutes: 120, live: false, source: 'usage_delta' },
}, st(), ten);

run('MacroDroid 实时前台 200 分钟（live）', {
  current_app: '抖音', current_foreground_minutes: 200,
  streak: { app: '抖音', minutes: 200, live: true, source: 'macro' },
}, st(), ten);

run('4 小时内已经抓过一次（冷却中）', {
  current_app: '抖音', current_foreground_minutes: 200,
  streak: { app: '抖音', minutes: 200, live: true, source: 'macro' },
}, { anomalyLastFired: { screen: ten - 60 * 60000 } }, ten);

run('深夜安静时段 00:10（不该抓）', {
  current_app: '抖音', current_foreground_minutes: 200,
  streak: { app: '抖音', minutes: 200, live: true, source: 'macro' },
}, st(), new Date('2026-10-24T00:10:00+08:00').getTime());

run('4 小时前抓过、现在已经过冷却', {
  current_app: '抖音', current_foreground_minutes: 200,
  streak: { app: '抖音', minutes: 200, live: true, source: 'macro' },
}, { anomalyLastFired: { screen: ten - 250 * 60000 } }, ten);
