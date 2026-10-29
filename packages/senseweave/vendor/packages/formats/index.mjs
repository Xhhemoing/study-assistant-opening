/** Adapters from explicit data formats to validated IR with declared fidelity.
 * This is intentionally NOT full CommonMark, TeX, Mermaid or a document-file importer.
 */
import {validateDocument, SCHEMA_VERSION, cleanText, ContractError} from '../core/document.mjs';
import {validISODate, MAX_TABLE_ROWS} from '../core/extended.mjs';
import {markdownBlockContext} from '../core/block-context.mjs';
import {tableInlineCells} from './table-inline.mjs';
const FORMATS=['auto','markdown','csv','tsv','json','diff','mermaid','latex'];
// Size checks carry what was measured, so a fallback can name the limit and the real count.
function need(ok,message,measure,limit,actual){
  if(!ok)throw Object.assign(new ContractError('FORMAT',message),measure?{measure,limit,actual}:{});
}
const OVER={rows:(a,l)=>`有 ${a} 行，超过上限 ${l} 行`,columns:(a,l)=>`有 ${a} 列，超过上限 ${l} 列`,cell:(a,l)=>`有单元格长 ${a} 字符，超过上限 ${l} 字符`,nodes:(a,l)=>`有 ${a} 个节点，超过上限 ${l} 个`,edges:(a,l)=>`有 ${a} 条连线，超过上限 ${l} 条`};
function formatFallbackMessage(format,e){
  const label=format==='markdown-table'?'表格':String(format).toUpperCase();
  if(Object.hasOwn(OVER,e?.measure))return `${label} ${OVER[e.measure](e.actual,e.limit)}；已完整保留原文。`;
  if(format==='markdown-table')return '表格不符合受限格式，完整保留 Markdown。';
  return `${format} 未通过受限格式校验，保留原文（${String(e?.code??'PARSE')}）。`;
}
function pushFormatFallback(diagnostics,format,e,start,end){
  const over=Object.hasOwn(OVER,e?.measure)?{measure:e.measure,limit:e.limit,actual:e.actual}:{};
  diagnostics.push({code:e?.code==='UNIT_CONFLICT'?'UNIT_CONFLICT':'FORMAT_FALLBACK',severity:'info',message:formatFallbackMessage(format,e),start,end,...over});
}
// A unit written on every value ("12%", "¥5", "1,234 ms") is as explicit as one in the header.
// Short whitelist only: ambiguous suffixes (m = metre/minute/million, g, k, M, 万) never count.
const PLAIN_NUMBER=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const AFFIXED=/^(\$|¥|￥|€|£)?\s?([+-]?(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?)\s?(%|％|‰|ms|s|秒|分钟|小时|天|次|个|元|美元|kg|km|cm|mm|米|千米|°C|℃|KB|MB|GB|TB|tokens|人)?$/;
const AFFIX_ALIAS={'％':'%','￥':'¥','℃':'°C'};
// Equivalence is explicit; no conversion, guessing or precedence between units.
const UNIT_EQUIVALENTS={'美元':'$','元':'¥'};
const unitKey = x => UNIT_EQUIVALENTS[AFFIX_ALIAS[x]??x]??AFFIX_ALIAS[x]??x;
function affixed(x){
  const m=typeof x==='string'&&x.trim().match(AFFIXED);if(!m)return null;
  if(m[1]&&m[3]&&unitKey(m[1])!==unitKey(m[3]))throw new ContractError('UNIT_CONFLICT','Conflicting prefix and suffix units');
  const affix=m[1]??m[3]??'';return {affix:AFFIX_ALIAS[affix]??affix,value:Number(m[2].replace(/,/g,''))};
}
/** The shared affix of a column, or undefined when any non-empty cell lacks it or differs. */
function valueUnit(values){
  let unit;
  for(const x of values){if(x===null||x==='')continue;const a=affixed(x);if(!a||!a.affix||(unit!==undefined&&a.affix!==unit))return undefined;unit=a.affix;}
  return unit;
}
function cellValue(x,c){
  if(c.kind==='quantitative') {
    if(x===null||x==='')return null;
    let n;
    if(typeof x==='number'||PLAIN_NUMBER.test(x))n=Number(x);
    else {const a=affixed(x);if(a?.affix&&unitKey(a.affix)!==unitKey(c.unit))throw new ContractError('UNIT_CONFLICT','Cell and declared column units conflict');need(a,'Invalid quantitative cell');n=a.value;}
    need(Number.isFinite(n)&&Math.abs(n)<=1e9,'Number range exceeded');return n;
  }
  if(c.kind==='temporal'){if(x===null||x==='')return null;need(typeof x==='string'&&validISODate(x),'Temporal column requires YYYY-MM-DD');}
  return x;
}
/** Quoted delimiters, double-quote escaping, multiline cells, CRLF; no formula execution. */
export function parseDelimited(text,delimiter=',') {
  cleanText(text,60000);need(delimiter===','||delimiter==='\t','Only CSV/TSV');
  const rows=[];let row=[],value='',quoted=false,closed=false;
  // Width and row count are judged on the complete record/table, never at the point parsing
  // would stop, so a diagnostic reports the real size. Input is already capped at 60,000 chars.
  const field=()=>{need(value.length<=2000,'Cell exceeds 2000 chars','cell',2000,value.length);row.push(value);value='';closed=false;};
  const record=()=>{field();need(row.length<=12,'More than 12 columns','columns',12,row.length);rows.push(row);row=[];};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
    if(c===delimiter){field();continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;record();continue;}
    need(!closed,'Unexpected characters after closing quote');
    if(c==='"'){need(!value,'Quote must start a field');quoted=true;}else value+=c;
  }
  need(!quoted,'Unclosed quoted field');if(value||closed||row.length)record();
  need(rows.length>=2,'Expected a header and at least one data row');
  const header=rows.shift();need(rows.length<=MAX_TABLE_ROWS,'More than '+MAX_TABLE_ROWS+' data rows','rows',MAX_TABLE_ROWS,rows.length);
  need(header.every(x=>x.trim())&&new Set(header).size===header.length,'Headers must be unique and nonempty');
  need(rows.every(r=>r.length===header.length),'Ragged table, no silent truncation');return {header,rows};
}
// Explicit sequence labels only (第 3 次, Day 2, 10-18, 10月18日, 周三, Q2). They become ordinal, plotted in
// the order written. Dates are never parsed or given a guessed year, and labels must already be strictly
// increasing, so nothing is silently sorted into a trend. ISO dates still need a declared temporal axis.
const WEEK='一二三四五六日天';
function sequenceRank(x){
  let m=x.match(/^第\s*(\d{1,3})\s*(?:次|周|天|日|章|节|课|轮|单元|期|套|讲)$/)||x.match(/^(?:day|week|lesson|unit|test|quiz|round|session)\s*(\d{1,3})$/i)||x.match(/^q([1-4])$/i);
  if(m)return Number(m[1]);
  m=x.match(/^(\d{1,2})[-/.](\d{1,2})$/)||x.match(/^(\d{1,2})月(\d{1,2})日$/);
  if(m){const mo=Number(m[1]),d=Number(m[2]);return mo>=1&&mo<=12&&d>=1&&d<=31?mo*100+d:null;}
  m=x.match(/^(?:周|星期)([一二三四五六日天])$/);
  return m?Math.min(WEEK.indexOf(m[1]),6)+1:null;
}
/** Integer years in strictly increasing order under a year-like header are an ordered axis, not categories. */
function yearKind(label,values){
  const v=values.filter(x=>x!==null).map(x=>typeof x==='string'&&/^\s*\d{4}\s*$/.test(x)?Number(x):x);
  if(v.length<3||!/(?:年份|年度|^年$|学年|year)/i.test(label)||!v.every(x=>Number.isInteger(x)&&x>=1000&&x<=2999))return null;
  return v.every((x,i)=>i===0||x>v[i-1])?'ordinal':null;
}
function sequenceKind(values){
  const v=values.filter(x=>x!==null);
  if(v.length<3||!v.every(x=>typeof x==='string'))return 'nominal';
  const ranks=v.map(x=>sequenceRank(x.trim()));
  return ranks.every((r,i)=>r!==null&&(i===0||r>ranks[i-1]))?'ordinal':'nominal';
}
function makeTable(header,rows,hints=[],inlineCells=null) {
  need(header.length<=12,'More than 12 columns','columns',12,header.length);need(rows.length<=MAX_TABLE_ROWS,'More than '+MAX_TABLE_ROWS+' data rows','rows',MAX_TABLE_ROWS,rows.length);
  // Check even nominal columns: a contradictory value is never reliable numeric evidence.
  for(const row of rows)for(const cell of row)affixed(cell);
  const columns=header.map((label,i)=>{
    const h=hints.find(x=>x.key===label||x.key===`c${i}`)||{};
    // Host declarations take precedence. A number is not automatically a measurement.
    const knownUnit=label.match(/[（(\[]([^()[\]（）]{1,30})[）)\]]$/)?.[1];
    const declared=h.unit??(knownUnit&&/^(?:ms|s|秒|分钟|小时|天|次|个|元|美元|%|％|‰|kg|g|m|cm|mm|km|米|千米|摄氏度|°C|℃|分|人|bytes|KB|MB|GB|TB|tokens|m\/s|m\/s²|m\/s\^2|m·s⁻¹|m·s⁻²|km\/h|N|kN|J|kJ|W|kW|Pa|kPa|V|mV|A|mA|Ω|Hz|mol|mol\/L|K|L|mL|克|千克|牛|焦|瓦|题|道|页|篇|周|课时|学时)$/i.test(knownUnit)?AFFIX_ALIAS[knownUnit]??knownUnit:undefined);
    const marked=inlineCells?.some(r=>r[i].markup);
    const unit=declared??(!marked&&(h.kind===undefined||h.kind==='quantitative')?valueUnit(rows.map(r=>r[i])):undefined);
    const numeric=rows.every(r=>r[i]===null||typeof r[i]==='number');
    const kind=marked?'nominal':h.kind??(unit?'quantitative':numeric&&!/(?:^id$|编号|代码|年份|year|code)/i.test(label)?'quantitative':yearKind(label,rows.map(r=>r[i]))??sequenceKind(rows.map(r=>r[i])));
    return {key:`c${i}`,label,kind,...(unit?{unit}:{})};
  });
  return {columns,rows:rows.map(r=>r.map((x,i)=>cellValue(x,columns[i]))),...(inlineCells?{inlineRows:inlineCells.map(r=>r.map(c=>c.inline))}:{})};
}
function jsonBlock(text,hints) {
  const value=JSON.parse(text);
  if(Array.isArray(value)&&value.length&&value.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.values(v).every(x=>x===null||['string','number','boolean'].includes(typeof x)))){
    const keys=[...new Set(value.flatMap(v=>Object.keys(v)))];
    if(keys.length) return {_formatLosses:value.some(v=>keys.some(k=>!Object.hasOwn(v,k)))?['JSON 中未提供的字段在表中映射为 null；原始 JSON 保留以区分缺失与显式空值']:[],type:'table',data:makeTable(keys,value.map(v=>keys.map(k=>Object.hasOwn(v,k)?v[k]:null)),hints)};
  }
  return {type:'json',data:{value}};
}
// Recognize unsupported syntax so the whole adapter fails rather than erasing it.
const MERMAID_SHAPES={'[': [']','rect'], '(': [')','round'], '{': ['}','diamond'], '([': ['])','stadium']};
const MERMAID_STYLES={'-->':'solid','-.->':'dashed','==>':'thick'};
const MERMAID_NODE=/^([\p{L}\p{N}_]{1,32})(?:(\(\(\(|\(\[|\[\[|\[\(|\(\(|\{\{|\[\/|\[\\|\[|\(|\{|>)([\s\S]*?)(\)\)\)|\]\)|\]\]|\)\]|\)\)|\}\}|\/\]|\\\]|\]|\)|\}))?$/u;
const MERMAID_TEXT_LINK=/(--|==|-\.)\s*(?![->=.|\s])([^\n]*?)\s*(-{2,}>|={2,}>|\.-+>)/y;
const MERMAID_LINK=/(<?(?:-{2,}|={2,}|-\.+-|~{3,})[>ox]?)(?:\s*\|([^|\n]*)\|)?/y;
const MERMAID_RESERVED=/^(?:end|subgraph|click|style|classDef|class|linkStyle|direction|callback|call|href|accTitle|accDescr)$/;
function mermaidLabel(raw=''){
  let t=raw.trim();if(/^"[\s\S]*"$/.test(t))t=t.slice(1,-1);
  need(!t.includes('`'),'Unsupported Mermaid node syntax');
  // Mermaid resolves #decimal;/#name; and HTML entities before rendering; our
  // plain-label IR cannot carry that syntax without changing its meaning.
  need(!/(?:#(?:[0-9]+|x[0-9a-f]+|[a-z][a-z0-9]*);|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/i.test(t),'Encoded Mermaid labels require the original renderer');
  t=t.replace(/<br\s*\/?>/gi,' ').replace(/\s+/g,' ').trim();
  need(t.length<=80,'Mermaid label exceeds 80 chars');return t;
}
/** Split on `sep` outside brackets and quotes. */
function splitTop(text,sep){
  const out=[];let depth=0,quote=false,start=0;
  for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c==='"')quote=false;continue;}if(c==='"')quote=true;else if('[({'.includes(c))depth++;else if(')]}'.includes(c))depth=Math.max(0,depth-1);else if(c===sep&&!depth){out.push(text.slice(start,i));start=i+1;}}
  out.push(text.slice(start));return out;
}
/** Auditable flowchart subset: five directions, four shapes, three arrow styles,
 * edge labels, chains and `&`. Any unrepresentable shape, direction, line
 * style, directive or metadata fails the whole adapter; nothing is dropped.
 */
