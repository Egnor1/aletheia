// 端到端验证：注入的三段（主动提醒排期 / 最近工具调用）真的进了 system prompt，模型能读到
// 只发一条极短消息（DeepSeek），代价约 ¥0.01；跑完删掉临时对话 + 清理日志里的测试行
// sudo pm2 start /var/www/app/proactive/tools/test-prompt-inject.js --name tpi --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');

const TOKEN = process.env.APP_TOKEN || loadEnv().APP_TOKEN || '';
const CONV = 'conv_test_inject_' + Date.now().toString(36);
const COND = '自测用：提醒生生把数学作业拍照发过来（可删）';
const STATE_DIR = path.join(__dirname, '..', 'state');
const dirFile = path.join(STATE_DIR, 'directives.json');
const toolFile = path.join(STATE_DIR, 'tool-calls.json');

function req(method, p, body, raw = false) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3000, path: p, method,
      headers: Object.assign({ 'X-Auth-Token': TOKEN }, payload ? { 'Content-Type': 'application/json' } : {}),
    }, (res) => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(c).toString('utf8');
        if (raw) return resolve({ status: res.statusCode, text: txt });
        try { resolve({ status: res.statusCode, json: JSON.parse(txt) }); } catch { resolve({ status: res.statusCode, text: txt }); }
      });
    });
    r.on('error', e => resolve({ status: 0, text: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

function backup(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function restore(file, b) {
  try { if (b === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else fs.writeFileSync(file, b); } catch {}
}

(async () => {
  const dirBak = backup(dirFile);
  const toolBak = backup(toolFile);

  // 造一条排期 + 一条别的工具调用，确保两个块都非空
  await req('POST', '/api/proactive/directive', { delay_minutes: 30, condition: COND, source: 'test' });
  let arr = [];
  try { arr = JSON.parse(toolBak || '[]'); } catch {}
  arr.push({ at: Date.now() - 5 * 60000, time: '10:10', tool: 'save_memory', status: 'ok', summary: '写入记忆（memo）：自测记忆，可删' });
  fs.writeFileSync(toolFile, JSON.stringify(arr), 'utf8');

  console.log('创建临时对话:', CONV);
  console.log('POST /api/conversations →', (await req('POST', '/api/conversations', { id: CONV, title: '注入自测' })).status);

  const body = {
    model: 'deepseek-chat',
    convId: CONV,
    ragMemory: true,
    contents: [{
      role: 'user',
      parts: [{ text: '只做一件事：把上下文里 [主动提醒排期] 和 [最近工具调用] 两个块的内容原样复述出来；如果哪个块不存在就写"没有该块"。不要做别的事。' }],
    }],
  };
  const r = await req('POST', '/api/chat/stream', body, true);
  const text = r.text || '';
  const answers = [...text.matchAll(/"type":"answer","text":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse('"' + m[1] + '"')).join('');
  console.log('HTTP', r.status);
  console.log('模型回复:\n' + (answers || '(无 answer 事件，原始前 400 字：' + text.slice(0, 400) + ')'));
  console.log('\n判定: 排期块' + (answers.includes('数学作业') ? ' ✅ 读到了' : ' ❌ 没读到')
    + ' ｜ 工具块' + (answers.includes('自测记忆') ? ' ✅ 读到了' : ' ❌ 没读到'));

  // 清理
  await req('DELETE', `/api/conversations/${CONV}`);
  restore(dirFile, dirBak);
  restore(toolFile, toolBak);
  // 清掉日志里的测试行
  const logDir = '/var/www/app/logs';
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const logFile = path.join(logDir, `${today}.jsonl`);
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter(l => !l.includes('主动提醒排期] 和 [最近工具调用') && !l.includes('只做一件事：把上下文里'));
    fs.writeFileSync(logFile, kept.join('\n') + (kept.length ? '\n' : ''));
    console.log(`日志清理：${lines.length} → ${kept.length} 行`);
  } catch (e) { console.log('日志清理失败（不影响功能）:', e.message); }
  console.log('临时对话与排期/工具记录已清理');
})();
