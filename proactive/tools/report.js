// 主动消息复盘：一条命令看清最近 N 小时的节奏、成本与结果
// 用法（不需要 root / token，读的都是本地状态文件）：
//   node /var/www/app/proactive/tools/report.js [小时数，默认 24]
const fs = require('fs');
const path = require('path');
const STATE_DIR = path.join(__dirname, '..', 'state');
const cfg = require('../config.json');

const hours = Number(process.argv[2]) || 24;
const since = Date.now() - hours * 3600 * 1000;
const cst = (t) => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function readJsonl(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

const rows = readJsonl(path.join(STATE_DIR, 'history.jsonl')).filter(r => Date.parse(r.at) >= since);
let state = {};
try { state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8')); } catch {}
let pending = [];
try { pending = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'pending.json'), 'utf8')) || []; } catch {}

// 成本估算（deepseek-chat 约 ¥2/M 输入、¥8/M 输出；Gemini 更贵，这里只做量级参考）
const DS_IN = 2 / 1e6, DS_OUT = 8 / 1e6;
let gateCalls = 0, gateIn = 0, gateOut = 0, stage2Calls = 0, s2In = 0, s2Out = 0, cost = 0;

console.log(`\n═══ 主动消息复盘 · 最近 ${hours} 小时（现在 ${cst(Date.now())}）═══`);
console.log(`总开关: ${cfg.active_push_enabled ? 'on' : 'OFF'} ｜ 管道: ${cfg.delivery.channel} ｜ 静默窗: ${cfg.blackout.start}-${cfg.blackout.end}`);
console.log(`下次候选触发: ${state.nextTriggerAt ? cst(state.nextTriggerAt) : '—'} ｜ 冷却至: ${state.cooldownUntil ? cst(state.cooldownUntil) : '—'}`);
console.log(`今日配额: 阶段一 ${state.dayCounters?.stage1 || 0}/${cfg.daily_limits.stage1_calls}，阶段二 ${state.dayCounters?.stage2 || 0}/${cfg.daily_limits.stage2_calls}，已发 ${state.dayCounters?.sent || 0}/${cfg.daily_limits.delivered}`);
if (state.paused && state.paused.until > Date.now()) console.log(`⚠️ 熔断中: ${state.paused.reason}（至 ${cst(state.paused.until)}）`);
if (!rows.length) { console.log(`\n这段时间没有任何决策记录（可能是刚重启 / 或一直 idle）。\n`); process.exit(0); }

