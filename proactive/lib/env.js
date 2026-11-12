// 读 /var/www/app/.env（和 server.js 同源），不引第三方依赖
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '..', '..', '.env')) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

module.exports = { loadEnv };
