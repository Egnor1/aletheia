// 对比服务端 / 手机端的 APP_TOKEN，并分别打 3000 与 3443 两个端口，定位 401 到底出在哪一层
// 用法（VPS，root）：
//   sudo pm2 start /var/www/app/proactive/tools/token-check.js --name token-check --cwd /var/www/app/proactive --no-autorestart && sleep 4 && sudo pm2 logs token-check --lines 30 --nostream && sudo pm2 delete token-check
// 手机端对比：
//   tok=$(sed -n 's/^APP_TOKEN=//p' ~/proactive.env | head -1 | tr -d '\r'); echo -n "$tok" | wc -c; echo -n "$tok" | sha256sum | cut -c1-12
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { loadEnv } = require('../lib/env');

function fp(tok) {
  const h = crypto.createHash('sha256').update(tok, 'utf8').digest('hex').slice(0, 12);
  return { len: tok.length, sha12: h, hasSpace: /\s/.test(tok), hasQuote: /["']/.test(tok) };
}

function hit(mod, port, path, token) {
  return new Promise((resolve) => {
    const req = mod.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { 'X-Auth-Token': token },
      rejectUnauthorized: false,
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve(`${port}${path} → ${r.statusCode} ${Buffer.concat(c).toString('utf8').slice(0, 100)}`));
    });
    req.on('error', e => resolve(`${port}${path} → ERR ${e.message}`));
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  const envToken = process.env.APP_TOKEN || '';
  const fileEnv = loadEnv();
  const fileToken = fileEnv.APP_TOKEN || '';

  console.log('进程环境 APP_TOKEN:', envToken ? JSON.stringify(fp(envToken)) : '(空)');
  console.log('.env 文件 APP_TOKEN:', fileToken ? JSON.stringify(fp(fileToken)) : '(空)');

  const target = fileToken || envToken;
  if (!target) { console.log('没有可用 token'); return; }

  console.log(await hit(http, 3000, '/api/proactive/pending', target));
  console.log(await hit(https, 3443, '/api/proactive/pending', target));
  console.log('对照（故意用错 token 打 3443）:', await hit(https, 3443, '/api/proactive/pending', 'bogus-token'));
  console.log('手机端应与此一致 → 长度', target.length, 'sha12', fp(target).sha12);
})();
