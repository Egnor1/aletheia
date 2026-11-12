// 打一份当前环境切片（阶段一看到的原始数据），用于排障
// sudo pm2 start /var/www/app/proactive/tools/probe.js --name probe --cwd /var/www/app/proactive --no-autorestart
const api = require('../lib/serverapi');
(async () => {
  const snap = await api.snapshot();
  console.log('snapshot:', JSON.stringify(snap, null, 2));
  const cfg = await api.config();
  console.log('server 侧配置可见:', cfg && cfg.ok);
})();
