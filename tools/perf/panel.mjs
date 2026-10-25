// The panel: one static HTML file built from the store. No Grafana, no server, no network: the data is embedded and
// a small inline script draws the charts. Sections follow the macOS stack's "Process Resources" dashboard (CPU by
// process name with mean/max, memory by process, by app) plus what parallel agents need: per agent/worktree, the
// heavy-lock timeline, top offenders per hour, known waste patterns and the collector's own cost.
import { top, rollup, patterns, spikes } from './lib.mjs'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function series(frames, keyFn, valueIdx, topKeys) {
  const set = new Set(topKeys)
  const out = Object.fromEntries([...topKeys, 'other'].map(k => [k, new Array(frames.length).fill(0)]))
  frames.forEach((f, i) => {
    for (const r of f.g) {
      const k = keyFn(r)
      out[set.has(k) ? k : 'other'][i] += r[valueIdx]
    }
  })
  for (const k of Object.keys(out)) out[k] = out[k].map(v => Math.round(v * 10) / 10)
  return out
}

function lockSegments(frames, labelOf) {
  const segs = []
  const open = new Map()
  for (const f of frames) {
    const seen = new Set()
    for (const l of f.lock ?? []) {
      const key = `${l[0]}|${l[1]}|${l[2]}`
      seen.add(key)
      const s = open.get(key)
      if (s && f.t - s.end <= f.res * 2000) s.end = f.t + f.res * 1000
      else { const n = { slot: l[0], owner: l[1], who: l[2] ? labelOf(l[2]) : '', start: f.t, end: f.t + f.res * 1000 }; open.set(key, n); segs.push(n) }
    }
    for (const k of [...open.keys()]) if (!seen.has(k) && f.t - open.get(k).end > f.res * 2000) open.delete(k)
  }
  return segs
}

function buildPanelData(frames, { labelOf, from, to, ledger = [] }) {
  const span = to - from
  const view = span > 36 * 3600000 ? rollup(frames, span > 10 * 86400000 ? 3600 : 300) : frames
  const byName = top(frames, { by: 'name', labelOf })
  const byAgent = top(frames, { by: 'agent', labelOf })
  const topCpuNames = [...byName].sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 12).map(r => r.key)
  const topMemNames = [...byName].sort((a, b) => b.memMeanMb - a.memMeanMb).slice(0, 12).map(r => r.key)
  const topCpuAgents = [...byAgent].sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 10).map(r => r.key)
  const topMemAgents = [...byAgent].sort((a, b) => b.memMeanMb - a.memMeanMb).slice(0, 10).map(r => r.key)
  const mser = k => view.map(f => f.m[k]?.[0] ?? 0)
  const hours = rollup(frames, 3600).map(h => {
    const t = top([h], { by: 'name', labelOf })
    return {
      t: h.t, cpu: h.m.cpu?.[1] ?? 0, used: h.m.usedPct?.[1] ?? 0,
      cpuTop: [...t].sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 3).map(r => `${r.key} ${r.cpuMean}%`),
      memTop: [...t].sort((a, b) => b.memMaxMb - a.memMaxMb).slice(0, 3).map(r => `${r.key} ${(r.memMaxMb / 1024).toFixed(1)} GB`),
    }
  })
  const notable = new Map()
  for (const f of frames) for (const p of f.p ?? []) {
    const k = `${p[0]}|${p[1]}`
    const a = notable.get(k) ?? { pid: p[0], name: p[1], kind: p[2], who: labelOf(p[3]), cpuMax: 0, memMax: 0, ticks: 0, cmd: p[7] }
    a.cpuMax = Math.max(a.cpuMax, p[4]); a.memMax = Math.max(a.memMax, p[5]); a.ticks++
    notable.set(k, a)
  }
  const selfTicks = frames.map(f => f.self).filter(Boolean)
  const avg = k => selfTicks.length ? Math.round(selfTicks.reduce((s, x) => s + (x[k] ?? 0), 0) / selfTicks.length * 100) / 100 : null
  const max = k => selfTicks.length ? Math.max(...selfTicks.map(x => x[k] ?? 0)) : null
  const cores = frames[frames.length - 1]?.m.cores?.[0] ?? 1
  return {
    from, to, cores, ticks: frames.length,
    t: view.map(f => f.t),
    machine: { cpu: mser('cpu'), used: mser('usedPct'), commit: mser('commitMb'), commitLimit: mser('commitLimitMb'), cache: mser('cacheMb'), dq: mser('dq'), disk: mser('diskBusy'), unacc: mser('unacc') },
    cpuByName: series(view, r => r[0], 3, topCpuNames),
    memByName: series(view, r => r[0], 5, topMemNames),
    cpuByAgent: series(view, r => labelOf(r[2]), 3, topCpuAgents),
    memByAgent: series(view, r => labelOf(r[2]), 5, topMemAgents),
    tables: { name: byName.sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 40), agent: byAgent.sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 30) },
    locks: lockSegments(frames, labelOf),
    hours,
    notable: [...notable.values()].sort((a, b) => b.cpuMax - a.cpuMax).slice(0, 25),
    patterns: patterns(frames, { labelOf }),
    spikes: spikes(frames, { labelOf }).slice(-15),
    self: { cpuPctOneCore: avg('cpu'), rssMb: avg('rssMb'), privMb: avg('privMb'), snapCpuMs: avg('snapCpuMs'), snapPeakMb: max('snapPeakMb'), tickMs: avg('tickMs'), rssMaxMb: max('rssMb') },
    ledger: ledger.slice(-40),
  }
}

