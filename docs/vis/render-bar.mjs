// 用法（在仓库根）：node docs/vis/render-bar.mjs
//   DS=two|one|spread|full|all|past|pastsparse   W=880 H=168 OUT=/path.png
// 把 index.html 里 auditDrawBar 的真实绘制指令回放成 PNG，无需浏览器
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Raster, makeCtx2D } from './raster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const s0 = html.indexOf('// ===== Audit (记账) =====');
const s1 = html.indexOf('// ===== D.O. Dashboard =====');
const auditJs = html.slice(s0, s1);
const frb = html.match(/function fillRoundBar\(ctx[\s\S]*?\n\}/)[0];

const W = +(process.env.W || 880), H = +(process.env.H || 168);
const raster = new Raster(W, H, 2);
raster.paintBg(process.env.BG || '#232323');
const ctx = makeCtx2D(raster);

class El {
  constructor(id) { this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.className = ''; this.style = {}; this.classList = { s: new Set(), add(){}, remove(){}, contains(){return false;}, toggle(){} }; this.clientWidth = W; this.clientHeight = H; this.offsetTop = 0; this.offsetWidth = W; this.offsetHeight = H; }
  addEventListener() {} focus() {} closest() { return null; } getBoundingClientRect() { return { left: 0, top: 0, width: W, height: H }; }
  get parentElement() { return this; }
  getContext() { return ctx; }
  set width(v) {} set height(v) {}
}
const els = new Map();
globalThis.document = { getElementById: id => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
globalThis.window = globalThis; globalThis.devicePixelRatio = 1; globalThis.addEventListener = () => {};
globalThis.escapeHtml = x => x; globalThis.closeSidebar = () => {};
globalThis.fetch = () => Promise.reject(new Error('no fetch in render'));

const A = new Function(auditJs + '\n' + frb + `
  return { auditState, auditDrawBar, auditBarItems, auditYAxis, auditYuanShort, auditDayKeyOf, auditCurrentMonthKey, auditFmtDay, auditYuan };
`)();

const monthKey = A.auditCurrentMonthKey();
const dayKey = A.auditDayKeyOf(Date.now());
const todayDay = Number(dayKey.slice(8));
const [yy, mm] = monthKey.split('-').map(Number);
const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();

function mkDaily(map) {
  return Object.entries(map).map(([d, c]) => ({ date: `${monthSel || monthKey}-${String(d).padStart(2,'0')}`, total_cents: c, total: c/100, count: 1 }));
}

const DATASET = process.env.DS || 'two';
let daily = {}, monthly = [], monthSel = monthKey;
if (DATASET === 'two') {
  daily = { 1: 6230, 2: 990 };
} else if (DATASET === 'spread') {
  for (let d = 1; d <= Math.min(todayDay, daysInMonth); d++) if (d % 2 === 1) daily[d] = 1200 + (d * 733) % 9000;
} else if (DATASET === 'full') {
  for (let d = 1; d <= Math.min(todayDay, daysInMonth); d++) daily[d] = 500 + (d * 1337) % 12000;
} else if (DATASET === 'all') {
  monthSel = '';
  monthly = [
    { month: '2026-09', total_cents: 8880, total: 88.8, count: 1 },
    { month: '2026-10', total_cents: 41230, total: 412.3, count: 12 },
    { month: '2026-11', total_cents: 7220, total: 72.2, count: 2 },
  ];
} else if (DATASET === 'one') {
  daily = { 1: 7220 };
} else if (DATASET === 'past') {
  monthSel = '2026-10';
  for (let d = 1; d <= 31; d++) if (d % 3 !== 0) daily[d] = 800 + ((d * 977) % 7000);
} else if (DATASET === 'pastsparse') {
  monthSel = '2026-10';
  [2, 7, 15, 23, 28].forEach((d, i) => { daily[d] = 4000 + i * 3500; });
}

A.auditState.month = monthSel;
const sum = { daily: mkDaily(daily), monthly, total_cents: 0, count: 0, by_category: [] };
A.auditState.sum = sum;
A.auditDrawBar(sum);
const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
const out = process.env.OUT || path.join(outDir, `bar-${DATASET}.png`);
raster.toPNG(out);
console.log('wrote', out, `${W}x${H}`, 'items=', A.auditChartItems ? A.auditChartItems.length : '');
