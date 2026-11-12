// 迷你 canvas 2D 光栅器：只支持 auditDrawBar 用到的指令，输出 PNG（无第三方依赖）
import zlib from 'node:zlib';
import fs from 'node:fs';

const HEX = {};
function parseColor(c) {
  if (typeof c !== 'string') return [255, 0, 255];
  if (c[0] === '#') {
    if (HEX[c]) return HEX[c];
    const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1);
    const v = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    HEX[c] = v; return v;
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255];
}

// 3x5 点阵，够画数字/k/./:
const FONT = {
  '0':['111','101','101','101','111'], '1':['010','110','010','010','111'],
  '2':['111','001','111','100','111'], '3':['111','001','111','001','111'],
  '4':['101','101','111','001','001'], '5':['111','100','111','001','111'],
  '6':['111','100','111','101','111'], '7':['111','001','001','001','001'],
  '8':['111','101','111','101','111'], '9':['111','101','111','001','111'],
  '.':['000','000','000','000','010'], ':':['000','010','000','010','000'],
  'k':['100','101','110','101','101'], '¥':['101','010','111','010','010'],
  '-':['000','000','111','000','000'], ' ':['000','000','000','000','000'],
};

export class Raster {
  constructor(W, H, ss = 2) {
    this.ss = ss; this.W = W * ss; this.H = H * ss;
    this.buf = new Float32Array(this.W * this.H * 3).fill(0);
  }
  paintBg(hex) {
    const [r, g, b] = parseColor(hex);
    for (let i = 0; i < this.W * this.H; i++) { this.buf[i*3] = r; this.buf[i*3+1] = g; this.buf[i*3+2] = b; }
  }
  set(x, y, col) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 3, a = col[3] ?? 1;
    this.buf[i]   = this.buf[i]   * (1 - a) + col[0] * a;
    this.buf[i+1] = this.buf[i+1] * (1 - a) + col[1] * a;
    this.buf[i+2] = this.buf[i+2] * (1 - a) + col[2] * a;
  }
  // 多边形填充（even-odd 扫描线），pts 为 CSS 像素
  fillPolys(polys, paint) {
    const s = this.ss;
    const all = [];
    let minY = Infinity, maxY = -Infinity;
    for (const poly of polys) for (const p of poly) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    if (!polys.length) return;
    const y0 = Math.max(0, Math.floor(minY * s)), y1 = Math.min(this.H - 1, Math.ceil(maxY * s));
    for (let py = y0; py <= y1; py++) {
      const cy = (py + 0.5) / s;
      const xs = [];
      for (const poly of polys) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) {
            xs.push(a[0] + (cy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.round(xs[k] * s), xb = Math.round(xs[k+1] * s);
        for (let px = xa; px < xb; px++) this.set(px, py, paint(cy));
      }
    }
  }
  strokeLineSegments(segs, color, width) {
    const s = this.ss, w = Math.max(width, 0.6) * s;
    for (const [a, b] of segs) {
      const bx0 = Math.floor((Math.min(a[0], b[0]) - w) * s), bx1 = Math.ceil((Math.max(a[0], b[0]) + w) * s);
      const by0 = Math.floor((Math.min(a[1], b[1]) - w) * s), by1 = Math.ceil((Math.max(a[1], b[1]) + w) * s);
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx*dx + dy*dy || 1e-9;
      for (let py = Math.max(0, by0); py <= Math.min(this.H - 1, by1); py++) {
        for (let px = Math.max(0, bx0); px <= Math.min(this.W - 1, bx1); px++) {
          const cx = (px + 0.5) / s, cy = (py + 0.5) / s;
          let t = ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const ex = a[0] + t * dx - cx, ey = a[1] + t * dy - cy;
          if (ex*ex + ey*ey <= (w/2) * (w/2)) this.set(px, py, color);
        }
      }
    }
  }
  drawText(text, x, y, size, color, align, baseline) {
    const s = this.ss;
    const chW = size * 0.6, totalW = chW * String(text).length;
    let startX = x;
    if (align === 'right') startX = x - totalW;
    else if (align === 'center') startX = x - totalW / 2;
    let startY = y;
    if (baseline === 'middle') startY = y - size / 2;
    else if (baseline === 'top') startY = y;
    else startY = y - size;
    const px = size / 5;
    for (let ci = 0; ci < String(text).length; ci++) {
      const glyph = FONT[String(text)[ci]] || FONT[' '];
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        const rx = (startX + ci * chW + gx * px * 0.62), ry = startY + gy * px;
        const x0 = Math.round(rx * s), x1 = Math.round((rx + px * 0.62) * s);
        const y0 = Math.round(ry * s), y1 = Math.round((ry + px) * s);
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, color);
      }
    }
  }
  toPNG(path) {
    const s = this.ss, W = this.W / s, H = this.H / s;
    const out = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
        const i = ((y * s + sy) * this.W + (x * s + sx)) * 3;
        r += this.buf[i]; g += this.buf[i+1]; b += this.buf[i+2];
      }
      const n = s * s, o = (y * W + x) * 3;
      out[o] = Math.round(r / n); out[o+1] = Math.round(g / n); out[o+2] = Math.round(b / n);
    }
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W * 3 + 1)] = 0;
      out.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const crcTable = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
      return t;
    })();
    const crc32 = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeFileSync(path, Buffer.concat([
      Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
    ]));
    return { W, H };
  }
}