function renderPanel(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Machine performance</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--card:#fff;--hot:#c2410c;
--c0:#2563eb;--c1:#d97706;--c2:#059669;--c3:#db2777;--c4:#7c3aed;--c5:#0891b2;--c6:#65a30d;--c7:#dc2626;--c8:#4f46e5;--c9:#ca8a04;--c10:#0d9488;--c11:#9333ea;--c12:#a8a29e}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececf0;--muted:#9a9aa3;--line:#2a2a30;--card:#18181c;--hot:#fb923c;--c12:#57534e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1280px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.sub{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.stat b{display:block;font-size:20px}.stat span{color:var(--muted);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0;overflow-x:auto}
.two{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px}@media (max-width:900px){.two{grid-template-columns:1fr}}
svg{display:block;width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.tip{position:fixed;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;display:none;max-width:360px;z-index:9;box-shadow:0 4px 16px #0003}
.hot{color:var(--hot);font-weight:600}code{font-size:11.5px;word-break:break-all}.leg td{border:0;padding:2px 4px}
</style></head><body><main>
<h1>Machine performance</h1><div class="sub" id="range"></div>
<div class="grid" id="stats"></div>
<h2>CPU by process name <span class="sub">(100% = one core; mean and max over the window)</span></h2><div class="two"><div class="card" id="cpuName"></div><div class="card" id="cpuNameLeg"></div></div>
<h2>Memory by process name <span class="sub">(private bytes, what each process committed)</span></h2><div class="two"><div class="card" id="memName"></div><div class="card" id="memNameLeg"></div></div>
<h2>CPU by agent / worktree</h2><div class="two"><div class="card" id="cpuAgent"></div><div class="card" id="cpuAgentLeg"></div></div>
<h2>Memory by agent / worktree</h2><div class="two"><div class="card" id="memAgent"></div><div class="card" id="memAgentLeg"></div></div>
<h2>Machine</h2><div class="card" id="machine"></div>
<h2>Heavy-lock slots</h2><div class="card" id="locks"></div>
<h2>Top offenders by hour</h2><div class="card" id="hours"></div>
<h2>Waste patterns and spikes</h2><div class="card" id="patterns"></div>
<h2>Leaderboard by process name</h2><div class="card" id="tblName"></div>
<h2>Leaderboard by agent</h2><div class="card" id="tblAgent"></div>
<h2>Heaviest single processes</h2><div class="card" id="notable"></div>
<h2>Optimize ledger</h2><div class="card" id="ledger"></div>
<div class="tip" id="tip"></div>
<script>
const D=${json};
const C=i=>'var(--c'+(i%13)+')';const $=id=>document.getElementById(id);const tip=$('tip');
const fmtT=t=>new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const gb=mb=>(mb/1024).toFixed(1)+' GB';
function chart(el,ser,unit,opts={}){const W=900,H=opts.h||260,P=44,keys=Object.keys(ser).filter(k=>ser[k].some(v=>v>0));const n=D.t.length;if(!n){$(el).textContent='no data yet';return []}
 const stack=opts.stack!==false;const tot=D.t.map((_,i)=>stack?keys.reduce((s,k)=>s+ser[k][i],0):Math.max(...keys.map(k=>ser[k][i])));let ymax=Math.max(1,...tot)*1.05;if(opts.ymax)ymax=Math.max(ymax,opts.ymax);
 const x=i=>P+(n<2?0:i*(W-P-8)/(n-1)),y=v=>H-22-(v/ymax)*(H-34);let s='<svg viewBox="0 0 '+W+' '+H+'" role="img">';
 for(let g=0;g<=4;g++){const v=ymax*g/4;s+='<line x1="'+P+'" x2="'+(W-8)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)"/><text x="'+(P-6)+'" y="'+(y(v)+4)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+(unit==='mb'?gb(v):Math.round(v)+(unit==='pct'?'%':''))+'</text>'}
 const base=new Array(n).fill(0);keys.forEach((k,ki)=>{const top=ser[k].map((v,i)=>(stack?base[i]:0)+v);let d='M'+x(0)+','+y(top[0]);for(let i=1;i<n;i++)d+='L'+x(i)+','+y(top[i]);
  if(stack){for(let i=n-1;i>=0;i--)d+='L'+x(i)+','+y(base[i]);d+='Z';s+='<path d="'+d+'" fill="'+C(opts.colorOf?opts.colorOf(k):ki)+'" fill-opacity=".72" stroke="'+C(opts.colorOf?opts.colorOf(k):ki)+'" stroke-width=".6"/>';top.forEach((v,i)=>base[i]=v)}
  else s+='<path d="'+d+'" fill="none" stroke="'+C(ki)+'" stroke-width="1.6"/>'});
 const lab=[0,Math.floor(n/2),n-1];lab.forEach(i=>s+='<text x="'+x(i)+'" y="'+(H-6)+'" font-size="11" text-anchor="'+(i===0?'start':i===n-1?'end':'middle')+'" fill="var(--muted)">'+fmtT(D.t[i])+'</text>');
 s+='<rect x="'+P+'" y="0" width="'+(W-P)+'" height="'+H+'" fill="transparent" class="hit"/></svg>';$(el).innerHTML=s;const svg=$(el).querySelector('svg');
 svg.addEventListener('mousemove',ev=>{const r=svg.getBoundingClientRect();const i=Math.max(0,Math.min(n-1,Math.round(((ev.clientX-r.left)*W/r.width-P)/((W-P-8)/Math.max(1,n-1)))));
  const rows=keys.map((k,ki)=>[k,ser[k][i],ki]).filter(r=>r[1]>0).sort((a,b)=>b[1]-a[1]).slice(0,12);tip.innerHTML='<b>'+fmtT(D.t[i])+'</b><br>'+rows.map(r=>'<span class="sw" style="background:'+C(opts.colorOf?opts.colorOf(r[0]):r[2])+'"></span>'+e(r[0])+': '+(unit==='mb'?gb(r[1]):r[1]+(unit==='pct'?'%':''))).join('<br>');
  tip.style.display='block';tip.style.left=Math.min(ev.clientX+14,innerWidth-370)+'px';tip.style.top=(ev.clientY+14)+'px'});svg.addEventListener('mouseleave',()=>tip.style.display='none');return keys}
function legend(el,keys,rows,unit){const by=Object.fromEntries(rows.map(r=>[r.key,r]));let h='<table class="leg"><tr><th></th><th>name</th><th class="n">mean</th><th class="n">max</th></tr>';
 keys.forEach((k,i)=>{const r=by[k];if(!r&&k!=='other')return;const mean=r?(unit==='mb'?gb(r.memMeanMb):r.cpuMean+'%'):'',mx=r?(unit==='mb'?gb(r.memMaxMb):r.cpuMax+'%'):'';h+='<tr><td><span class="sw" style="background:'+C(i)+'"></span></td><td>'+e(k)+(r&&r.top&&r.top.length?'<div class="sub">'+e(r.top.join(', '))+'</div>':'')+'</td><td class="n">'+mean+'</td><td class="n">'+mx+'</td></tr>'});$(el).innerHTML=h+'</table>'}
function table(el,cols,rows){if(!rows.length){$(el).innerHTML='<span class="sub">none</span>';return}$(el).innerHTML='<table><tr>'+cols.map(c=>'<th'+(c[2]?' class="n"':'')+'>'+c[0]+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td'+(c[2]?' class="n"':'')+'>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</table>'}
$('range').textContent=fmtT(D.from)+' to '+fmtT(D.to)+' · '+D.ticks+' ticks · '+D.cores+' logical cores';
const last=k=>D.machine[k][D.machine[k].length-1]??0, mx=k=>Math.max(0,...D.machine[k]);
$('stats').innerHTML=[['CPU now / max',Math.round(last('cpu'))+'% / '+Math.round(mx('cpu'))+'%','of all cores'],['RAM used now / max',Math.round(last('used'))+'% / '+Math.round(mx('used'))+'%',''],['Commit',gb(last('commit'))+' / '+gb(last('commitLimit')),'used / limit'],['File cache',gb(last('cache')),'system cache resident'],['Disk busy max',Math.round(mx('disk'))+'%','queue max '+mx('dq')],['Short-lived CPU',Math.round(D.machine.unacc.reduce((a,b)=>a+b,0)/Math.max(1,D.machine.unacc.length))+'%','mean, one-core units'],['Monitor cost',(D.self.cpuPctOneCore??'?')+'% of a core',(D.self.privMb??'?')+' MB private, '+(D.self.rssMb??'?')+' MB RSS']]
 .map(s=>'<div class="stat"><span>'+s[0]+'</span><b>'+s[1]+'</b><span>'+s[2]+'</span></div>').join('');
legend('cpuNameLeg',chart('cpuName',D.cpuByName,'pct'),D.tables.name,'pct');legend('memNameLeg',chart('memName',D.memByName,'mb'),D.tables.name,'mb');
legend('cpuAgentLeg',chart('cpuAgent',D.cpuByAgent,'pct'),D.tables.agent,'pct');legend('memAgentLeg',chart('memAgent',D.memByAgent,'mb'),D.tables.agent,'mb');
chart('machine',{'CPU % (all cores)':D.machine.cpu,'RAM used %':D.machine.used,'disk busy %':D.machine.disk},'pct',{stack:false,h:200,ymax:100});
(function(){const L=D.locks;if(!L.length){$('locks').innerHTML='<span class="sub">no slot held in this window</span>';return}const slots=[...new Set(L.map(l=>l.slot))];const W=900,P=120,rowH=26,H=slots.length*rowH+24,t0=D.from,t1=D.to,x=t=>P+(t-t0)/(t1-t0)*(W-P-8);
 let s='<svg viewBox="0 0 '+W+' '+H+'">';slots.forEach((sl,i)=>{s+='<text x="0" y="'+(i*rowH+17)+'" font-size="12" fill="var(--muted)">'+e(sl)+'</text>'});
 L.forEach((l,j)=>{const i=slots.indexOf(l.slot);s+='<rect x="'+x(l.start)+'" y="'+(i*rowH+4)+'" width="'+Math.max(2,x(l.end)-x(l.start))+'" height="'+(rowH-8)+'" rx="3" fill="'+C(j)+'"><title>'+e(l.owner+' '+l.who+' '+fmtT(l.start)+' - '+fmtT(l.end))+'</title></rect>'});
 s+='<text x="'+P+'" y="'+(H-4)+'" font-size="11" fill="var(--muted)">'+fmtT(t0)+'</text><text x="'+(W-8)+'" y="'+(H-4)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+fmtT(t1)+'</text></svg>';
 $('locks').innerHTML=s;$('locks').insertAdjacentHTML('beforeend','<table>'+L.slice(-12).map(l=>'<tr><td>'+e(l.slot)+'</td><td>'+e(l.owner)+'</td><td>'+e(l.who)+'</td><td>'+fmtT(l.start)+' - '+fmtT(l.end)+'</td><td class="n">'+Math.round((l.end-l.start)/60000)+' min</td></tr>').join('')+'</table>')})();
table('hours',[['hour',r=>fmtT(r.t)],['CPU max',r=>'<span class="'+(r.cpu>=85?'hot':'')+'">'+Math.round(r.cpu)+'%</span>',1],['RAM max',r=>'<span class="'+(r.used>=90?'hot':'')+'">'+Math.round(r.used)+'%</span>',1],['top CPU (mean, 100% = 1 core)',r=>e(r.cpuTop.join(' · '))],['top memory (peak)',r=>e(r.memTop.join(' · '))]],[...D.hours].reverse());
$('patterns').innerHTML=(D.patterns.length?'<table>'+D.patterns.map(p=>'<tr><td class="hot">'+e(p.pattern)+'</td><td>'+e(p.evidence)+'</td><td>'+e(p.fix)+'</td></tr>').join('')+'</table>':'<span class="sub">no known waste pattern in this window</span>')
 +(D.spikes.length?'<h3 style="font-size:13px">Spikes (CPU 85%+ or RAM 90%+)</h3><table>'+D.spikes.map(s=>'<tr><td>'+fmtT(Date.parse(s.start))+'</td><td class="n">'+s.minutes+' min</td><td class="n">CPU '+s.peakCpu+'%</td><td class="n">RAM '+s.peakUsedPct+'%</td><td>'+e(s.topCpu.map(t=>t.key+' '+t.cpuMean+'%').join(' · '))+'</td></tr>').join('')+'</table>':'');
table('tblName',[['process',r=>e(r.key)],['CPU mean',r=>r.cpuMean+'%',1],['CPU max',r=>r.cpuMax+'%',1],['CPU s',r=>r.cpuSec,1],['RAM mean',r=>gb(r.memMeanMb),1],['RAM max',r=>gb(r.memMaxMb),1],['procs max',r=>r.nMax,1],['mostly from',r=>'<span class="sub">'+e(r.top.join(', '))+'</span>']],D.tables.name);
table('tblAgent',[['agent / worktree',r=>e(r.key)],['CPU mean',r=>r.cpuMean+'%',1],['CPU max',r=>r.cpuMax+'%',1],['RAM mean',r=>gb(r.memMeanMb),1],['RAM max',r=>gb(r.memMaxMb),1],['top processes',r=>'<span class="sub">'+e(r.top.join(', '))+'</span>']],D.tables.agent);
table('notable',[['pid',r=>r.pid,1],['process',r=>e(r.name)+' <span class="sub">'+e(r.kind)+'</span>'],['agent',r=>e(r.who)],['CPU max',r=>r.cpuMax+'%',1],['RAM max',r=>gb(r.memMax),1],['ticks',r=>r.ticks,1],['command (redacted)',r=>'<code>'+e(r.cmd)+'</code>']],D.notable);
table('ledger',[['when',r=>e((r.at||'').slice(0,16))],['consumer',r=>e(r.consumer)],['alternative',r=>e(r.alternative||'')],['numbers',r=>e(r.numbers||'')],['verdict',r=>'<b>'+e(r.verdict)+'</b>'],['why',r=>e(r.why||'')]],[...D.ledger].reverse());
</script></main></body></html>`
}

export { buildPanelData, renderPanel, esc }