const by = (k) => rows.filter(r => r.outcome === k);
console.log(`\n决策合计 ${rows.length} 条：` + Object.entries(rows.reduce((a, r) => (a[r.outcome] = (a[r.outcome] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(' · '));

const events = rows.filter(r => !['idle', 'blackout'].includes(r.outcome));
if (events.length) {
  // 连续相同 outcome（比如一次事故刷出来的 quota_exhausted）折叠成一行
  const collapsed = [];
  for (const r of events) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.outcome === r.outcome && last.trigger === r.trigger && r.outcome !== 'sent' && r.outcome !== 'silent') {
      last.n = (last.n || 1) + 1;
    } else {
      collapsed.push({ ...r });
    }
  }
  console.log('\n—— 事件（非 idle/静默）——');
  for (const r of collapsed) {
    if (r.n > 1) { console.log(`  ${cst(Date.parse(r.at))}  · ${r.outcome} ×${r.n}（合并显示）`); continue; }
    const d = r.decision || {};
    const t = cst(Date.parse(r.at));
    if (r.outcome === 'sent') {
      const g = r.usage?.gate, s2 = r.usage?.stage2;
      if (g) { gateCalls++; gateIn += g.in || 0; gateOut += g.out || 0; }
      if (s2) { stage2Calls++; s2In += s2.promptTokenCount || 0; s2Out += s2.candidatesTokenCount || 0; }
      console.log(`  ${t}  ✅ 发出  [${r.trigger}/${r.category}] ${(r.text || '').replace(/\n/g, ' ').slice(0, 60)}…`);
      if (g && s2) console.log(`             阶段一 ${g.in}/${g.out} tok ｜ 阶段二 ${s2.promptTokenCount}/${s2.candidatesTokenCount} tok ｜ ~¥${((g.in * DS_IN + g.out * DS_OUT) + (s2.promptTokenCount * DS_IN + s2.candidatesTokenCount * DS_OUT)).toFixed(3)}`);
    } else if (r.outcome === 'silent') {
      if (r.usage) { gateCalls++; gateIn += r.usage.in || 0; gateOut += r.usage.out || 0; }
      console.log(`  ${t}  🤐 否决  [${r.trigger}] ${d.category || '-'}：${d.trigger_reason || ''}（情绪：${d.emotional_context || '-'}）`);
    } else if (r.outcome === 'gate_failed') {
      console.log(`  ${t}  ⚠️ 阶段一失败：${r.error}${r.raw ? ' | ' + String(r.raw).slice(0, 80) : ''}`);
    } else if (r.outcome === 'snapshot_failed' || r.outcome === 'paused' || r.outcome === 'suspended') {
      console.log(`  ${t}  ⏸ ${r.outcome}${r.error ? '：' + r.error : ''}${r.reason ? '：' + r.reason : ''}`);
    } else {
      console.log(`  ${t}  · ${r.outcome}${r.trigger ? ' [' + r.trigger + ']' : ''}${r.error ? '：' + r.error : ''}`);
    }
  }
} else {
  console.log('\n这段时间没有触发过（一直 idle/静默）。');
}

// 手机心跳（取件器每 5 分钟报一次）：用来区分「手机/脚本挂了」和「手表断了」
try {
  const files = fs.readdirSync('/var/www/app/health').filter(f => /^phone-status-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const last = files.length ? fs.readFileSync(path.join('/var/www/app/health', files[files.length - 1]), 'utf8').trim().split('\n').pop() : null;
  if (last) {
    const st = JSON.parse(last);
    const age = Math.round((Date.now() - st._received_ts) / 60000);
    console.log(`手机上报心跳: ${age <= 15 ? '✅' : '❌'} ${age} 分钟前（${st.node || '?'}）`);
  } else {
    console.log('手机上报心跳: 无（取件器还没更新到带心跳的版本）');
  }
} catch {}

// 手机使用状态 / 屏幕线索（服务端 /api/presence + activity 的 streak）
try {
  const { execFileSync } = require('child_process');
  const { loadEnv } = require('../lib/env');
  const env = loadEnv();
  const TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
  const raw = execFileSync('curl', ['-s', '--max-time', '8', '-H', `X-Auth-Token: ${TOKEN}`, 'http://127.0.0.1:3000/api/health'], { encoding: 'utf8' });
  const j = JSON.parse(raw || '{}');
  const p2 = j.presence || {};
  const act = j.activity || {};
  console.log(`手机使用状态: ${p2.in_use ? '📱 正在看手机' : (p2.last_active_minutes_ago != null ? `最后操作 ${p2.last_active_minutes_ago} 分钟前` : '未知（App 还没上报）')}`);
  const stk = act.streak;
  if (stk && stk.app) console.log(`屏幕线索: ${stk.app} 最近累计 ${stk.minutes} 分钟${stk.live ? '（正在用）' : ''}（来源 ${stk.source}）`);
  else console.log('屏幕线索: 无（MacroDroid 未上报、App 使用时长样本不足）');
} catch (e) { console.log('手机使用状态: 读取失败 ' + e.message); }

// 手表数据新鲜度
try {
  const files = fs.readdirSync('/var/www/app/health').filter(f => /^realtime-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  if (files.length) {
    const lines = fs.readFileSync(path.join('/var/www/app/health', files[files.length - 1]), 'utf8').trim().split('\n');
    const d = JSON.parse(lines[lines.length - 1]);
    const age = Math.round((Date.now() - d._ts) / 60000);
    console.log(`手表数据: ${age <= 15 ? '✅' : '❌'} ${age} 分钟前（HR ${d.heart_rate ?? '-'} / 步 ${d.steps ?? '-'}）  ← 两个都 ❌ 查手机，只有这个 ❌ 查手环`);
  }
} catch {}

const unresolved = pending.filter(p => !p.consumed);
console.log(`\n待推队列: ${unresolved.length} 条未取` + (unresolved.length ? `（最早 ${cst(unresolved[0].at)}）` : ''));
if (gateCalls || stage2Calls) {
  cost = gateIn * DS_IN + gateOut * DS_OUT + s2In * DS_IN + s2Out * DS_OUT;
  console.log(`成本估算: 阶段一 ${gateCalls} 次(${gateIn}/${gateOut} tok) + 阶段二 ${stage2Calls} 次(${s2In}/${s2Out} tok) ≈ ¥${cost.toFixed(3)}`);
}
console.log('');
