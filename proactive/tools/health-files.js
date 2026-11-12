// 以 root 身份看 /var/www/app/health 下的文件（egnor 没权限，必须走 pm2）
// sudo pm2 start /var/www/app/proactive/tools/health-files.js --name hf --cwd /var/www/app/proactive --no-autorestart && sleep 3 && sudo pm2 logs hf --lines 40 --nostream && sudo pm2 delete hf
const fs = require('fs');
const path = require('path');

const DIR = '/var/www/app/health';
const files = fs.readdirSync(DIR)
  .filter(f => /^(phone-status|realtime|activity)/.test(f))
  .sort();
const now = Date.now();
console.log('服务器当前时间:', new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
for (const f of files.slice(-6)) {
  const p = path.join(DIR, f);
  const st = fs.statSync(p);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const last = lines[lines.length - 1];
  let t = null;
  try { const o = JSON.parse(last); t = o._received_ts || o.ts || null; } catch {}
  const ago = t ? Math.round((now - t) / 60000) : null;
  console.log(`${f} | ${lines.length} 条 | 改动 ${Math.round((now - st.mtimeMs) / 60000)} 分钟前 | 最后记录 ${ago === null ? '?' : ago + ' 分钟前'}`);
  if (/phone-status/.test(f)) console.log('   尾巴:', last.slice(0, 220));
}
