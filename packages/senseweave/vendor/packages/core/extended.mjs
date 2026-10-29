/** Bounded, inert data types. No HTML, remote resources, eval, plugins or action execution. */
function need(ok, message) { if (!ok) throw Object.assign(new Error(message), {code:'EXTENDED'}); }
function text(x, n=2000) {need(typeof x==='string' && x.length<=n, 'Text budget/type invalid'); return x;}
function arr(x,n,min=0) {need(Array.isArray(x)&&x.length<=n&&x.length>=min,'Array budget/type invalid');return x;}
function rec(x) {need(x && typeof x==='object'&&!Array.isArray(x),'Expected object');return x;}
function num(x) {need(typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=1e9,'Invalid number');return x;}
function scalar(x) {need(x===null||['string','number','boolean'].includes(typeof x),'Only scalar table cells');if(typeof x==='number')num(x);if(typeof x==='string')text(x);return x;}
export const MAX_TABLE_ROWS=2000;
export const EXTENDED_CATALOG=Object.freeze({table:'可检索、排序的原始数据表',plot:'有语义和单位的折线/散点图',json:'只读结构化数据树',diff:'只读统一差异（不会应用补丁）',details:'按需展开的补充内容',derivation:'逐行板书推导（只展示原文已有的推导行，可能含答案）'});
export function normalizeExtended(type,d) {
  if(type==='table') {
    const seen=new Set();
    const columns=arr(d.columns,12,1).map(c=>{rec(c);const key=text(c.key,80);need(key&&!seen.has(key)&&!['__proto__','constructor','prototype'].includes(key),'Invalid column key');seen.add(key);const kind=c.kind??'nominal';need(['nominal','ordinal','quantitative','temporal'].includes(kind),'Invalid measurement kind');return {key,label:text(c.label??key,100),kind,...(c.unit===undefined?{}:{unit:text(c.unit,50)})};});
    const rows=arr(d.rows,MAX_TABLE_ROWS,1).map(r=>arr(r,columns.length,columns.length).map((v,i)=>{scalar(v);if(v!==null&&columns[i].kind==='quantitative')num(v);if(v!==null&&columns[i].kind==='temporal')need(typeof v==='string'&&validISODate(v),'Use explicit ISO dates');return v;}));
    columns.forEach((c,i)=>{if(d.columns[i].inline!==undefined)c.inline=text(d.columns[i].inline,2000);});
    const inlineRows=d.inlineRows===undefined?undefined:arr(d.inlineRows,rows.length,rows.length).map(r=>arr(r,columns.length,columns.length).map(v=>v===null?null:text(v,2000)));
    return {columns,rows,...(inlineRows===undefined?{}:{inlineRows})};
  }
  if(type==='plot') {
    need(['line','scatter'].includes(d.kind),'Only line or scatter');
    const unit=text(d.yUnit,50);need(unit.trim()&&unit!=='未声明','Plot needs an explicit measurement unit');
    const xKind=d.xKind??'quantitative';need(['quantitative','temporal','ordinal'].includes(xKind),'Invalid x semantics');
    const points=arr(d.points,200,2).map(p=>{rec(p);const x=xKind==='quantitative'?num(p.x):text(p.x,100);if(xKind==='temporal')need(validISODate(x),'Invalid ISO date');return {x,y:p.y===null?null:num(p.y)};});
    if(d.kind==='line'&&xKind!=='ordinal')for(let i=1;i<points.length;i++)need(xValue(points[i],xKind)>xValue(points[i-1],xKind),'Line x must be strictly increasing; no silent sort');
    if(xKind==='ordinal')need(new Set(points.map(p=>p.x)).size===points.length,'Ordinal labels must be unique');
    need(points.some(p=>p.y!==null),'No finite y values');
    return {kind:d.kind,xKind,xLabel:text(d.xLabel??'x',100),yLabel:text(d.yLabel??'y',100),yUnit:unit,points,note:text(d.note??'线段只连接已提供的数据点，不代表插值、预测或因果。',1000)};
  }
  if(type==='json') {const s=JSON.stringify(d.value);need(s!==undefined&&s.length<=24000,'JSON viewer budget exceeded');return {value:JSON.parse(s)};}
  if(type==='diff') return {patch:text(d.patch,20000)};
  if(type==='derivation') return {lines:arr(d.lines,16,2).map(x=>{rec(x);const line={text:text(x.text,400)};need(line.text.trim(),'Empty derivation line');if(x.note!==undefined)line.note=text(x.note,200);return line;})};
  if(type==='details') return {items:arr(d.items,12,1).map(x=>({summary:text(rec(x).summary,200),body:text(x.body,6000)}))};
  return null;
}
export function validISODate(x) {if(!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(x+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;}
function xValue(p,k) {return k==='temporal'?Date.parse(p.x+'T00:00:00Z'):p.x;}
export function plotGeometry(data) {
  const d=normalizeExtended('plot',data),w=600,h=280,pad=48;
  const xs=d.points.map((p,i)=>d.xKind==='ordinal'?i:xValue(p,d.xKind));
  const ys=d.points.filter(p=>p.y!==null).map(p=>p.y);
  const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(0,...ys),ymax=Math.max(0,...ys);
  const points=d.points.map((p,i)=>({...p,px:pad+(xs[i]-xmin)/(xmax-xmin||1)*(w-2*pad),py:p.y===null?null:h-pad-(p.y-ymin)/(ymax-ymin||1)*(h-2*pad)}));
  const segments=[];let segment=[];
  for(const p of points){if(p.py===null){if(segment.length)segments.push(segment);segment=[];}else segment.push(p);}if(segment.length)segments.push(segment);
  return {w,h,pad,xmin,xmax,ymin,ymax,points,segments,zeroY:h-pad-(0-ymin)/(ymax-ymin||1)*(h-2*pad)};
}
/** Round axis values (1/2/2.5/5 x 10^n) inside [min, max]; used only for gridlines and tick text. */
export function niceTicks(min,max,count=5) {
  if(!Number.isFinite(min)||!Number.isFinite(max)||!(max>min))return [];
  const raw=(max-min)/Math.max(1,count),mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(m=>m*mag).find(x=>x>=raw);
  const out=[];for(let v=Math.ceil(min/step)*step;v<=max+step*1e-9&&out.length<=count+2;v+=step)out.push(Number(v.toPrecision(12)));
  return out;
}
export function extendedText(type,d) {
  if(type==='table')return [d.columns.map(c=>c.label+(c.unit?` [${c.unit}]`:'')).join(' | '),...d.rows.map(r=>r.map(v=>v===null?'[缺失]':String(v)).join(' | '))].join('\n');
  if(type==='plot')return `${d.xLabel} | ${d.yLabel} [${d.yUnit}]\n${d.points.map(p=>`${p.x} | ${p.y===null?'[缺失]':p.y}`).join('\n')}\n${d.note}`;
  if(type==='json')return JSON.stringify(d.value,null,2);
  if(type==='diff')return d.patch;
  if(type==='details')return d.items.map(i=>`${i.summary}\n${i.body}`).join('\n\n');
  if(type==='derivation')return d.lines.map(l=>l.text+(l.note?`（${l.note}）`:'')).join('\n');
  return '';
}
