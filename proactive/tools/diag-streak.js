const fs = require('fs');
const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const files = [`/var/www/app/health/screentime-${ymd()}.jsonl`];
let samples = [];
for (const f of files) {
  try {
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      const e = JSON.parse(line);
      const map = {};
      for (const it of e.data || []) map[it.pkg] = Number(it.mins) || 0;
      samples.push({ ts: Number(e.timestamp), map });
    }
  } catch (e) { console.log('读失败', f, e.message); }
}
samples.sort((a, b) => a.ts - b.ts);
console.log('样本数:', samples.length, '｜首', new Date(samples[0].ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), '｜末', new Date(samples[samples.length - 1].ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
console.log('服务器现在:', new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
const CHAT = 'com.egnor.aletheia';
let okPairs = 0, total = 0;
for (let i = Math.max(1, samples.length - 12); i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  const gap = (b.ts - a.ts) / 60000;
  let top = null, td = 0;
  for (const p of Object.keys(b.map)) {
    if (p === CHAT) continue;
    const d = (b.map[p] || 0) - (a.map[p] || 0);
    if (d > td) { td = d; top = p; }
  }
  const chatD = (b.map[CHAT] || 0) - (a.map[CHAT] || 0);
  const ratio = top && gap > 0 ? (td / gap).toFixed(2) : '-';
  total++;
  if (top && td >= 3 && td / gap >= 0.5) okPairs++;
  console.log(`${new Date(a.ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} → ${new Date(b.ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}  间隔${gap.toFixed(0)}m  主导:${(top || '无').split('.').pop()} +${td}m 比值${ratio}  聊天App +${chatD}m`);
}
console.log(`近 ${total} 对里"一直在用某 App"的有 ${okPairs} 对`);
