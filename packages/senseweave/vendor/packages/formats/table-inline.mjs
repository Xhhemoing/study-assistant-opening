/** Internal conservative table inline reader. Raw strings are never HTML. */
const ESC=/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
function fail(message='Inline markup requires the original Markdown renderer'){throw new Error(message);}
/** TeX deliberately keeps its source delimiters in plain text; only a host can typeset it. */
function plain(source,depth=0){
  if(depth>12)fail();
  let text='',markup=false;
  const isSpace=c=>!c||/\s/.test(c);
  const escapedAt=index=>{let n=0;for(let j=index-1;j>=0&&source[j]==='\\';j--)n++;return n%2===1;};
  const findClosing=(run,from)=>{
    for(let at=from;(at=source.indexOf(run,at))>=0;at+=run.length)if(!escapedAt(at))return at;
    return -1;
  };
  const punct=c=>!!c&&/[\p{P}\p{S}]/u.test(c);
  const flanks=(at,size)=>{
    const before=source[at-1],after=source[at+size];
    const left=!isSpace(after)&&(!punct(after)||isSpace(before)||punct(before));
    const right=!isSpace(before)&&(!punct(before)||isSpace(after)||punct(after));
    return {open:left&&(source[at]!=='_'||!right||punct(before)),close:right&&(source[at]!=='_'||!left||punct(after))};
  };
  const emphasisRun=(run,i)=>{
    const ch=run[0],before=source[i-1],after=source[i+run.length];
    // CommonMark's whitespace and intraword rules prevent arithmetic and
    // prose underscores from being mistaken for emphasis delimiters.
    if(ch==='_'&&/\w/.test(before??'')&&/\w/.test(after??''))return false;
    if(!flanks(i,run.length).open)return false;
    const end=findClosing(run,i+run.length);
    if(end<0)return 'unclosed';
    const inside=source.slice(i+run.length,end);
    if(!inside||isSpace(inside[0])||isSpace(inside.at(-1)))return false;
    const closeBefore=source[end-1],closeAfter=source[end+run.length];
    if(!flanks(end,run.length).close)return false;
    if(ch==='_'&&/\w/.test(closeBefore??'')&&/\w/.test(closeAfter??''))return false;
    return end;
  };
  for(let i=0;i<source.length;){
    const tail=source.slice(i),c=source[i];
    if(c==='`'){
      const run=tail.match(/^`+/)[0];let end=i+run.length;
      while((end=source.indexOf(run,end))>=0){
        if(source[end-1]!=='`'&&source[end+run.length]!=='`')break;
        end+=run.length;
      }
      if(end<0)fail();let body=source.slice(i+run.length,end).replace(/\\\|/g,'|');
      if(body.startsWith(' ')&&body.endsWith(' ')&&body.trim())body=body.slice(1,-1);
      text+=body;markup=true;i=end+run.length;continue;
    }
    if(tail.startsWith('\\(')||tail.startsWith('\\[')){
      const close=tail[1]==='('? '\\)' : '\\]',end=source.indexOf(close,i+2);if(end<0)fail();
      text+=source.slice(i,end+2);markup=true;i=end+2;continue;
    }
    if(c==='\\'&&ESC.test(source[i+1]??'')){text+=source[i+1];i+=2;continue;}
    if(c==='$'){
      const run=tail.startsWith('$$')?'$$':'$';let end=i+run.length;
      while((end=source.indexOf(run,end))>=0&&escapedAt(end))end+=run.length;
      if(end<0)fail();text+=source.slice(i,end+run.length);markup=true;i=end+run.length;continue;
    }
    if(c==='['){
      const m=tail.match(/^\[([^\[\]]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/);
      if(m){text+=plain(m[1],depth+1).text;markup=true;i+=m[0].length;continue;}
      // Literal/reference-looking brackets retain their exact visible spelling.
      const end=source.indexOf(']',i+1);if(end<0||source[end+1]==='('||/[\\*_~`]/.test(source.slice(i+1,end)))fail();text+=source.slice(i,end+1);i=end+1;continue;
    }
    if(c==='*'||c==='_'||c==='~'){
      const run=tail.match(c==='*'?/^\*{1,3}/:c==='_'?/^_{1,3}/:/^~~/)?.[0];
      if(!run)fail();
      const result=emphasisRun(run,i);
      if(result==='unclosed')fail();
      if(result===false){text+=run;i+=run.length;continue;}
      text+=plain(source.slice(i+run.length,result),depth+1).text;markup=true;i=result+run.length;continue;
    }
    if(c==='!'&&source[i+1]==='[')fail();
    text+=c;i++;
  }
  return {text,markup};
}
export function tableInlineCells(line){
  // HTML/entities still require the host's complete Markdown renderer, even in code.
  const unescaped=line.replace(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,'');
  if(/[<>]/.test(unescaped)||/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(unescaped))fail();
  const s=line.trim(),raw=[];let start=0,code='';
  for(let i=0;i<s.length;i++){
    if(s[i]==='\\'&&i+1<s.length&&!code){i++;continue;}
    if(s[i]==='`'){
      const run=s.slice(i).match(/^`+/)[0];if(!code)code=run;else if(code===run)code='';i+=run.length-1;continue;
    }
    if(s[i]==='|'&&code){
      let slashes=0;for(let j=i-1;j>=0&&s[j]==='\\';j--)slashes++;
      // GFM's table tokenizer is deliberately not emulated for code pipes:
      // treating this as a cell boundary would silently corrupt the source.
      if(slashes%2===0)fail('Code spans in table cells remain Markdown');
    }
    if(s[i]==='|'&&!code){raw.push(s.slice(start,i).trim());start=i+1;}
  }
  if(code)fail();raw.push(s.slice(start).trim());
  if(s.startsWith('|'))raw.shift();if(start===s.length&&s.endsWith('|'))raw.pop();
  return raw.map(inline=>({inline,...plain(inline)}));
}
