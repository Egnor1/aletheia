// 直接跑一次阶段一（决策门），输出压成一行，方便看 pm2 日志尾巴
// sudo pm2 start /var/www/app/proactive/tools/test-gate.js --name test-gate --cwd /var/www/app/proactive --no-autorestart
const api = require('../lib/serverapi');
(async () => {
  const snap = await api.snapshot();
  const t0 = Date.now();
  const r = await api.decide({});
  const ms = Date.now() - t0;
  if (r && r.ok) {
    console.log(`GATE OK ${ms}ms provider=${r.provider} usage=${JSON.stringify(r.usage)}`);
    console.log('DECISION ' + JSON.stringify(r.decision));
  } else {
    console.log(`GATE FAIL ${ms}ms provider=${r && r.provider} status=${r && r.status} error=${r && r.error}`);
    console.log('RAW ' + String((r && r.raw) || '').slice(0, 300));
  }
  console.log('SNAP ' + JSON.stringify({ since_user: snap.snapshot && snap.snapshot.minutes_since_user_msg, hr: snap.snapshot && snap.snapshot.health.hr, top: snap.snapshot && snap.snapshot.screen.top_app, top_min: snap.snapshot && snap.snapshot.screen.top_app_minutes }));
})();
