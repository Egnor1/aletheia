// 端到端自检：走真实 /api/chat/stream（临时会话，不写进用户对话）
//   第 1 轮 → 期望日志出现「[cache] 已建立」
//   第 2 轮 → 期望日志出现「[cache] 命中」，且 cachedContentTokenCount > 0
// 跑法：sudo pm2 start .../test-cache-e2e.js --name test-cache-e2e --cwd /var/www/app --no-autorestart
const fs = require('fs');
const http = require('http');

function env() {
  const out = {};
  for (const raw of fs.readFileSync('/var/www/app/.env', 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}
function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try { return JSON.parse(fs.readFileSync('/var/www/app/proactive/state/runtime-keys.json', 'utf8')).gemini || ''; } catch { return ''; }
}

function stream(token, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: 3000, path: '/api/chat/stream', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Auth-Token': token },
      timeout: 180000,
    }, (res) => {
      let buf = '';
      const out = { status: res.statusCode, text: '', usage: null, errors: [] };
      res.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.replace(/^data: /, '').trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'answer') out.text += obj.text || '';
            if (obj.type === 'done') out.usage = obj.usageMetadata || null;
            if (obj.type === 'error') out.errors.push(obj.message);
          } catch {}
        }
      });
      res.on('end', () => resolve(out));
    });
    rq.on('error', e => resolve({ status: 0, errors: [String(e)] }));
    rq.on('timeout', () => { rq.destroy(); resolve({ status: 0, errors: ['timeout'] }); });
    rq.write(data);
    rq.end();
  });
}

const PREFIX_TURNS = 24;
(async () => {
  const e = env();
  const token = e.APP_TOKEN || '';
  const key = geminiKey();
  if (!token) { console.log('NO_APP_TOKEN'); return; }
  if (!key) { console.log('NO_GEMINI_KEY'); return; }
  const convId = 'cachetest_' + Date.now();
  const model = 'gemini-3.8-flash';

  const filler = '测试用的历史对话内容，用来撑大上下文前缀，里面有一些中文和数字 2026-11-16，重复若干次。';
  const contents = [];
  for (let i = 0; i < PREFIX_TURNS; i++) {
    contents.push({ role: 'user', parts: [{ text: `第 ${i} 轮提问：` + filler.repeat(12) }] });
    contents.push({ role: 'model', parts: [{ text: `第 ${i} 轮回答：` + filler.repeat(10) }] });
  }
  const base = contents.slice();

  const turn1 = base.concat([{ role: 'user', parts: [{ text: '一句话确认：你看到的历史里出现过的数字是哪个？' }] }]);
  const r1 = await stream(token, { apiKey: key, model, contents: turn1, convId, generationConfig: { maxOutputTokens: 200, temperature: 0 } });
  console.log('R1 status', r1.status, 'usage=', JSON.stringify(r1.usage), 'errors=', r1.errors.join('|').slice(0, 120));

  // 模拟第二轮回合（新增一轮问答 + 新问题）
  const turn2 = turn1
    .concat([{ role: 'model', parts: [{ text: r1.text || '（回答）' }] }])
    .concat([{ role: 'user', parts: [{ text: '再确认一次：数字是多少？' }] }]);
  await new Promise(r => setTimeout(r, 3000));   // 等后台建缓存
  const r2 = await stream(token, { apiKey: key, model, contents: turn2, convId, generationConfig: { maxOutputTokens: 200, temperature: 0 } });
  console.log('R2 status', r2.status, 'usage=', JSON.stringify(r2.usage), 'errors=', r2.errors.join('|').slice(0, 120));

  const hit1 = (r1.usage && r1.usage.cachedContentTokenCount) || 0;
  const hit2 = (r2.usage && r2.usage.cachedContentTokenCount) || 0;
  console.log(`缓存命中：第1轮 ${hit1} / 第2轮 ${hit2}`);
  console.log(hit2 > 0 ? '✅ 第二轮命中缓存' : '❌ 第二轮没命中（看 chat 日志里的 [cache] 行）');

  // 清掉临时会话文件
  try {
    const f = `/var/www/app/conversations/${convId}.json`;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('已删除临时会话文件', convId); }
  } catch (err) { console.log('删除临时会话失败（无害）:', err.message); }
})();
