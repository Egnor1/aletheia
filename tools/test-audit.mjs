#!/usr/bin/env node
// 记账（Audit）模块自测：后端接口 + 前端逻辑（DOM stub，canvas 用记录器）
//
//   APP_TOKEN=audit_test_token node server.js &      # 本地起服务（另开一个终端）
//   node tools/test-audit.mjs                         # 默认打 http://127.0.0.1:3000
//   或：BASE=http://127.0.0.1:3000 TOKEN=xxx node tools/test-audit.mjs
//
// 说明：脚本会**先清空 audit/ 目录**（本地数据目录），再跑完全部断言，
// 最后把测试数据删干净。别在生产目录上跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const TOKEN = process.env.TOKEN || 'audit_test_token';

if (!process.env.KEEP_DATA) {
  fs.rmSync(path.join(ROOT, 'audit'), { recursive: true, force: true });
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsStart = html.indexOf('// ===== Audit (记账) =====');
const jsEnd = html.indexOf('// ===== D.O. Dashboard =====');
if (jsStart < 0 || jsEnd < 0) throw new Error('index.html 里找不到 audit 脚本块');
const auditJs = html.slice(jsStart, jsEnd);
const fillRoundBar = html.match(/function fillRoundBar\(ctx[\s\S]*?\n\}/)[0];

// ---------- DOM stub ----------
class ClassList {
  constructor() { this.s = new Set(); }
  add(c) { this.s.add(c); }
  remove(c) { this.s.delete(c); }
  contains(c) { return this.s.has(c); }
  toggle(c, force) {
    if (force === undefined) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); }
    else if (force) this.s.add(c); else this.s.delete(c);
    return this.s.has(c);
  }
}
function makeCtx(log) {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return s => ({ width: String(s).length * 6 });
      if (k === 'setTransform') return () => {};
      return (...args) => { log.push([String(k), ...args]); };
    },
    set(t, k, v) { log.push(['set:' + String(k), v]); return true; },
  });
}
class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.className = ''; this.style = {}; this.disabled = false;
    this.classList = new ClassList(); this.l = {}; this.ctxLog = [];
    this.clientWidth = 400; this.clientHeight = 168;
    this.offsetTop = 0; this.offsetWidth = 400; this.offsetHeight = 168;
  }
  addEventListener(e, f) { (this.l[e] = this.l[e] || []).push(f); }
  dispatch(e) { (this.l[e] || []).forEach(fn => fn({ key: '', preventDefault() {} })); }
  getContext() { return makeCtx(this.ctxLog); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  get parentElement() { return this; }
  focus() {} closest() { return null; }
}
const els = new Map();
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 2;
globalThis.addEventListener = () => {};
globalThis.escapeHtml = s => String(s || '');
globalThis.closeSidebar = () => {};
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => {
  const h = new Headers(o.headers || {});
  h.set('X-Auth-Token', TOKEN);
  return realFetch(BASE + u, { ...o, headers: h });
};

