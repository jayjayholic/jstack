// Tiny static-site kit for /unslop explain and metrify: escaping, one page shell with light and dark tokens, and a
// single-series sparkline. No dependencies, no network: the pages open from disk.
import fs from 'node:fs'
import path from 'node:path'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const CSS = `
:root{--bg:#fbfaf7;--surface:#fff;--ink:#1d1d1b;--ink-2:#55534e;--muted:#8a877f;--line:#e5e2da;--accent:#2f5d8a;--accent-soft:#e4ecf4;--good:#2e7d4f;--warn:#9a6a00;--bad:#b3261e;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--surface:#1e1e1c;--ink:#ecebe7;--ink-2:#b9b6ae;--muted:#86837b;--line:#33322f;--accent:#8db4dc;--accent-soft:#22303d;--good:#6cc08f;--warn:#e0b04a;--bad:#ef8a80;--code:#262624}}
:root[data-theme="dark"]{--bg:#151514;--surface:#1e1e1c;--ink:#ecebe7;--ink-2:#b9b6ae;--muted:#86837b;--line:#33322f;--accent:#8db4dc;--accent-soft:#22303d;--good:#6cc08f;--warn:#e0b04a;--bad:#ef8a80;--code:#262624}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;margin:2em 0 .6em}h3{font-size:1rem;margin:0 0 .4em}
p,li{color:var(--ink-2)}a{color:var(--accent)}.muted{color:var(--muted);font-size:.88rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile b{display:block;font-size:1.5rem;color:var(--ink)}.tile span{color:var(--muted);font-size:.85rem}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:.78rem;color:var(--ink-2);margin-right:4px}
.tag.high{border-color:var(--bad);color:var(--bad)}.tag.ok{border-color:var(--good);color:var(--good)}.tag.warn{border-color:var(--warn);color:var(--warn)}
pre{background:var(--code);border-radius:8px;padding:10px;overflow-x:auto;font-size:.82rem;white-space:pre-wrap;word-break:break-word}code{font-size:.88em}
table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:640px){.grid2{grid-template-columns:1fr}}
details summary{cursor:pointer;color:var(--ink-2)}svg text{fill:var(--muted);font-size:10px}
`

function page({ title, description = '', body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><style>${CSS}</style></head>
<body><main>${body}</main></body></html>
`
}

// One series over time: thin line, 2px, end dot, a <title> per point for hover, no second axis.
function sparkline(points, { width = 280, height = 56, label = '' } = {}) {
  const pts = points.filter(p => Number.isFinite(p.y))
  if (!pts.length) return '<span class="muted">no data yet</span>'
  const max = Math.max(1, ...pts.map(p => p.y))
  const step = pts.length > 1 ? (width - 12) / (pts.length - 1) : 0
  const xy = pts.map((p, i) => [6 + i * step, height - 8 - (p.y / max) * (height - 18)])
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const dots = xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === xy.length - 1 ? 4 : 6}" fill="${i === xy.length - 1 ? 'var(--accent)' : 'transparent'}"><title>${esc(pts[i].x)}: ${pts[i].y}</title></circle>`).join('')
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(label)}"><line x1="0" x2="${width}" y1="${height - 8}" y2="${height - 8}" stroke="var(--line)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>${dots}<text x="${width - 4}" y="10" text-anchor="end">max ${max}</text></svg>`
}

function writeSite(outFile, html) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, html)
  return outFile
}

export { esc, page, sparkline, writeSite }
