/** Internal, conservative block admission guard, not a Markdown renderer.
 * Ambiguous container continuations are retained as Markdown. No public AST/API.
 */
const BLOCK_TAGS='address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_HTML=new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?=[\\t />]|$)`,'i');
// CommonMark type 7: complete open/close tag on a line, including quoted attributes.
const COMPLETE_TAG=/^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
function htmlStart(line){
  const raw=line.match(/^ {0,3}<(script|pre|style|textarea)(?=[\t >]|$)/i);
  if(raw)return new RegExp(`</${raw[1]}>`,'i');
  if(/^ {0,3}<!--/.test(line))return /-->/;
  if(/^ {0,3}<\?/.test(line))return /\?>/;
  if(/^ {0,3}<![A-Z]/.test(line))return />/;
  if(/^ {0,3}<!\[CDATA\[/.test(line))return /\]\]>/;
  if(BLOCK_HTML.test(line)||COMPLETE_TAG.test(line))return 'blank';
  return null;
}
export function fenceOpening(line){
  const m=line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
  if(!m||(m[1][0]==='`'&&m[2].includes('`')))return null;
  return {marker:m[1],info:m[2].trim()};
}
export function fenceClosing(line,marker){
  const m=line.match(/^ {0,3}(`+|~+)[ \t]*$/);
  return !!m&&m[1][0]===marker[0]&&m[1].length>=marker.length;
}
export function markdownBlockContext(text){
  const lines=[...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(m=>m[0].length).map(m=>({
    raw:m[0],text:m[0].replace(/\r?\n$/,''),start:m.index,end:m.index+m[0].length,kind:'blocked'}));
  let html=null,fence=null,container=null,nestedFence=null,blank=false;
  for(let i=0;i<lines.length;i++){
    const l=lines[i],s=l.text,empty=!s.trim();
    if(fence){if(fenceClosing(s,fence.marker)){lines[fence.index].close=i;fence=null;}continue;}
    if(html){if(html==='blank'){if(empty)html=null;}else if(html.test(s))html=null;continue;}
    if(nestedFence){
      // Never promote a list-looking line from the contents of a nested fence.
      const inner=s.replace(/^(?: {0,3}>[ \t]?)+/,'').replace(/^[ \t]+/,'');
      if(fenceClosing(inner,nestedFence))nestedFence=null;
      continue;
    }
    // Deliberately retain lazy continuations through nonblank lines (even potential
    // interrupts). Blank + root indentation is the conservative container exit.
    const sameList=container?.type==='list'&&s.match(/^( *)(?:[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))/)?.[1].length===container.indent;
    if(container&&blank&&!empty&&!sameList&&!/^(?: {1,}|\t)/.test(s)&&!/^ {0,3}>/.test(s))container=null;
    if(empty){blank=true;continue;}
    // Thematic breaks take precedence over list markers, including spaced/tabbed ones.
    if(/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s)){
      if(container)l.container=container.index;
      blank=false;continue;
    }
    const item=s.match(/^( {0,3})(?:[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))/);
    const nestedSource=s.replace(/^(?: {0,3}>[ \t]?)+/,'').replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/,'').trimStart();
    if(container||/^ {0,3}>/.test(s)||item){
      const nf=fenceOpening(nestedSource);
      if(nf)nestedFence=nf.marker;
    }
    if(/^ {0,3}>/.test(s)){container={type:'quote'};blank=false;continue;}
    if(container){
      l.container=container.index;
      if(container.type==='list'&&item&&item[1].length===container.indent)l.kind='list';
      blank=false;continue;
    }
    blank=false;
    // A tab in leading indentation always reaches an indented-code column.
    if(/^(?: {4}| {0,3}\t)/.test(s))continue;
    const h=htmlStart(s);
    if(h){if(h==='blank'||!h.test(s))html=h;continue;}
    const f=fenceOpening(s);
    if(f){l.kind='fence';l.fence=f;fence={...f,index:i};continue;}
    if(item){l.kind='list';l.container=i;container={type:'list',indent:item[1].length,index:i};continue;}
    l.kind='root';
  }
  return lines;
}
