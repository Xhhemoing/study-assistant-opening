/** Inert renderers. All supplied strings enter textContent, never innerHTML. */
import {plotGeometry, niceTicks} from '../core/extended.mjs';
function el(tag,text,attrs={}){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;}
function button(text,fn,attrs={}){const b=el('button',text,{type:'button',...attrs});b.addEventListener('click',fn);return b;}
function svg(tag,attrs={}){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;}
const display=v=>v===null?'[缺失]':String(v);
/** Thousands grouping is display only: the value, export and plain text keep the original number. */
const grouped=v=>{if(typeof v!=='number'||Math.abs(v)<1000)return display(v);const [int,frac]=String(v).split('.');return /e/i.test(int)?String(v):int.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(frac===undefined?'':'.'+frac);};
const short=v=>grouped(Number(v.toPrecision(6)));
/** Clipboard is a user-initiated copy of data already on screen; failure is reported, not hidden. */
async function copyText(text){try{await navigator.clipboard.writeText(text);return true;}catch{return false;}}
function copyButton(label,getText,note,onCopy){
  let epoch=0,fallback=null;
  const control=button(label,async()=>{
    const operation=++epoch,value=getText(),snapshot=typeof value==='string'?{text:value}:value;
    const focusScope=control.getRootNode();
    let ownsFocus=focusScope.activeElement===control;
    const moved=()=>{ownsFocus=false;};
    control.addEventListener('blur',moved,{once:true});
    const ok=await copyText(snapshot.text);
    control.removeEventListener('blur',moved);
    // A late permission decision must not focus a detached or superseded view.
    if(operation!==epoch||!note.isConnected)return;
    ownsFocus=ownsFocus&&focusScope.activeElement===control;
    fallback?.remove();fallback=null;
    note.textContent=ok?'已复制到剪贴板。':ownsFocus
      ?'浏览器未允许写入剪贴板；下方已选中完整内容，可使用 Ctrl / ⌘ + C 手动复制。'
      :'浏览器未允许写入剪贴板；下方提供完整内容快照，可进入手动复制框后使用 Ctrl / ⌘ + A、C 复制。';
    if(!ok){
      fallback=el('div',undefined,{class:'manual-copy screen-data'});
      const field=el('textarea',undefined,{readonly:'',rows:6,spellcheck:'false','aria-label':`${label} · 手动复制完整内容`});
      field.value=snapshot.text;
      fallback.append(el('p','复制内容快照 · 只读；筛选或更新不会改变这里已选中的内容。',{class:'meta'}),field);
      note.parentElement.after(fallback);
      if(ownsFocus){field.focus();field.select();}
    }
    onCopy?.(ok,snapshot);
  });
  control.setAttribute('data-sw-action','copy');
  return control;
}
// Spreadsheet formula injection: text starting with = + - @ is prefixed with ' on export only.
const csvCell=v=>{if(v===null)return '';let s=String(v);if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
function readonlyTable(columns,rows){const wrap=el('div',undefined,{class:'table-wrap',tabindex:0,role:'region','aria-label':'原始数据表'}),t=el('table'),head=el('tr');columns.forEach(c=>head.append(el('th',c,{scope:'col'})));const thead=el('thead');thead.append(head);t.append(thead);const body=el('tbody');for(const row of rows){const tr=el('tr');row.forEach(v=>tr.append(el('td',display(v))));body.append(tr);}t.append(body);wrap.append(t);return wrap;}
function liveSummary(details,label,save){
  const summary=el('summary',label);
  // Native summary activation can follow a host click listener's microtask. Commit the
  // same open-state change synchronously so that immediate host revisions see it.
  summary.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0)return;
    event.preventDefault();details.open=!details.open;save(details.open);
  });
  return summary;
}
export function renderExtended(section,b,state,emit,inline=null){
  const d=b.data;
  if(b.type==='table'){
    const PAGE=200;
    state.query??='';state.sort??=-1;state.direction??=1;state.shown??=PAGE;
    if(state.sortKey===undefined)state.sortKey=d.columns[state.sort]?.key??null;
    state.sort=d.columns.findIndex(c=>c.key===state.sortKey);
    if(state.sort<0){state.sortKey=null;state.direction=1;}
    const numeric=d.columns.map(c=>c.kind==='quantitative');
    const search=el('input',undefined,{type:'search','aria-label':'筛选表格',placeholder:'筛选已提供的数据…',maxlength:200});search.value=state.query;
    const status=el('p','',{class:'meta screen-data',role:'status'}),note=el('span','',{class:'meta','aria-live':'polite'});
    const wrap=el('div',undefined,{class:'table-wrap data-table screen-data',tabindex:0,role:'region','aria-label':'可排序数据表'});
    const table=el('table'),thead=el('thead'),head=el('tr'),tbody=el('tbody'),tfoot=el('tfoot');const headers=[];
    for(const [i,c]of d.columns.entries()){
      const th=el('th',undefined,{scope:'col','aria-sort':state.sort===i?(state.direction===1?'ascending':'descending'):'none',...(numeric[i]?{class:'num'}:{})});
      const control=button(c.label+(c.unit?` [${c.unit}]`:''),()=>{state.direction=state.sortKey===c.key?-state.direction:1;state.sortKey=c.key;state.sort=i;draw();emit('table.sort',{blockId:b.id,column:c.key,direction:state.direction===1?'asc':'desc'});});
      const nodes=inline?.(c.inline??c.label,{blockId:b.id,type:'table',role:'title'});
      if(nodes){control.replaceChildren(...nodes);if(c.unit)control.append(document.createTextNode(` [${c.unit}]`));}
      th.append(control);headers.push(th);head.append(th);
    }
    thead.append(head);table.append(thead,tbody);if(numeric.some(Boolean))table.append(tfoot);wrap.append(table);
    const more=button('显示更多',()=>{state.shown=(state.shown??PAGE)+PAGE;draw();if(more.hidden)wrap.focus({preventScroll:true});},{class:'screen-data'});
    let view=[];
    function draw(){
      // Filter matches the raw value or its grouped display ("1234" and "1,234").
      const q=state.query.toLocaleLowerCase();let rows=d.rows.map((r,i)=>({r,i})).filter(({r})=>r.some((v,c)=>display(v).toLocaleLowerCase().includes(q)||numeric[c]&&grouped(v).toLocaleLowerCase().includes(q)));
      if(state.sort>=0){const col=state.sort;rows.sort((a,b)=>{const x=a.r[col],y=b.r[col];if(x===null||y===null)return x===y?a.i-b.i:x===null?1:-1;const cmp=numeric[col]?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});return cmp*state.direction||a.i-b.i;});}
      view=rows;
      const shown=Math.min(state.shown??PAGE,rows.length);
      const fragment=document.createDocumentFragment();for(const{r,i}of rows.slice(0,shown)){const tr=el('tr');r.forEach((v,c)=>{const source=d.inlineRows?.[i]?.[c];const nodes=v===null||numeric[c]&&source==null?null:inline?.(source??String(v),{blockId:b.id,type:'table',role:'cell'});const td=el('td',undefined,numeric[c]?{class:'num'}:{});if(nodes)td.append(...nodes);else td.textContent=numeric[c]?grouped(v):display(v);tr.append(td);});fragment.append(tr);}tbody.replaceChildren(fragment);
      headers.forEach((th,i)=>th.setAttribute('aria-sort',state.sort===i?(state.direction===1?'ascending':'descending'):'none'));
      // Paging only limits drawn rows; the line always states the match count and the full total.
      status.textContent=(shown<rows.length?`显示 前 ${shown} / ${rows.length<d.rows.length?`匹配 ${rows.length} / `:''}共 ${d.rows.length} 行`:`显示 ${rows.length} / ${d.rows.length} 行`)+' · 仅本地筛选与排序，原始数据未修改。';
      more.hidden=shown>=rows.length;
      if(numeric.some(Boolean)){
        // Summary of the matching rows (not only the drawn page), computed from the shown values only.
        const tr=el('tr');
        d.columns.forEach((c,col)=>{
          if(!numeric[col]){tr.append(el('td',col===0?`统计 · ${rows.length} 行`:''));return;}
          const values=rows.map(x=>x.r[col]).filter(v=>v!==null),missing=rows.length-values.length;
          if(!values.length){tr.append(el('td','—',{class:'num'}));return;}
          let min=Infinity,max=-Infinity,sum=0;for(const v of values){min=Math.min(min,v);max=Math.max(max,v);sum+=v;}
          tr.append(el('td',`均值 ${short(sum/values.length)}\n${short(min)} – ${short(max)}${missing?` · 缺失 ${missing}`:''}`,{class:'num stat',title:'算术平均与范围，只按表中已有数值计算；不代表加权或总体结论。'}));
        });
        tfoot.replaceChildren(tr);
      }
    }
    search.addEventListener('input',()=>{state.query=search.value;state.shown=PAGE;draw();});
    search.addEventListener('change',()=>emit('table.filter',{blockId:b.id,queryLength:state.query.length}));
    const reset=button('恢复原始顺序',()=>{state.query='';state.sort=-1;state.sortKey=null;state.direction=1;state.shown=PAGE;search.value='';draw();emit('table.reset',{blockId:b.id});});
    const toCSV=()=>[d.columns.map(c=>csvCell(c.label+(c.unit?` (${c.unit})`:''))).join(','),...view.map(({r})=>r.map(csvCell).join(','))].join('\r\n');
    const copy=copyButton('复制为 CSV',()=>({text:toCSV(),rows:view.length}),note,(ok,snapshot)=>emit('table.copy',{blockId:b.id,rows:snapshot.rows,copied:ok}));
    const controls=el('div',undefined,{class:'data-controls screen-data'});controls.append(search,reset,copy,note);section.append(controls,status,wrap,more);
    // Build the full filtered snapshot only during printing, keeping screen paging bounded.
    section._swPrint=()=>{
      const print=el('div',undefined,{class:'print-data'}),raw=readonlyTable(d.columns.map(c=>c.label+(c.unit?` [${c.unit}]`:'')),view.map(({r})=>r));
      raw.removeAttribute('tabindex');
      if(tfoot.childNodes.length)raw.querySelector('table').append(tfoot.cloneNode(true));
      print.append(el('p',`打印全部匹配 ${view.length} / ${d.rows.length} 行 · 保持当前排序；原始数据未修改。`,{class:'meta'}),raw);section.append(print);
      return ()=>print.remove();
    };
    draw();return true;
  }
  if(b.type==='json'){
    state.jsonOpen??=new Map();
    const paths=new Set(),tree=(value,label,path)=>{
      if(value===null||typeof value!=='object'){
        const row=el('div',undefined,{class:'json-scalar'});row.append(`${label}: `,el('span',JSON.stringify(value),{class:`json-${value===null?'null':typeof value}`}));return row;
      }
      const key=JSON.stringify(path),det=el('details',undefined,{class:'json-node'});paths.add(key);
      det.open=state.jsonOpen.get(key)??path.length===0;
      det.dataset.jsonPath=key;
      det.addEventListener('toggle',()=>{if(det.isConnected)state.jsonOpen.set(key,det.open);});
      const entries=Object.entries(value),array=Array.isArray(value);det.append(liveSummary(det,`${label} · ${array?'数组':'对象'} (${entries.length})`,open=>state.jsonOpen.set(key,open)));
      const children=el('div',undefined,{class:'json-children'});
      for(const[k,v]of entries)children.append(tree(v,array?`[${k}]`:k,[...path,k]));det.append(children);return det;
    };
    // Validator bounds JSON nodes and depth; no hidden remote expansion or arbitrary evaluation.
    const root=tree(d.value,'root',[]),note=el('span','',{class:'meta','aria-live':'polite'});root.classList.add('screen-data');
    for(const key of state.jsonOpen.keys())if(!paths.has(key))state.jsonOpen.delete(key);
    const setAll=open=>{for(const x of section.querySelectorAll('details.json-node')){x.open=open||x===root;state.jsonOpen.set(x.dataset.jsonPath,x.open);}};
    const controls=el('div',undefined,{class:'data-controls screen-data'});
    controls.append(button('全部展开',()=>setAll(true)),button('全部折叠',()=>setAll(false)),copyButton('复制 JSON',()=>JSON.stringify(d.value,null,2),note),note);
    section.append(controls,root,el('p','只读数据 · 展开/折叠不会调用模型。',{class:'meta'}));
    // `toggle` is queued: snapshot live properties before a producer revision replaces
    // this section, including toggles made in the same task as that revision.
    section._swCaptureState=()=>{for(const node of section.querySelectorAll('details.json-node'))state.jsonOpen.set(node.dataset.jsonPath,node.open);};
    section._swPrint=()=>{const print=el('pre',JSON.stringify(d.value,null,2),{class:'print-data print-json'});section.append(print);return ()=>print.remove();};
    return true;
  }
  if(b.type==='diff'){
    // Line numbers come from hunk headers; the gutter is aria-hidden and not selectable.
    let oldNo=null,newNo=null,oldLeft=0,newLeft=0,added=0,removed=0,files=0;
    const lines=d.patch.split('\n'),rows=[];
    for(const line of lines){
      let kind='context',left='',right='';
      if(line.startsWith('@@')){kind='hunk';const m=line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);oldNo=m?Number(m[1]):null;newNo=m?Number(m[3]):null;oldLeft=m?Number(m[2]??1):0;newLeft=m?Number(m[4]??1):0;}
      else if((oldLeft>0||newLeft>0)&&line.startsWith('+')){kind='added';added++;if(newLeft>0){right=String(newNo++);newLeft--;}}
      else if((oldLeft>0||newLeft>0)&&line.startsWith('-')){kind='removed';removed++;if(oldLeft>0){left=String(oldNo++);oldLeft--;}}
      else if((oldLeft>0||newLeft>0)&&line.startsWith(' ')){if(oldLeft>0){left=String(oldNo++);oldLeft--;}if(newLeft>0){right=String(newNo++);newLeft--;}}
      else if(/^(?:diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (?:from|to) )/.test(line)){kind='file';if(line.startsWith('+++ '))files++;oldNo=null;newNo=null;oldLeft=0;newLeft=0;}
      else if(line.startsWith('+')){kind='added';added++;}
      else if(line.startsWith('-')){kind='removed';removed++;}
      rows.push({line,kind,left,right});
    }
    const width=Math.max(1,...rows.map(r=>Math.max(r.left.length,r.right.length)));
    const pre=el('pre',undefined,{class:'diff-view','aria-label':'只读代码差异'});
    const code=el('code');for(const r of rows){code.append(el('span',`${r.left.padStart(width)} ${r.right.padStart(width)} `,{class:'diff-ln','aria-hidden':'true'}),el('span',r.line+'\n',{'data-diff':r.kind}));}pre.append(code);
    const note=el('span','',{class:'meta','aria-live':'polite'}),controls=el('div',undefined,{class:'data-controls screen-data'});
    controls.append(el('span',`${files||1} 个文件 · +${added} / −${removed} 行`,{class:'diff-stat'}),copyButton('复制补丁',()=>d.patch,note),note);
    section.append(controls,pre,el('p','仅展示补丁；未修改文件、运行命令或验证执行成功。',{class:'meta'}));return true;
  }
  if(b.type==='details'){
    state.expanded??={};d.items.forEach((item,i)=>{const det=el('details');det.open=!!state.expanded[i];det.append(el('summary',item.summary),el('p',item.body,{class:'body-copy'}));det.addEventListener('toggle',()=>{state.expanded[i]=det.open;});section.append(det);});return true;
  }
  if(b.type==='plot'){
    const g=plotGeometry(d),ticks=niceTicks(g.ymin,g.ymax,5);
    // Reserve enough room for exact endpoint values and grouped ticks. Geometry's public
    // coordinates stay unchanged; only this view's horizontal positions are remapped.
    const yLabels=[String(g.ymin),String(g.ymax),...ticks.map(short)];
    const leftPad=Math.max(g.pad,20+Math.max(...yLabels.map(s=>s.length))*7.5),rightPad=g.pad;
    const xPos=v=>leftPad+(v-g.xmin)/(g.xmax-g.xmin||1)*(g.w-leftPad-rightPad);
    for(const p of g.points)p.px=leftPad+(p.px-g.pad)/(g.w-2*g.pad)*(g.w-leftPad-rightPad);
    const figure=el('figure'),chart=svg('svg',{viewBox:`0 0 ${g.w} ${g.h}`,role:'img','aria-label':`${d.kind==='line'?'折线':'散点'}图：${d.xLabel}，${d.yLabel}（${d.yUnit}），${d.points.length} 个原始点`,class:'data-plot'});
    const title=svg('title');title.textContent=`${d.xLabel} / ${d.yLabel} [${d.yUnit}]`;chart.append(title);
    const tick=(x,y,txt,anchor)=>{const t=svg('text',{x,y,'text-anchor':anchor,class:'plot-tick'});t.textContent=txt;chart.append(t);};
    const yPos=v=>g.h-g.pad-(v-g.ymin)/(g.ymax-g.ymin||1)*(g.h-2*g.pad);
    // Gridlines at round values inside the true data range; the exact min/max labels stay as before.
    for(const v of ticks){const y=yPos(v);if(Math.abs(y-g.pad)<14||Math.abs(y-(g.h-g.pad))<14)continue;chart.append(svg('line',{x1:leftPad,y1:y,x2:g.w-rightPad,y2:y,class:'plot-grid'}));tick(leftPad-8,y+4,short(v),'end');}
    for(const y of[g.pad,g.h-g.pad,g.zeroY])chart.append(svg('line',{x1:leftPad,y1:y,x2:g.w-rightPad,y2:y,class:'plot-axis'}));
    chart.append(svg('line',{x1:leftPad,y1:g.pad,x2:leftPad,y2:g.h-g.pad,class:'plot-axis'}));
    const left=g.points.reduce((a,b)=>a.px<=b.px?a:b),right=g.points.reduce((a,b)=>a.px>=b.px?a:b);
    const xTicks=d.xKind==='quantitative'?niceTicks(g.xmin,g.xmax,5).map(v=>({px:xPos(v),text:short(v)})):g.points.filter((p,i,all)=>i%Math.ceil(all.length/6)===0).map(p=>({px:p.px,text:String(p.x)}));
    for(const t of xTicks)if(t.px-left.px>40&&right.px-t.px>40)tick(t.px,g.h-g.pad+16,t.text.length>12?t.text.slice(0,12)+'…':t.text,'middle');
    if(d.kind==='line')for(const segment of g.segments)if(segment.length>1)chart.append(svg('polyline',{points:segment.map(p=>`${p.px},${p.py}`).join(' '),class:'plot-line',fill:'none'}));
    for(const p of g.points)if(p.py!==null){const point=svg('circle',{cx:p.px,cy:p.py,r:4,class:'plot-point'});const t=svg('title');t.textContent=`${p.x}: ${p.y} ${d.yUnit}`;point.append(t);chart.append(point);}
    const label=(x,y,txt,anchor='start')=>{const t=svg('text',{x,y,'text-anchor':anchor,class:'plot-label'});t.textContent=txt;chart.append(t);};
    label(leftPad-8,g.pad+4,String(g.ymax),'end');label(leftPad-8,g.h-g.pad+4,String(g.ymin),'end');
    label(leftPad,g.h-15,String(left.x));label(g.w-rightPad,g.h-15,String(right.x),'end');
    figure.append(chart,el('figcaption',`${d.xLabel} → ${d.yLabel} [${d.yUnit}] · ${d.note}`));
    // Plain-language summary of the supplied points only; no fit, forecast or causal reading.
    const known=d.points.filter(p=>p.y!==null),lo=known.reduce((a,b)=>b.y<a.y?b:a),hi=known.reduce((a,b)=>b.y>a.y?b:a);
    const first=known[0],last=known.at(-1),missing=d.points.length-known.length;
    const parts=[`${d.points.length} 个点${missing?`（缺失 ${missing}）`:''}`,`最小 ${grouped(lo.y)} ${d.yUnit}（${lo.x}）`,`最大 ${grouped(hi.y)} ${d.yUnit}（${hi.x}）`];
    if(d.kind==='line'&&known.length>1){const delta=last.y-first.y;parts.push(`首末差 ${delta>0?'+':''}${short(delta)} ${d.yUnit}（${first.x} → ${last.x}）`);}
    const summary=el('p',parts.join(' · '),{class:'meta plot-summary'});
    const raw=el('details');raw.open=!!state.plotRawOpen;
    raw.addEventListener('toggle',()=>{if(raw.isConnected)state.plotRawOpen=raw.open;});
    section._swCaptureState=()=>{state.plotRawOpen=raw.open;};
    raw.append(liveSummary(raw,'查看全部原始数据（含缺失值）',open=>{state.plotRawOpen=open;}),readonlyTable([d.xLabel,`${d.yLabel} [${d.yUnit}]`],d.points.map(p=>[p.x,p.y])));section.append(figure,summary,raw);return true;
  }
  return false;
}
