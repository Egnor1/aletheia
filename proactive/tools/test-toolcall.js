// 验证「模型自己调用 schedule_nudge」：真发一次 /api/chat/stream（DeepSeek），看它会不会排期
// sudo pm2 start /var/www/app/proactive/tools/test-toolcall.js --name test-tc --cwd /var/www/app/proactive --no-autorestart
const http = require('http');
const fs = require('fs');
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const DIRECTIVES = '/var/www/app/proactive/state/directives.json';

const body = JSON.stringify({
  model: 'deepseek-v4-flash',
  convId: 'toolcall_test',
  ragMemory: true,
  systemInstruction: { parts: [{ text: '你是 Daemon。' }] },
  contents: [{ role: 'user', parts: [{ text: '帮我在 7 分钟后提醒我喝水，用 schedule_nudge 工具排一下。' }] }],
  generationConfig: { maxOutputTokens: 800 },
});

const before = (() => { try { return JSON.parse(fs.readFileSync(DIRECTIVES, 'utf8')).length; } catch { return 0; } })();

const req = http.request({ host: '127.0.0.1', port: 3000, path: '/api/chat/stream', method: 'POST',
  headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let buf = '';
  res.on('data', (d) => {
    buf += d.toString();
    for (const line of buf.split('\n')) {
      if (line.startsWith('data: ') && (line.includes('tool_call') || line.includes('error'))) {
        console.log('SSE:', line.slice(6, 200));
      }
    }
    buf = '';
  });
  res.on('end', () => {
    setTimeout(() => {
      let after = [];
      try { after = JSON.parse(fs.readFileSync(DIRECTIVES, 'utf8')); } catch {}
      console.log(`指令表: ${before} 条 → ${after.length} 条`);
      for (const d of after.slice(-2)) {
        console.log('  →', JSON.stringify({ condition: d.condition, delay: Math.round((d.at - d.created) / 60000) + '分钟', tone: d.tone, category: d.category, source: d.source }));
      }
      console.log(after.length > before ? '✅ 模型成功调用 schedule_nudge' : '❌ 没排上（看 SSE 输出）');
    }, 800);
  });
});
req.on('error', e => console.log('请求失败:', e.message));
req.write(body); req.end();