export function parseMermaid(text) {
  const statements=[];
  for(const line of text.trim().split(/\r?\n/)){
    const t=line.trim();if(!t)continue;
    if(t.startsWith('%%')){need(!t.startsWith('%%{'),'Mermaid init directives are not supported');need(false,'Mermaid comments are not supported');}
    statements.push(...splitTop(t,';').map(s=>s.trim()).filter(Boolean));
  }
  const header=(statements.shift()??'').match(/^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?$/);
  need(header,'Only default/TD/TB Mermaid direction is representable');
  const labels=new Map(),shapes=new Map(),raw=[];
  const node=src=>{
    const t=src.trim();need(!t.includes(':::')&&!t.includes('@{'),'Mermaid classes and shape metadata are not supported');
    const m=t.match(MERMAID_NODE);need(m&&!MERMAID_RESERVED.test(m[1]),'Unsupported Mermaid node syntax');
    if(m[2]!==undefined){
      const shape=MERMAID_SHAPES[m[2]];
      need(shape&&shape[0]===m[4],'Only rectangular Mermaid nodes are representable');
      need(!/[\[\]{}()<>]/.test(m[3]),'Unsupported Mermaid node syntax');
      need(!shapes.has(m[1])||shapes.get(m[1])===shape[1],'Conflicting node labels');
      shapes.set(m[1],shape[1]);
      const label=mermaidLabel(m[3]);need(label,'Empty Mermaid node label');
      const old=labels.get(m[1]);need(old===undefined||old===m[1]||old===label,'Conflicting node labels');labels.set(m[1],label);
    } else if(!labels.has(m[1]))labels.set(m[1],m[1]);
    return m[1];
  };
  for(const st of statements){
    need(!MERMAID_RESERVED.test(st.split(/\s/)[0]),'Directives and styling are not supported');
    const groups=[],links=[];let depth=0,quote=false,start=0,i=0;
    while(i<st.length){
      const c=st[i];
      if(quote){if(c==='"')quote=false;i++;continue;}
      if(c==='"'){quote=true;i++;continue;}
      if(!depth&&'-=<~'.includes(c)){
        let m,arrow,label;
        MERMAID_TEXT_LINK.lastIndex=i;
        if((m=MERMAID_TEXT_LINK.exec(st))){need({'--':'-','==':'=','-.':'.'}[m[1]]===m[3][0],'Mismatched Mermaid link');arrow=m[3]==='.->'?'-.->':m[3];label=m[2];}
        else {MERMAID_LINK.lastIndex=i;if((m=MERMAID_LINK.exec(st))){arrow=m[1];label=m[2];}}
        if(m){
          need(Object.hasOwn(MERMAID_STYLES,arrow),'Only ordinary Mermaid arrows are representable');
          need(!/[<>]/.test(label??''),'Unsupported Mermaid node syntax');
          groups.push(st.slice(start,i));links.push({label:mermaidLabel(label),style:MERMAID_STYLES[arrow]});i=start=m.index+m[0].length;continue;
        }
      }
      if('[({'.includes(c)||(c==='>'&&!depth))depth++;else if(')]}'.includes(c))depth=Math.max(0,depth-1);
      i++;
    }
    groups.push(st.slice(start));
    const ids=groups.map(g=>splitTop(g,'&').map(node));
    for(let k=0;k<links.length;k++)for(const from of ids[k])for(const to of ids[k+1])raw.push({from,to,...links[k]});
  }
  // Mermaid IDs may be Chinese; non-ASCII IDs get stable generated IDs, the text stays as label.
  const ascii=new Set([...labels.keys()].filter(k=>/^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/.test(k)));
  const ids=new Map();let n=0;
  for(const k of labels.keys()){if(ascii.has(k))ids.set(k,k);else{let id;do id=`n${++n}`;while(ascii.has(id));ids.set(k,id);}}
  need(labels.size<=12,'Too many Mermaid nodes','nodes',12,labels.size);
  const seen=new Set(),edges=[];
  for(const e of raw){const key=[e.from,e.to,e.label,e.style].join('\u0000');if(seen.has(key))continue;seen.add(key);edges.push({from:ids.get(e.from),to:ids.get(e.to),relation:'sequence',style:e.style,...(e.label?{label:e.label}:{})});}
  need(edges.length<=20,'Too many Mermaid edges','edges',20,edges.length);
  return {direction:header[1]??'TD',nodes:[...labels].map(([k,label])=>({id:ids.get(k),label,shape:shapes.get(k)??'rect'})),edges};
}
// Closed tables only: a command missing here fails the whole formula (no macros, links or HTML).
const TEX_SYMBOLS={alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ϵ',varepsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',vartheta:'ϑ',iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',omicron:'ο',pi:'π',varpi:'ϖ',rho:'ρ',varrho:'ϱ',sigma:'σ',varsigma:'ς',tau:'τ',upsilon:'υ',phi:'ϕ',varphi:'φ',chi:'χ',psi:'ψ',omega:'ω',
  Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Upsilon:'Υ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
  times:'×',cdot:'·',div:'÷',pm:'±',mp:'∓',ast:'∗',star:'⋆',circ:'∘',bullet:'•',oplus:'⊕',otimes:'⊗',
  leq:'≤',le:'≤',geq:'≥',ge:'≥',neq:'≠',ne:'≠',lt:'<',gt:'>',approx:'≈',equiv:'≡',sim:'∼',simeq:'≃',cong:'≅',propto:'∝',ll:'≪',gg:'≫',
  in:'∈',notin:'∉',ni:'∋',subset:'⊂',subseteq:'⊆',supset:'⊃',supseteq:'⊇',perp:'⊥',parallel:'∥',mid:'∣',
  to:'→',rightarrow:'→',leftarrow:'←',Rightarrow:'⇒',Leftarrow:'⇐',leftrightarrow:'↔',Leftrightarrow:'⇔',implies:'⟹',iff:'⟺',mapsto:'↦',uparrow:'↑',downarrow:'↓',longrightarrow:'⟶',
  forall:'∀',exists:'∃',neg:'¬',lnot:'¬',land:'∧',wedge:'∧',lor:'∨',vee:'∨',cup:'∪',cap:'∩',setminus:'∖',emptyset:'∅',varnothing:'∅',therefore:'∴',because:'∵',
  sum:'∑',prod:'∏',coprod:'∐',int:'∫',iint:'∬',iiint:'∭',oint:'∮',bigcup:'⋃',bigcap:'⋂',
  infty:'∞',partial:'∂',nabla:'∇',prime:'′',angle:'∠',triangle:'△',hbar:'ℏ',ell:'ℓ',Re:'ℜ',Im:'ℑ',aleph:'ℵ',top:'⊤',bot:'⊥',
  ldots:'…',cdots:'⋯',dots:'…',vdots:'⋮',ddots:'⋱',langle:'⟨',rangle:'⟩',lfloor:'⌊',rfloor:'⌋',lceil:'⌈',rceil:'⌉',vert:'|',lvert:'|',rvert:'|',Vert:'‖',lVert:'‖',rVert:'‖',colon:':'};
