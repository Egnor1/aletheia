// 清掉测试残留：测试排期指令 + 测试聊天写进 logs/*.jsonl 的行（避免 5 点 daily_extract 提取成假记忆）
// sudo pm2 start /var/www/app/proactive/tools/cleanup-test.js --name cleanup --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const DIR = '/var/www/app/proactive/state/directives.json';
const LOG = '/var/www/app/logs/2026-10-14.jsonl';

// 1) 指令表
try {
  const arr = JSON.parse(fs.readFileSync(DIR, 'utf8'));
  const keep = arr.filter(d => !['test', 'model-ds'].includes(d.source) || d.consumed);
  fs.writeFileSync(DIR, JSON.stringify(keep, null, 2));
  console.log(`指令表: ${arr.length} → ${keep.length} 条（留下的：${keep.map(k => k.condition).join(' | ') || '无'}）`);
} catch (e) { console.log('指令表处理失败:', e.message); }

// 2) 日志行
try {
  const raw = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const bad = ['schedule_nudge 工具', '接一杯温水喝掉', '喝水偏少', '排好了，7 分钟后叫你'];
  const keep = raw.filter(l => !bad.some(b => l.includes(b)));
  fs.writeFileSync(LOG, keep.join('\n') + '\n');
  console.log(`今日日志: ${raw.length} → ${keep.length} 行（清掉 ${raw.length - keep.length} 行测试内容）`);
} catch (e) { console.log('日志处理失败:', e.message); }
