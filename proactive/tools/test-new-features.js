// 新功能自测：手机使用状态(presence) / 单 App 连续使用(streak) / 工具调用记录 + 排期去重
// 全程只打本地回环，不花 API 钱；跑完自动把 screentime / directives / tool-calls 恢复原状
// sudo pm2 start /var/www/app/proactive/tools/test-new-features.js --name tnf --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const HEALTH_DIR = '/var/www/app/health';
const STATE_DIR = path.join(__dirname, '..', 'state');
const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

function call(method, p, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: 3000, path: p, method,
      headers: Object.assign({ 'X-Auth-Token': TOKEN }, payload ? { 'Content-Type': 'application/json' } : {}),
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => {
        const txt = Buffer.concat(c).toString('utf8');
        let j = null;
        try { j = JSON.parse(txt); } catch {}
        resolve({ status: r.statusCode, json: j, text: txt });
      });
    });
    req.on('error', e => resolve({ status: 0, json: null, text: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const backups = {};
function backup(file) {
  try { backups[file] = fs.readFileSync(file, 'utf8'); } catch { backups[file] = null; }
}
function restore(file) {
  try {
    if (backups[file] === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else fs.writeFileSync(file, backups[file]);
    return true;
  } catch (e) { console.log(`  ⚠️ 恢复失败 ${file}: ${e.message}`); return false; }
}

(async () => {
  const screenFile = path.join(HEALTH_DIR, `screentime-${ymd()}.jsonl`);
  const dirFile = path.join(STATE_DIR, 'directives.json');
  const toolFile = path.join(STATE_DIR, 'tool-calls.json');

  console.log('=== 1) presence：手机使用状态 ===');
  const p1 = await call('POST', '/api/presence', { visible: true, source: 'aletheia', ts: Date.now() });
  console.log(`POST /api/presence(visible) → ${p1.status} ${JSON.stringify(p1.json && p1.json.presence)}`);
  const h1 = await call('GET', '/api/health');
  console.log(`GET /api/health.presence → ${JSON.stringify(h1.json && h1.json.presence)}`);
  const p2 = await call('POST', '/api/presence', { visible: false, source: 'aletheia' });
  console.log(`POST /api/presence(hidden) → ${JSON.stringify(p2.json && p2.json.presence)}`);

  console.log('\n=== 2) streak：单 App 连续使用（灌两条假样本：3 小时前 + 15 分钟前）===');
  backup(screenFile);
  const now = Date.now();
  const fakePkg = 'com.ss.android.ugc.aweme';
  // 5 个样本：3 小时前起，每 45 分钟一次，抖音累计时长一路 +45（= 一直在刷）
  let last = null;
  for (let i = 0; i < 5; i++) {
    const ts = now - (180 - i * 45) * 60000;
    last = await call('POST', '/api/screen-time', {
      timestamp: ts,
      data: [{ pkg: fakePkg, mins: 30 + i * 45 }, { pkg: 'com.egnor.aletheia', mins: 4 + i }],
    });
  }
  console.log(`POST /api/screen-time ×5 → ${last.status}`);
  const h2 = await call('GET', '/api/health');
  console.log(`activity → ${JSON.stringify(h2.json && h2.json.activity)}`);
  const blocks = await call('GET', '/api/proactive/blocks');
  console.log('\n--- [生生此刻的手机状态] 注入块 ---');
  console.log((blocks.json && blocks.json.presence) || '(空)');
  const snapText = (blocks.json && blocks.json.snapshot_text) || '';
  const phoneLine = snapText.split('\n').filter(l => /^(手机|屏幕|已排好的主动提醒|我最近调用过的工具)/.test(l));
  console.log('--- GATE1 里的相关行 ---');
  console.log(phoneLine.join('\n') || '(无)');
  restore(screenFile);
  console.log(`screentime 文件已恢复：${screenFile}`);

  console.log('\n=== 3) schedule_nudge 去重 + 工具调用记录 ===');
  backup(dirFile);
  backup(toolFile);
  const cond = '自测：检查今天的数学作业（可删）';
  const d1 = await call('POST', '/api/proactive/directive', { delay_minutes: 60, condition: cond, source: 'test' });
  const d2 = await call('POST', '/api/proactive/directive', { delay_minutes: 60, condition: cond, source: 'test' });
  console.log(`第一次排期 → ${d1.status} duplicate=${d1.json?.directive?.duplicate || false}`);
  console.log(`第二次排期（同样的条件）→ ${d2.status} duplicate=${d2.json?.directive?.duplicate === true}`);
  const list = await call('GET', '/api/proactive/directive');
  const same = (list.json?.directives || []).filter(x => x.condition === cond);
  console.log(`同条件的条目数量 = ${same.length}（应为 1）`);
  const blocks2 = await call('GET', '/api/proactive/blocks');
  console.log('\n--- [主动提醒排期] 注入块 ---');
  console.log((blocks2.json && blocks2.json.directives) || '(空)');
  console.log('--- [最近工具调用] 注入块 ---');
  console.log((blocks2.json && blocks2.json.tool_calls) || '(空)');
  restore(dirFile);
  restore(toolFile);
  console.log('directives.json / tool-calls.json 已恢复');

  // 内存里的 screenSampleHistory 还留着刚才灌进去的假样本（文件已还原），必须重启 chat 清掉，
  // 否则后面注入给模型的"连续使用"会是假的
  try {
    require('child_process').execFileSync('pm2', ['restart', 'chat'], { stdio: 'ignore' });
    console.log('\n已重启 chat（清掉内存里的假屏幕样本）');
  } catch (e) {
    console.log('\n⚠️ 自动重启 chat 失败，请手动执行：sudo pm2 restart chat');
  }

  console.log('\n=== 完成：手工核对上面每段是否为预期 ===');
})();