const TEX_FUNCTIONS={sin:'sin',cos:'cos',tan:'tan',cot:'cot',sec:'sec',csc:'csc',arcsin:'arcsin',arccos:'arccos',arctan:'arctan',sinh:'sinh',cosh:'cosh',tanh:'tanh',coth:'coth',log:'log',ln:'ln',lg:'lg',exp:'exp',lim:'lim',limsup:'lim sup',liminf:'lim inf',max:'max',min:'min',sup:'sup',inf:'inf',det:'det',gcd:'gcd',lcm:'lcm',deg:'deg',dim:'dim',ker:'ker',arg:'arg',hom:'hom',Pr:'Pr',mod:'mod',bmod:'mod'};
// Sizing and spacing only change typography; they are skipped, never interpreted.
const TEX_NOOP=new Set(['left','right','big','Big','bigg','Bigg','bigl','bigr','Bigl','Bigr','biggl','biggr','Biggl','Biggr','displaystyle','textstyle','limits','nolimits','quad','qquad']);
const TEX_TEXT=new Set(['text','textrm','textnormal','mathrm','operatorname','textit','mathit']);
const TEX_ACCENTS={vec:'⃗',hat:'̂',bar:'̄',tilde:'̃',dot:'̇',ddot:'̈'};
const TEX_BB={R:'ℝ',N:'ℕ',Z:'ℤ',Q:'ℚ',C:'ℂ',P:'ℙ'};
const TEX_ESCAPED={'{':'{','}':'}','|':'‖','%':'%','#':'#','&':'&','_':'_','$':'$'};
/** Restricted TeX to existing MathML tree, without macros/HTML/URLs/evaluation. */
export function parseLatex(text) {
  let s=text.trim().replace(/^\$\$([\s\S]*)\$\$$/,'$1').replace(/^\\\[([\s\S]*)\\\]$/,'$1');
  need(s.length<=1200,'TeX budget exceeded');let i=0,count=0;
  const skip=()=>{while(/\s/.test(s[i]??'')&&i<s.length)i++;};
  // Long rows nest in groups of 24 instead of failing; the 120-node budget still applies.
  const row=items=>{if(items.length===1)return items[0];if(items.length<=24)return {op:'row',args:items};const chunks=[];for(let k=0;k<items.length;k+=24)chunks.push(row(items.slice(k,k+24)));return row(chunks);};
  const seq=(depth=0,group=false)=>{need(depth<8,'TeX depth exceeded');const items=[];skip();while(i<s.length&&s[i]!=='}'){let x=atom(depth+1);skip();if(x===null){need(s[i]!=='^'&&s[i]!=='_','TeX operand missing');continue;}while(s[i]==='^'||s[i]==='_'){const op=s[i++]==='^'?'sup':'sub';x={op,args:[x,operand(depth)]};skip();}items.push(x);skip();}if(group){need(s[i]==='}','Unclosed TeX group');i++;}else need(i===s.length,'Unexpected TeX closing brace');need(items.length>0,'Empty TeX row');return row(items);};
  const operand=depth=>{const x=atom(depth+1);need(x!==null,'TeX operand missing');return x;};
  const braced=()=>{skip();need(s[i]==='{','Expected braced text');const j=s.indexOf('}',i),body=s.slice(i+1,j).trim();need(j>i&&body&&body.length<=80&&!/[{}\\$]/.test(body),'Unsupported text argument');i=j+1;return body;};
  const atom=depth=>{
    skip();need(depth<8&&++count<=120&&i<s.length,'TeX budget or operand error');const c=s[i++];
    if(c==='{')return seq(depth,true);
    if(c==='\\'){
      const m=s.slice(i).match(/^[A-Za-z]+/);
      if(!m){const e=s[i++];need(e!==undefined,'Unknown escape');if(',;:! '.includes(e))return null;need(Object.hasOwn(TEX_ESCAPED,e),'Unknown escape');return {op:'symbol',value:TEX_ESCAPED[e]};}
      i+=m[0].length;const cmd=m[0];
      if(['frac','dfrac','tfrac','cfrac'].includes(cmd))return {op:'frac',args:[operand(depth),operand(depth)]};
      if(cmd==='sqrt'){skip();need(s[i]!=='[','Root index is not supported');return {op:'sqrt',args:[operand(depth)]};}
      if(TEX_NOOP.has(cmd)){if(cmd==='left'||cmd==='right'){skip();if(s[i]==='.')i++;}return null;}
      if(TEX_TEXT.has(cmd))return {op:'text',value:braced()};
      if(cmd==='mathbb'){const v=braced();need(Object.hasOwn(TEX_BB,v),'Unsupported blackboard letter');return {op:'symbol',value:TEX_BB[v]};}
      if(Object.hasOwn(TEX_ACCENTS,cmd)){const x=operand(depth);need(['symbol','number'].includes(x.op)&&Array.from(x.value).length===1,'Accent needs a single symbol');return {op:'symbol',value:x.value+TEX_ACCENTS[cmd]};}
      if(Object.hasOwn(TEX_FUNCTIONS,cmd))return {op:'text',value:TEX_FUNCTIONS[cmd]};
      need(Object.hasOwn(TEX_SYMBOLS,cmd),'Unsupported TeX command');return {op:'symbol',value:TEX_SYMBOLS[cmd]};
    }
    need(!/[}^_$]/.test(c),'Unsupported TeX token');
    if(/[0-9]/.test(c)){const m=s.slice(i).match(/^[0-9]*(?:\.[0-9]+)?/);i+=m[0].length;return {op:'number',value:c+m[0]};}
    return {op:'symbol',value:c==="'"?'′':c};
  };
  return seq();
}
function fromFormat(format,text,hints) {
  if(format==='csv'||format==='tsv'){const t=parseDelimited(text,format==='tsv'?'\t':',');return {type:'table',data:makeTable(t.header,t.rows,hints)};}
  if(format==='json')return jsonBlock(text,hints);
  if(format==='mermaid')return {type:'diagram',data:parseMermaid(text)};
  if(format==='latex')return {type:'math',data:{expression:parseLatex(text)}};
  if(format==='diff'){need(/^@@ |^diff --git |^--- /m.test(text),'Expected unified diff');return {type:'diff',data:{patch:text}};}
  throw new Error('Unsupported adapter');
}
const SEP=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
export function discoverFormats(text,{inputFormat='auto',columns=[],final=true}={}) {
  cleanText(text,60000);need(FORMATS.includes(inputFormat),'Unknown inputFormat');need(Array.isArray(columns)&&columns.length<=12,'Invalid column hints');
  const candidates=[],diagnostics=[];
  if(!final)return {candidates,diagnostics};
  const add=(format,source,start,end,raw)=>{
    try {const block=raw??fromFormat(format,source,columns);block.id=`auto_${start}_${format}`;
      const checked=validateDocument({schemaVersion:SCHEMA_VERSION,id:'probe',revision:1,title:'',blocks:[block]}).blocks[0];
      const losses=format==='mermaid'?['节点形状、布局方向和箭头样式未完整保留；所有关系映射为 sequence']:(block._formatLosses??[]);
      candidates.push({id:block.id,start,end,format,block:checked,source:text.slice(start,end),fidelity:{level:losses.length?'lossy':'exact',losses},sourceRef:{kind:'text',start,end}});
    }catch(e){pushFormatFallback(diagnostics,format,e,start,end);}
  };
  if(!['auto','markdown'].includes(inputFormat)){add(inputFormat,text,0,text.length);return {candidates,diagnostics};}
  const lines=markdownBlockContext(text);
  for(let i=0;i<lines.length;i++){
    // Only the guard may admit a genuinely closed, root-level fence.
    const l=lines[i];
    if(l.kind==='fence'){
      const j=l.close;
      if(j===undefined)break;
      const lang=l.fence.info.split(/[ \t]/)[0].toLowerCase().replace(/^[{.]+|}$/g,'');
      const aliases={patch:'diff',udiff:'diff',tex:'latex',katex:'latex',math:'latex',mmd:'mermaid'};const format=aliases[lang]??lang;
      if(FORMATS.includes(format)&&!['auto','markdown'].includes(format))add(format,text.slice(l.end,lines[j].start),l.start,lines[j].end);
      i=j;continue;
    }
    if(l.kind!=='root')continue;
    // Native Markdown tables: no shape inference from prose or inside arbitrary code blocks.
    if(l.text.includes('|')&&lines[i+1]?.kind==='root'&&SEP.test(lines[i+1].text)){
      let j=i+2;while(j<lines.length&&lines[j].kind==='root'&&lines[j].text.includes('|')&&lines[j].text.trim())j++;
      try {
        const next=lines[j];
        // GFM permits body rows without a pipe. We do not pad missing cells or
        // enhance a prefix and reclassify the final row as prose.
        need(!next||!next.text.trim()||next.kind==='fence'||/^ {0,3}#{1,6}\s/.test(next.text),'Ambiguous table continuation');
        const heads=tableInlineCells(l.text),cells=lines.slice(i+2,j).map(x=>tableInlineCells(x.text));
        const header=heads.map(c=>c.text),rows=cells.map(r=>r.map(c=>c.text));need(header.every(Boolean)&&new Set(header).size===header.length,'Invalid headers');need(rows.length>0&&rows.every(r=>r.length===header.length),'Ragged table');
        const data=makeTable(header,rows,columns,cells);data.columns.forEach((c,i)=>{c.inline=heads[i].inline;});
        add('markdown-table',text.slice(l.start,lines[j-1].end),l.start,lines[j-1].end,{type:'table',data});
      }catch(e){pushFormatFallback(diagnostics,'markdown-table',e,l.start,lines[j-1].end);}i=j-1;continue;
    }
    if(l.text.trim()==='$$'||l.text.trim()==='\\['){const close=l.text.trim()==='$$'?'$$':'\\]';let j=i+1;while(j<lines.length&&lines[j].kind==='root'&&lines[j].text.trim()!==close)j++;if(j<lines.length&&lines[j].kind==='root'&&lines[j].text.trim()===close){add('latex',text.slice(l.end,lines[j].start),l.start,lines[j].end);i=j;}}
  }
  // Whole JSON is recognizable without guessing CSV from commas in prose.
  if(!candidates.length&&inputFormat==='auto'&&lines.find(l=>l.text.trim())?.kind==='root'&&/^[\s]*[\[{]/.test(text))add('json',text,0,text.length);
  return {candidates,diagnostics};
}
export const INPUT_FORMATS=Object.freeze(FORMATS);
export {discoverProseStructures} from './prose.mjs';