// 一个把 canvas 调用录下来并画到 Raster 上的假 ctx
export function makeCtx2D(raster) {
  let path = [], polys = [], cur = null;
  const segs = [];
  const st = {
    fillStyle: '#fff', strokeStyle: '#fff', lineWidth: 1, font: '10px monospace',
    textAlign: 'left', textBaseline: 'alphabetic', _grad: null,
  };
  const gradColor = (grad, cy) => {
    // 竖向线性渐变取近似色
    const { y0, y1, stops, x } = grad;
    const pts = stops.length ? stops : [];
    const t = Math.max(0, Math.min(1, (cy - y0) / ((y1 - y0) || 1)));
    if (!pts.length) return [255, 0, 255];
    let a = pts[0], b = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) if (t >= pts[i].o && t <= pts[i+1].o) { a = pts[i]; b = pts[i+1]; }
    const k = (t - a.o) / ((b.o - a.o) || 1);
    return [a.c[0] + (b.c[0]-a.c[0])*k, a.c[1] + (b.c[1]-a.c[1])*k, a.c[2] + (b.c[2]-a.c[2])*k];
  };
  const ctx = {
    get fillStyle() { return st.fillStyle; },
    set fillStyle(v) { st.fillStyle = v; st._grad = (v && v.addColorStop) ? v : null; },
    get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = v; },
    get lineWidth() { return st.lineWidth; }, set lineWidth(v) { st.lineWidth = v; },
    get font() { return st.font; }, set font(v) { st.font = v; },
    get textAlign() { return st.textAlign; }, set textAlign(v) { st.textAlign = v; },
    get textBaseline() { return st.textBaseline; }, set textBaseline(v) { st.textBaseline = v; },
    setTransform() {}, scale() {}, save() {}, restore() {}, translate() {},
    clearRect(x, y, w, h) { raster.fillPolys([[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]], () => [35,35,35]); },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { y0, y1, stops: [], addColorStop(o, c) { g.stops.push({ o, c: parseColor(c) }); g.stops.sort((a,b)=>a.o-b.o); } };
      return g;
    },
    beginPath() { path = []; cur = null; polys = []; },
    moveTo(x, y) { cur = [[x, y]]; path.push(cur); },
    lineTo(x, y) { if (!cur) { cur = [[x,y]]; path.push(cur); } else cur.push([x, y]); },
    quadraticCurveTo(cx, cy, x, y) {
      const p0 = cur[cur.length - 1];
      for (let i = 1; i <= 10; i++) {
        const t = i / 10, mt = 1 - t;
        cur.push([mt*mt*p0[0] + 2*mt*t*cx + t*t*x, mt*mt*p0[1] + 2*mt*t*cy + t*t*y]);
      }
    },
    closePath() { if (cur && cur.length) cur.push([...cur[0]]); },
    arc() {},
    fill() {
      const g = st._grad;
      const paint = g ? (cy) => gradColor(g, cy) : ((() => { const c = parseColor(st.fillStyle); return () => c; })());
      raster.fillPolys(path.map(p => p), paint);
      path = []; cur = null;
    },
    stroke() {
      const color = parseColor(st.strokeStyle), w = st.lineWidth;
      const all = [];
      for (const p of path) for (let i = 0; i < p.length - 1; i++) all.push([p[i], p[i+1]]);
      raster.strokeLineSegments(all, color, w);
      path = []; cur = null;
    },
    fillRect(x, y, w, h) {
      const c = parseColor(st.fillStyle);
      raster.fillPolys([[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]], () => c);
    },
    fillText(text, x, y) {
      const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(st.font) || [0, 10])[1]);
      raster.drawText(text, x, y, size, parseColor(st.fillStyle), st.textAlign, st.textBaseline);
    },
    measureText(s) { return { width: String(s).length * 6 }; },
  };
  return ctx;
}
