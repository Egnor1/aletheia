// 手动清空当天配额与冷却（state.json 是 root 600，egnor 手动改不了）
// 正确跑法（一次性，别让 pm2 重启它）：
//   sudo pm2 start /var/www/app/proactive/tools/reset-quota.js --name reset-quota --cwd /var/www/app/proactive --no-autorestart
//   sudo pm2 logs reset-quota --nostream --lines 5 ; sudo pm2 delete reset-quota
const { loadState, saveState } = require('../lib/store');

const st = loadState();
const before = JSON.stringify(st.dayCounters);
st.dayCounters = { date: '', stage1: 0, stage2: 0, sent: 0 };
st.cooldownUntil = 0;
saveState(st);
console.log(`[reset-quota] 已清空：${before} → ${JSON.stringify(st.dayCounters)}，冷却=0`);