const A = new Function(auditJs + '\n' + fillRoundBar + `
  return { auditState, auditChart, AUDIT_CATS, AUDIT_INCOME_CATS, auditYAxis, auditYuanShort,
           auditParseCents, auditSanitizeAmount, auditYuan, auditDayKeyOf, auditCurrentMonthKey,
           auditMonthKeyOf, auditInputValueToTs, auditNowInputValue,
           openAudit, closeAudit, auditSetType, auditSubmit, auditApplyFilter, auditDelete,
           auditSetPieMode, auditRefresh, auditLoadPieDay };
`)();

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};
const api = async (p, opt) => {
  const r = await globalThis.fetch(p, opt);
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
};
const post = body => api('/api/audit/transactions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const todayKey = A.auditDayKeyOf(Date.now());
const monthKey = A.auditCurrentMonthKey();
const todayStart = Date.parse(`${todayKey}T00:00:00+08:00`);
const stamp = Date.now();
const cleanupIds = [];

// ---------- 1. 纯函数 ----------
console.log('\n[1] 金额解析 / 清洗 / 格式化');
check('19.99 → 1999 分（无浮点误差）', A.auditParseCents('19.99') === 1999);
check('0.1 → 10 分', A.auditParseCents('0.1') === 10);
check('三位小数被拒', A.auditParseCents('1.234') === null);
check('输入清洗 abc12.3456 → 12.34', A.auditSanitizeAmount('abc12.3456') === '12.34');
check('分转元 2850 → 28.50', A.auditYuan(2850) === '28.50');
check('y 轴刻度是整钱数（6220 → 0/20/40/60/80）', (() => { const y = A.auditYAxis(6220); return y.step === 2000 && y.lines === 4; })());
check('金额缩写 123456 → 1.2k', A.auditYuanShort(123456) === '1.2k');

// ---------- 2. 后端：创建 / 校验 ----------
console.log('\n[2] 后端校验');
const okExpense = await post({ amount: '12.50', category: '餐饮', note: 'T-午餐', timestamp: Date.now() });
if (okExpense.json?.transaction) cleanupIds.push(okExpense.json.transaction.id);
check('支出（不带 type）→ 201 且 type=expense', okExpense.status === 201 && okExpense.json.transaction.type === 'expense');
const okIncome = await post({ amount: '3000', type: 'income', category: '工资', note: 'T-工资', timestamp: Date.now() });
if (okIncome.json?.transaction) cleanupIds.push(okIncome.json.transaction.id);
check('入账（type=income + 工资）→ 201', okIncome.status === 201 && okIncome.json.transaction.type === 'income');
check('入账金额精度 3000 → 300000 分', okIncome.json.transaction.amount_cents === 300000);
const badCat = await post({ amount: '10', type: 'income', category: '餐饮' });
check('入账用支出分类 → 400', badCat.status === 400, JSON.stringify(badCat.json));
const badCat2 = await post({ amount: '10', category: '工资' });
check('支出用入账分类 → 400', badCat2.status === 400, JSON.stringify(badCat2.json));
const badType = await api('/api/audit/transactions?type=bad');
check('type 非法 → 400', badType.status === 400);
const badAmount = await post({ amount: '1.234', category: '餐饮' });
check('三位小数 → 400', badAmount.status === 400);

// ---------- 3. 后端：列表 / 汇总 / 导出 ----------
console.log('\n[3] 列表 / 汇总 / Daemon 导出');
const list = await api('/api/audit/transactions');
check('列表支出合计=12.50、入账合计=3000', list.json.total_amount === 12.5 && list.json.income_amount === 3000, JSON.stringify({ e: list.json.total_amount, i: list.json.income_amount }));
const listIncome = await api('/api/audit/transactions?type=income');
check('type=income 过滤生效', listIncome.json.total === 1 && listIncome.json.items[0].category === '工资');
const sum = await api('/api/audit/summary');
check('summary 支出/入账/净额', sum.json.total === 12.5 && sum.json.income === 3000 && sum.json.net === 2987.5, JSON.stringify({ t: sum.json.total, i: sum.json.income, n: sum.json.net }));
check('by_category 只含支出分类', sum.json.by_category.every(c => !A.AUDIT_INCOME_CATS.includes(c.category)));
check('income_by_category 只含入账分类', sum.json.income_by_category.every(c => A.AUDIT_INCOME_CATS.includes(c.category)));
check('daily 只算支出（不含入账）', sum.json.daily.every(d => d.total === 12.5), JSON.stringify(sum.json.daily));
const ctx = await api('/api/audit/context-export');
const ctxText = ctx.json.text;
check('Daemon 导出含「今日已支出」与明细金额', /今日已支出 12\.5 元 \(.*¥12\.5\)/.test(ctxText), ctxText);
check('Daemon 导出含「今日已入账」与明细金额', /今日已入账 3000\.0 元 \(.*工资.*¥3000\.0\)/.test(ctxText), ctxText);
check('Daemon 导出本周同时给支出和入账', /本周累计：支出 12\.5 元，入账 3000\.0 元/.test(ctxText), ctxText);

// ---------- 4. 面板：默认支出 / 切换入账 ----------
console.log('\n[4] 面板：支出 ⇄ 入账');
A.openAudit();
await sleep(1200);
check('默认是支出', A.auditState.type === 'expense');
check('分类胶囊是支出分类', $('auditCats').innerHTML.includes('餐饮') && !$('auditCats').innerHTML.includes('工资'));
check('提交按钮「记一笔」', $('auditSubmit').textContent === '记一笔');
check('分类筛选含支出/入账两组', /optgroup label="入账"/.test($('auditCatSel').innerHTML));
A.auditSetType('income');
check('切到入账：分类换成入账分类', $('auditCats').innerHTML.includes('工资') && A.auditState.cat === '工资');
check('切到入账：按钮变「记入账」+ 收入配色', $('auditSubmit').textContent === '记入账' && $('auditSubmit').classList.contains('income'));

// ---------- 5. 录入两种类型 ----------
// 期望值要把第 [2] 步建的 12.50 支出 + 3000 工资 一起算进去
const EXP_TOTAL = 1250 + 777;        // 分：12.50 + 7.77
const INC_TOTAL = 300000 + 20050;    // 分：3000 + 200.50
console.log('\n[5] 录入');
$('auditAmount').value = `200.5`; $('auditNote').value = `T-红包-${stamp}`;
await A.auditSubmit();
await sleep(1100);
check('入账提交成功提示「已入账」', /已入账 ¥200\.50/.test($('auditMsg').textContent), $('auditMsg').textContent);
check('金额/备注已清空', $('auditAmount').value === '' && $('auditNote').value === '');
A.auditSetType('expense');
$('auditAmount').value = `7.77`; $('auditNote').value = `T-早餐-${stamp}`;
await A.auditSubmit();
await sleep(1100);
let ledger = $('auditLedger').innerHTML;
check('流水里入账显示 +¥200.50（绿色类）', ledger.includes('+¥200.50') && /audit-item-amt income/.test(ledger));
check('流水里支出显示 -¥7.77', ledger.includes('-¥7.77'));
check('当天小计分开：支出与入账', ledger.includes(`支出 ¥${A.auditYuan(EXP_TOTAL)}`) && ledger.includes(`入账 ¥${A.auditYuan(INC_TOTAL)}`), ledger.slice(0, 240));
check('流水合计行分支出/入账', $('auditFilterSum').textContent.includes(`支出 ¥${A.auditYuan(EXP_TOTAL)}`) && $('auditFilterSum').textContent.includes(`入账 ¥${A.auditYuan(INC_TOTAL)}`), $('auditFilterSum').textContent);
check('摘要卡本月副标题带入账', $('auditStatMonthSub').textContent.includes(`入账 ¥${A.auditYuan(INC_TOTAL)}`), $('auditStatMonthSub').textContent);

// ---------- 6. 筛选 ----------
console.log('\n[6] 筛选');
$('auditCatSel').value = '工资';
A.auditApplyFilter();
await sleep(900);
check('按入账分类筛选生效', $('auditLedger').innerHTML.includes('T-工资') && !$('auditLedger').innerHTML.includes(`T-早餐-${stamp}`));
$('auditCatSel').value = '';
A.auditApplyFilter();
await sleep(900);

// ---------- 7. 图表 ----------
console.log('\n[7] 图表');
const items = A.auditChart.barItems;
const daysInMonth = new Date(Date.UTC(...monthKey.split('-').map(Number).map((v, i) => i === 1 ? v : v), 0)).getUTCDate();
check('柱状图槽位 = 整月天数', items.length === daysInMonth, `${items.length} vs ${daysInMonth}`);
check('x 轴标签是日期数字', items[0].label === '1');
const todaySlot = items[Number(todayKey.slice(8)) - 1];
check('今天那根=当天支出合计（不含入账）', todaySlot.value === EXP_TOTAL, `${todaySlot.value} vs ${EXP_TOTAL}`);
const lastBar = A.auditChart.barLayout[A.auditChart.barLayout.length - 1];
check('柱宽有上限（≤34px）', lastBar.w <= 34, String(lastBar.w));
check('最后一根柱子不压刻度区', lastBar.x + lastBar.w <= 400 - 44 + 0.5, String(lastBar.x + lastBar.w));
const barLog = $('auditBarCanvas').ctxLog;
check('y 轴刻度右对齐到 W-2', barLog.filter(c => c[0] === 'fillText' && Math.round(c[2]) === 398).length >= 4);
check('饼图图例带金额与占比', $('auditPieLegend').innerHTML.includes(`¥${A.auditYuan(EXP_TOTAL)}`) && /%/.test($('auditPieLegend').innerHTML), $('auditPieLegend').innerHTML.slice(0, 120));
A.auditSetPieMode('day');
await sleep(900);
check('饼图切到按日', $('auditPieCenter').innerHTML.includes(`¥${A.auditYuan(EXP_TOTAL)}`), $('auditPieCenter').innerHTML);
A.auditSetPieMode('month');

// ---------- 8. 删除（两段确认） + 清理 ----------
console.log('\n[8] 删除与清理');
await A.auditRefresh(true);
await sleep(900);
const target = A.auditState.items.find(i => i.note === `T-早餐-${stamp}`);
check('列表里能找到测试记录', !!target);
if (target) {
  A.auditDelete(target.id, { stopPropagation() {} });
  check('第一次点击进入确认态', /再点一次/.test($('auditMsg').textContent), $('auditMsg').textContent);
  A.auditDelete(target.id, { stopPropagation() {} });
  await sleep(1000);
  check('第二次点击真删除', !$('auditLedger').innerHTML.includes(`T-早餐-${stamp}`));
}
for (const id of cleanupIds) await api('/api/audit/transactions/' + id, { method: 'DELETE' });
for (const it of [...A.auditState.items]) {
  A.auditDelete(it.id, { stopPropagation() {} }); A.auditDelete(it.id, { stopPropagation() {} });
  await sleep(400);
}
const after = await api('/api/audit/transactions?limit=200');
check('测试数据已清理', after.json.total === 0, String(after.json.total));
A.closeAudit();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
