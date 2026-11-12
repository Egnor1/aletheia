// 验证「/pending 请求 = 手机心跳」这条链路（模拟手机来取件一次）
// sudo pm2 start /var/www/app/proactive/tools/test-heartbeat.js --name test-hb --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const http = require('http');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const before = (() => { try { return fs.readdirSync('/var/www/app/health').filter(f => f.startsWith('phone-status-')).length; } catch { return 0; } })();
const req = http.request({ host: '127.0.0.1', port: 3000, path: '/api/proactive/pending', method: 'GET', headers: { 'X-Auth-Token': TOKEN } }, (r) => {
  const c = []; r.on('data', d => c.push(d));
  r.on('end', () => {
    console.log('GET /pending →', r.statusCode, Buffer.concat(c).toString().slice(0, 80));
    setTimeout(() => {
      const files = fs.readdirSync('/var/www/app/health').filter(f => f.startsWith('phone-status-'));
      console.log('心跳文件: 之前', before, '个 → 现在', files.length, '个', files.length > before ? '✅ 机制通' : '❌ 没写');
      if (files.length) console.log('内容:', fs.readFileSync('/var/www/app/health/' + files[files.length - 1], 'utf8').trim().split('\n').pop());
    }, 500);
  });
});
req.on('error', e => console.log('请求失败:', e.message));
req.end();
