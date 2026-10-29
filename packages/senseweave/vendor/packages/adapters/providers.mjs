/** Model-API adapters: provider stream/response shapes → visible answer text, plus request builders.
 * Only final visible text is taken. Reasoning/thinking, tool calls and citations are ignored, and an
 * answer is "complete" only when the upstream says it ended normally; nothing is guessed.
 * No network happens here except in createProviderSelect, and only through the caller's fetch.
 * Keep API keys on the server: these builders put the key in request headers.
 */
import {compileMessage} from '../runtime/index.mjs';
import {createSSEDecoder} from '../core/events.mjs';
import {requireContract, cleanText} from '../core/document.mjs';
export const PROVIDER_PROTOCOLS=Object.freeze(['openai-chat','openai-responses','anthropic','gemini','ollama','cohere','bedrock','ai-sdk','ai-sdk-data','dify','langchain','text']);
/** OpenAI-compatible chat endpoints. Defaults only; vendors change URLs, so callers may override. */
export const OPENAI_COMPATIBLE_PRESETS=Object.freeze({
  openai:'https://api.openai.com/v1',deepseek:'https://api.deepseek.com',qwen:'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot:'https://api.moonshot.cn/v1',zhipu:'https://open.bigmodel.cn/api/paas/v4',doubao:'https://ark.cn-beijing.volces.com/api/v3',
  siliconflow:'https://api.siliconflow.cn/v1',openrouter:'https://openrouter.ai/api/v1',groq:'https://api.groq.com/openai/v1',
  mistral:'https://api.mistral.ai/v1',xai:'https://api.x.ai/v1','ollama-openai':'http://127.0.0.1:11434/v1',lmstudio:'http://127.0.0.1:1234/v1',vllm:'http://127.0.0.1:8000/v1'
});
const NATIVE_BASE={'openai-chat':'https://api.openai.com/v1','openai-responses':'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta',ollama:'http://127.0.0.1:11434'};
const REQUEST_PROTOCOLS=Object.keys(NATIVE_BASE);
/** Default base URL per request-capable protocol (callers may override). */
export const PROVIDER_BASE_URLS=Object.freeze({...NATIVE_BASE});
const MAX_RAW=220000;
const COMPLETE={'openai-chat':['stop'],'openai-responses':['completed'],anthropic:['end_turn','stop_sequence'],gemini:['STOP'],ollama:['stop'],cohere:['COMPLETE','STOP_SEQUENCE'],bedrock:['end_turn','stop_sequence'],'ai-sdk':['finish','done','stop'],'ai-sdk-data':['stop'],dify:['message_end','succeeded'],langchain:['end','stop','end_turn','STOP'],text:['end','stop']};
const ANTHROPIC_EVENTS=new Set(['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop','ping']);
const COHERE_EVENTS=new Set(['message-start','content-start','content-delta','content-end','message-end','tool-plan-delta','tool-call-start','tool-call-delta','tool-call-end','citation-start','citation-end']);
const AISDK_EVENTS=new Set(['start','finish','abort','start-step','finish-step','text-start','text-delta','text-end','reasoning-start','reasoning-delta','reasoning-end','source-url','source-document','file','error']);
const isRecord=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const textParts=parts=>Array.isArray(parts)?parts.filter(p=>isRecord(p)&&typeof p.text==='string'&&(p.type===undefined||['text','output_text','text_delta'].includes(p.type))&&p.thought!==true).map(p=>p.text).join(''):'';
/** Guess the protocol from one parsed packet. Returns null when the shape is not recognised. */
export function detectProtocol(packet,eventName) {
  if(typeof packet==='string')return null;
  if(!isRecord(packet))return null;
  if(Array.isArray(packet.choices)||packet.object==='chat.completion.chunk'||packet.object==='chat.completion')return 'openai-chat';
  if(typeof packet.type==='string'&&packet.type.startsWith('response.')||packet.object==='response')return 'openai-responses';
  if(ANTHROPIC_EVENTS.has(packet.type)||packet.type==='message'&&Array.isArray(packet.content)&&'stop_reason' in packet)return 'anthropic';
  if(Array.isArray(packet.candidates)||isRecord(packet.promptFeedback))return 'gemini';
  if('done' in packet&&(isRecord(packet.message)||typeof packet.response==='string'))return 'ollama';
  if(isRecord(packet.message)&&Array.isArray(packet.message.content)&&'finish_reason' in packet)return 'cohere';
  if(COHERE_EVENTS.has(packet.type)||COHERE_EVENTS.has(eventName))return 'cohere';
  if(packet.messageStart||packet.contentBlockDelta||packet.contentBlockStart||packet.contentBlockStop||packet.messageStop||isRecord(packet.output)&&isRecord(packet.output.message))return 'bedrock';
  if(AISDK_EVENTS.has(packet.type))return 'ai-sdk';
  if(typeof packet.event==='string'&&('answer' in packet||'task_id' in packet||'conversation_id' in packet||'workflow_run_id' in packet))return 'dify';
  if(typeof packet.content==='string'||Array.isArray(packet.content)||packet.lc===1)return 'langchain';
  return null;
}
const failureMessage=reason=>{
  if(/length|max_tokens|MAX_TOKENS|max_output_tokens/.test(reason))return '输出达到长度上限被截断；已保留收到的正文。';
  if(/content_filter|SAFETY|RECITATION|BLOCK|PROHIBITED|refusal|guardrail|content_filtered/i.test(reason))return '上游安全策略中止了输出；已保留收到的正文。';
  if(/tool/i.test(reason))return '模型转为调用工具；本次正文可能不完整。';
  if(reason==='missing-finish')return '上游流结束但没有完成标记；不猜测回答完整。';
  return `上游以 ${String(reason).slice(0,60)} 结束；已保留收到的正文。`;
};
/** Stateful decoder: accept(packet, sseEventName) → events {text|refusal|finish|error|replace}. */
export function createProviderDecoder({protocol='auto'}={}) {
  requireContract(protocol==='auto'||PROVIDER_PROTOCOLS.includes(protocol),'PROVIDER','Unknown provider protocol');
  let current=protocol==='auto'?null:protocol,finished=false,stop=null;
  const finish=(reason,complete)=>{finished=true;return [{type:'finish',reason:String(reason),complete:complete??COMPLETE[current]?.includes(reason)??false,protocol:current}];};
  const err=message=>{finished=true;return [{type:'error',message:cleanText(String(message||'上游错误').slice(0,500),500),protocol:current}];};
  const text=t=>typeof t==='string'&&t?[{type:'text',delta:t}]:[];
  function decode(p,eventName){
    switch(current){
      case 'openai-chat':{
        if(p==='[DONE]')return finish(stop??'missing-finish');
        if(p.error)return err(p.error.message??p.error);
        const c=p.choices?.find(x=>(x.index??0)===0);if(!c)return [];
        const d=c.delta??c.message??{},out=[...text(typeof d.content==='string'?d.content:textParts(d.content))];
        if(typeof d.refusal==='string'&&d.refusal)out.push({type:'refusal',delta:d.refusal});
        // Many compatible servers send [DONE] after finish_reason; others close the stream.
        if(c.finish_reason){stop=c.finish_reason;if(c.finish_reason!=='stop')out.push(...finish(c.finish_reason));}
        return out;
      }
      case 'openai-responses':
        if(p.type==='response.output_text.delta')return text(p.delta);
        if(p.type==='response.refusal.delta')return [{type:'refusal',delta:String(p.delta??'')}];
        if(p.type==='response.completed')return finish('completed');
        if(p.type==='response.incomplete')return finish(p.response?.incomplete_details?.reason??'incomplete',false);
        if(p.type==='response.failed')return err(p.response?.error?.message??'response failed');
        if(p.type==='error')return err(p.message??p.error?.message);
        return [];
      case 'anthropic':
        if(p.type==='content_block_delta')return p.delta?.type==='text_delta'?text(p.delta.text):[];
        if(p.type==='content_block_start')return p.content_block?.type==='text'?text(p.content_block.text):[];
        if(p.type==='message_delta'){if(p.delta?.stop_reason)stop=p.delta.stop_reason;return [];}
        if(p.type==='message_stop')return finish(stop??'missing-finish',stop!==null&&COMPLETE.anthropic.includes(stop));
        if(p.type==='error')return err(p.error?.message);
        return [];
      case 'gemini':{
        if(p.error)return err(p.error.message);
        if(p.promptFeedback?.blockReason)return finish('BLOCKED:'+p.promptFeedback.blockReason,false);
        const c=p.candidates?.[0];if(!c)return [];
        const out=text(textParts(c.content?.parts));
        if(c.finishReason&&c.finishReason!=='FINISH_REASON_UNSPECIFIED')out.push(...finish(c.finishReason));
        return out;
      }
      case 'ollama':{
        if(p.error)return err(p.error);
        const out=text(typeof p.message?.content==='string'?p.message.content:p.response);
        if(p.done===true)out.push(...finish(p.done_reason??'missing-finish'));
        return out;
      }
      case 'cohere':{
        const type=p.type??eventName;
        if(type==='content-delta')return text(p.delta?.message?.content?.text);
        if(type==='message-end')return finish(p.delta?.finish_reason??'missing-finish');
        return [];
      }
      case 'bedrock':{
        const ex=Object.keys(p).find(k=>/Exception$/.test(k));if(ex)return err(p[ex]?.message??ex);
        if(p.contentBlockDelta)return text(p.contentBlockDelta.delta?.text);
        if(p.messageStop)return finish(p.messageStop.stopReason??'missing-finish');
        return [];
      }
      case 'ai-sdk':
        if(p==='[DONE]')return finish('done');
        if(p.type==='text-delta')return text(p.delta??p.textDelta);
        // finishReason is optional in the UI stream schema. When supplied it must
        // retain truncation, content filtering and tool-call outcomes.
        if(p.type==='finish')return p.finishReason===undefined?finish('finish'):finish(p.finishReason,p.finishReason==='stop');
        if(p.type==='abort')return finish('abort',false);
        if(p.type==='error')return err(p.errorText??p.error);
        return [];
      case 'ai-sdk-data':{
        const m=typeof p==='string'&&p.match(/^([0-9a-z]):([\s\S]*)$/);if(!m)return [];
        const v=JSON.parse(m[2]);
        if(m[1]==='0')return text(v);
        if(m[1]==='3')return err(v);
        if(m[1]==='d')return finish(v?.finishReason??'missing-finish');
        return [];
      }
      case 'dify':
        if(p.event==='message'||p.event==='agent_message')return text(p.answer);
        if(p.event==='text_chunk')return text(p.data?.text);
        if(p.event==='message_replace'){finished=true;return [{type:'replace',text:String(p.answer??''),protocol:current}];}
        if(p.event==='message_end')return finish('message_end');
        if(p.event==='workflow_finished')return finish(p.data?.status??'missing-finish',p.data?.status==='succeeded');
        if(p.event==='error')return err(p.message);
        return [];
      case 'langchain':{
        const m=isRecord(p.kwargs)?p.kwargs:p,reason=m.response_metadata?.finish_reason??m.response_metadata?.stop_reason;
        const out=text(typeof m.content==='string'?m.content:textParts(m.content));
        if(reason&&!COMPLETE.langchain.includes(reason))out.push(...finish(reason,false));
        return out;
      }
      case 'text':return text(typeof p==='string'?p:'');
    }
    return [];
  }
  return Object.freeze({
    accept(packet,eventName){
      if(finished)return [];
      if(!current){
        if(typeof packet==='string'){if(packet==='[DONE]')return [];current='text';}
        else {current=detectProtocol(packet,eventName);if(!current)return isRecord(packet)&&packet.error?err(packet.error.message??packet.error):[];}
      }
      return decode(packet,eventName);
    },
    /** Called when the source ends. Text/LangChain iterables end normally; others must have said so. */
    end(){if(finished)return [];return current==='text'||current==='langchain'?finish('end',true):current==='openai-chat'&&stop==='stop'?finish('stop'):finish('missing-finish',false);},
    get protocol(){return current;},
    get finished(){return finished;}
  });
}
function lineSplitter(onLine) {
  let pending='';
  return {push(chunk){pending+=chunk;let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i).replace(/\r$/,'');pending=pending.slice(i+1);if(line.trim())onLine(line);}requireContract(pending.length<=MAX_RAW,'BUDGET','上游单行超出预算');},end(){if(pending.trim())onLine(pending.replace(/\r$/,''));pending='';}};
}
const abortError=()=>Object.assign(new Error('Provider read cancelled'),{name:'AbortError'});
/** Interrupt a pending read/next without requiring the source to implement AbortSignal. */
function nextWithSignal(next,signal) {
  if(signal?.aborted)return Promise.reject(abortError());
  if(!signal)return Promise.resolve().then(next);
  return new Promise((resolve,reject)=>{
    const clear=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{clear();reject(abortError());};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    try {Promise.resolve(next()).then(value=>{clear();resolve(value);},error=>{clear();reject(error);});}
    catch(error){clear();reject(error);}
  });
}
// Some source cancellation hooks never settle. Closing them must not hold an already
// cancelled output session open, or block a bounded HTTP error-body read.
function closeReader(reader) {
  try {Promise.resolve(reader.cancel()).catch(()=>{});} catch {}
  try {reader.releaseLock?.();} catch {}
}
function closeIterator(iterator) {
  try {Promise.resolve(iterator.return?.()).catch(()=>{});} catch {}
}
async function errorText(response,signal) {
  const reader=response.body?.getReader?.();
  if(!reader)return '';
  const utf8=new TextDecoder();let raw='',bytes=0;
  try {
    while(bytes<4000){
      const {done,value}=await nextWithSignal(()=>reader.read(),signal);if(done)break;
      const chunk=typeof value==='string'?new TextEncoder().encode(value):value;
      const part=chunk.subarray(0,4000-bytes);bytes+=part.byteLength;
      raw+=utf8.decode(part,{stream:true});
    }
    raw+=utf8.decode();
    try {const j=JSON.parse(raw);return String(j.error?.message??j.error??j.message??'').slice(0,200);} catch {return '';}
  } finally {closeReader(reader);}
}
async function boundedResponseText(response,signal,limit=MAX_RAW) {
  const reader=response.body?.getReader?.();
  requireContract(reader,'PROVIDER','Expected a response body');
  const utf8=new TextDecoder();let raw='';
  try {
    for(;;){
      const {done,value}=await nextWithSignal(()=>reader.read(),signal);if(done)break;
      raw+=typeof value==='string'?value:utf8.decode(value,{stream:true});
      requireContract(raw.length<=limit,'BUDGET','Selector response too large');
    }
    raw+=utf8.decode();requireContract(raw.length<=limit,'BUDGET','Selector response too large');return raw;
  } finally {closeReader(reader);}
}
/** Async events from a fetch Response, a ReadableStream, or an async iterable of SDK chunk objects/strings. */
export async function* readProviderStream(source,{protocol='auto',framing,signal,maxChars=60000}={}) {
  requireContract(framing===undefined||['sse','ndjson','lines','text'].includes(framing),'PROVIDER','Unknown framing');
  requireContract(Number.isSafeInteger(maxChars)&&maxChars>=0&&maxChars<=60000,'BUDGET','maxChars must be an integer from 0 to 60000');
  requireContract(protocol==='auto'||PROVIDER_PROTOCOLS.includes(protocol),'PROVIDER','Unknown provider protocol');
  const isResponse=typeof source?.status==='number'&&'body' in source&&typeof source.headers?.get==='function';
  if(signal?.aborted){yield {type:'abort'};return;}
  if(isResponse&&!source.ok){
    let msg='';
    try {msg=await errorText(source,signal);} catch {if(signal?.aborted){yield {type:'abort'};return;}}
    if(signal?.aborted){yield {type:'abort'};return;}
    yield {type:'error',message:`上游 HTTP ${source.status}${msg?'：'+msg:''}`,protocol:protocol==='auto'?null:protocol};return;
  }
  const type=isResponse?source.headers.get('content-type')??'':'';
  let mode=framing??(protocol==='ollama'||/ndjson/.test(type)?'ndjson':protocol==='ai-sdk-data'||isResponse&&source.headers.get('x-vercel-ai-data-stream')?'lines':protocol==='text'||protocol==='auto'&&/^text\/plain/.test(type)?'text':'sse');
  let effective=protocol!=='auto'?protocol:mode==='lines'?'ai-sdk-data':mode==='text'?'text':'auto';
  let decoder=createProviderDecoder({protocol:effective});
  // Buffer only an undecided prefix: transport chunks may split "data:" or a UTF-8
  // code point anywhere. A declared text/plain JSON answer remains ordinary text.
  let sniffed=framing!==undefined||protocol!=='auto'||mode==='lines'||mode==='ndjson',prefix='';
  const queue=[];let chars=0,terminalQueued=false;
  const accept=(packet,eventName)=>{
    if(terminalQueued)return;
    for(const e of decoder.accept(packet,eventName)){
      if(e.type==='text'||e.type==='refusal'){
        if(chars+e.delta.length>maxChars){
          let count=maxChars-chars;
          if(count>0&&/[\uD800-\uDBFF]/.test(e.delta[count-1])&&/[\uDC00-\uDFFF]/.test(e.delta[count]??''))count--;
          if(count>0)queue.push({...e,delta:e.delta.slice(0,count)});
          queue.push({type:'error',message:'上游正文超出预算；已停止接收。',protocol:decoder.protocol});terminalQueued=true;return;
        }
        chars+=e.delta.length;
      }
      queue.push(e);
      if(!['text','refusal'].includes(e.type)){terminalQueued=true;return;}
    }
  };
  const parse=data=>{if(data==='[DONE]'||effective==='text'||effective==='ai-sdk-data')return data;try{return JSON.parse(data);}catch{throw Object.assign(new Error('上游事件不是 JSON'),{code:'PROVIDER'});}};
  const sse=createSSEDecoder(frame=>accept(parse(frame.data),frame.type),MAX_RAW);
  const lines=lineSplitter(line=>accept(mode==='lines'?line:parse(line)));
  const dispatch=chunk=>{if(mode==='sse')sse.push(chunk);else if(mode==='text')accept(chunk);else lines.push(chunk);};
  const sniff=final=>{
    const sample=prefix.replace(/^\uFEFF/,'').trimStart();
    let next;
    if(/^(?:data|event|id|retry):|^:/.test(sample))next='sse';
    else if(/^[0-9a-z]:\s*["{\[]/.test(sample))next='lines';
    else if(mode!=='text'&&sample.startsWith('{'))next='ndjson';
    else if(!final&&(!sample||['data:','event:','id:','retry:'].some(p=>p.startsWith(sample))||/^[0-9a-z](?::\s*)?$/.test(sample))){requireContract(prefix.length<=MAX_RAW,'BUDGET','上游前缀超出预算');return false;}
    else next=/event-stream/.test(type)?'sse':'text';
    mode=next;effective=mode==='text'?'text':mode==='lines'?'ai-sdk-data':'auto';
    decoder=createProviderDecoder({protocol:effective});sniffed=true;
    const buffered=mode==='text'?prefix:prefix.replace(/^\uFEFF/,'').trimStart();prefix='';dispatch(buffered);return true;
  };
  const feed=chunk=>{if(!chunk)return;if(!sniffed){prefix+=chunk;sniff(false);}else dispatch(chunk);};
  const body=isResponse?source.body:source;
  try {
    if(typeof body?.getReader==='function'){
      const reader=body.getReader(),utf8=new TextDecoder();
      try {
        for(;;){
          const {done,value}=await nextWithSignal(()=>reader.read(),signal);if(done)break;
          if(signal?.aborted){yield {type:'abort'};return;}
          feed(typeof value==='string'?value:utf8.decode(value,{stream:true}));
          while(queue.length){if(signal?.aborted){yield {type:'abort'};return;}const e=queue.shift();yield e;if(e.type!=='text'&&e.type!=='refusal')return;}
        }
        feed(utf8.decode());
      } finally {closeReader(reader);}
    } else {
      requireContract(body&&typeof body!=='string'&&(typeof body[Symbol.asyncIterator]==='function'||typeof body[Symbol.iterator]==='function'),'PROVIDER','Expected a Response, ReadableStream or (async) iterable');
      const utf8=new TextDecoder(),iterator=body[Symbol.asyncIterator]?.()??body[Symbol.iterator]();let exhausted=false;
      try {
        for(;;){
          const {value:item,done}=await nextWithSignal(()=>iterator.next(),signal);if(done){exhausted=true;break;}
          if(signal?.aborted){yield {type:'abort'};return;}
          if(item instanceof Uint8Array)feed(utf8.decode(item,{stream:true}));
          else if(typeof item==='string'&&(framing||protocol!=='auto'&&protocol!=='text'))feed(item);
          else {sniffed=true;accept(item);}
          while(queue.length){if(signal?.aborted){yield {type:'abort'};return;}const e=queue.shift();yield e;if(e.type!=='text'&&e.type!=='refusal')return;}
        }
        feed(utf8.decode());
      } finally {if(!exhausted)closeIterator(iterator);}
    }
    if(!sniffed&&prefix)sniff(true);
    if(mode==='sse')sse.end();else if(mode!=='text')lines.end();
  } catch(error){
    if(signal?.aborted){yield {type:'abort'};return;}
    // A later malformed frame in the same network chunk must not erase earlier text.
    while(queue.length){if(signal?.aborted){yield {type:'abort'};return;}const e=queue.shift();yield e;if(e.type!=='text'&&e.type!=='refusal')return;}
    yield {type:'error',message:error.code==='PROVIDER'||error.code==='BUDGET'?error.message:'上游读取失败',protocol:decoder.protocol};return;
  }
  if(!terminalQueued)queue.push(...decoder.end());
  while(queue.length){if(signal?.aborted){yield {type:'abort'};return;}const e=queue.shift();yield e;if(e.type!=='text'&&e.type!=='refusal')return;}
}
/** Push provider text into an OutputSession (createOutputSession / view.stream) and close it truthfully.
 * The supplied source is bound to the session's close signal. Unrelated host requests remain
 * host-owned: passing a session signal here does not abort a separately created fetch.
 */
export async function pipeProviderStream(source,session,options={}) {
  requireContract(session&&['push','finish','fail','cancel'].every(k=>typeof session[k]==='function'),'SESSION','Expected an output session');
  const live=()=>!session.signal?.aborted&&(!session.getState||session.getState().status==='streaming');
  let hasRefusal=false,hasRefusalText=false,text=session.getState?.().content?.length??0,protocol=null;
  const done=(status,extra={})=>({status,protocol,...extra,snapshot:session.getState?.()});
  const closed=()=>done(session.getState?.().status==='cancelled'||options.signal?.aborted?'cancelled':'closed');
  if(options.signal?.aborted&&live())session.cancel();
  if(!live()||options.signal?.aborted){
    // The host may already have fetched a response before handing it to a closed session.
    // Release an unclaimed body without acquiring a reader or starting an SDK iterator.
    const body=typeof source?.status==='number'&&'body' in source&&typeof source.headers?.get==='function'?source.body:source;
    if(body?.locked===false&&typeof body.cancel==='function'){
      try {Promise.resolve(body.cancel()).catch(()=>{});} catch {}
    }
    return closed();
  }
  // Support independent host and session signals without retaining listeners after this pipe.
  const readerAbort=new AbortController(),subscriptions=[];
  for(const signal of new Set([options.signal,session.signal].filter(Boolean))){
    const abort=()=>readerAbort.abort();
    if(signal.aborted)abort();
    else {signal.addEventListener('abort',abort,{once:true});subscriptions.push(()=>signal.removeEventListener('abort',abort));}
  }
  const appendRefusal=delta=>{
    if(!delta)return;
    hasRefusal=true;
    const available=60000-text;
    // Add a readable boundary only while it leaves room for all received refusal text.
    const separator=text&&!hasRefusalText&&available>delta.length?'\n':'';
    // Never silently trim a later delta to make a refused result look complete. A prior
    // readability separator also consumes the session budget; append rejects atomically.
    const value=separator+delta;
    if(value){session.push(value);text+=value.length;}
    hasRefusalText=true;
  };
  try {
    for await(const e of readProviderStream(source,{...options,signal:readerAbort.signal})){
      protocol=e.protocol??protocol;
      if(!live())return closed();
      if(e.type==='text'){session.push(e.delta);text+=e.delta.length;continue;}
      // Refusals are visible answer text too: commit them immediately so errors/cancellation
      // cannot discard a buffered explanation that the provider already delivered.
      if(e.type==='refusal'){appendRefusal(e.delta);continue;}
      if(e.type==='abort'){session.cancel();return done('cancelled');}
      if(e.type==='error'){session.fail(cleanText(`上游错误：${e.message}`.slice(0,1000),1000));return done('failed',{message:e.message});}
      // The streamed text cannot be withdrawn here; the host must replace the shown message.
      if(e.type==='replace'){session.fail('上游审核替换了回答；请用替换内容重新呈现此消息。');return done('replaced',{replacement:e.text});}
      if(e.type==='finish'){
        if(hasRefusal){session.fail('模型拒绝了本次请求。');return done('refused',{finishReason:e.reason});}
        if(e.complete){session.finish();return done('completed',{finishReason:e.reason});}
        session.fail(failureMessage(e.reason));return done('incomplete',{finishReason:e.reason});
      }
    }
    if(!live())return closed();
    session.fail(failureMessage('missing-finish'));
    return done('incomplete',{finishReason:'missing-finish'});
  } catch(error){
    if(!live())return closed();
    if(options.signal?.aborted)session.cancel();
    else session.fail(error.code==='BUDGET'?'正文超出预算；保留已收到的内容。':'上游读取失败；保留已收到的内容。');
    return done(options.signal?.aborted?'cancelled':'failed',{message:String(error.message??error).slice(0,200)});
  } finally {for(const unsubscribe of subscriptions)unsubscribe();}
}
/** Visible text from one non-streaming provider response. */
export function extractProviderText(response,{protocol='auto'}={}) {
  requireContract(isRecord(response),'PROVIDER','Expected a provider response object');
  if(response.error||response.type==='error'){
    const error=response.error??response;
    requireContract(false,'PROVIDER',`上游错误：${cleanText(String(error.message??error).slice(0,500),500)}`);
  }
  const p=protocol==='auto'?detectProtocol(response):protocol;
  requireContract(p&&PROVIDER_PROTOCOLS.includes(p),'PROVIDER','Unrecognised provider response');
  let text='',refusal='',reason='stop';
  if(p==='openai-chat'){const c=response.choices?.find(x=>(x.index??0)===0)??{},m=c.message??{};text=typeof m.content==='string'?m.content:textParts(m.content);refusal=typeof m.refusal==='string'?m.refusal:'';reason=c.finish_reason??'missing-finish';}
  else if(p==='openai-responses'){for(const item of response.output??[])if(item?.type==='message')for(const part of item.content??[]){if(part?.type==='output_text')text+=part.text??'';if(part?.type==='refusal')refusal+=part.refusal??'';}reason=response.status==='completed'?'completed':response.incomplete_details?.reason??response.status??'missing-finish';}
  else if(p==='anthropic'){text=textParts(response.content);reason=response.stop_reason??'missing-finish';}
  else if(p==='gemini'){const c=response.candidates?.[0];text=textParts(c?.content?.parts);reason=response.promptFeedback?.blockReason?'BLOCKED:'+response.promptFeedback.blockReason:c?.finishReason??'missing-finish';}
  else if(p==='ollama'){text=typeof response.message?.content==='string'?response.message.content:String(response.response??'');reason=response.done===true?response.done_reason??'missing-finish':'missing-finish';}
  else if(p==='cohere'){text=textParts(response.message?.content);reason=response.finish_reason??'missing-finish';}
  else if(p==='bedrock'){text=textParts(response.output?.message?.content);reason=response.stopReason??'missing-finish';}
  else if(p==='dify'){text=String(response.answer??'');reason=response.event==='message'?'message_end':'missing-finish';}
  else if(p==='langchain'){const m=isRecord(response.kwargs)?response.kwargs:response;text=typeof m.content==='string'?m.content:textParts(m.content);reason=m.response_metadata?.finish_reason??m.response_metadata?.stop_reason??'stop';}
  else {text=typeof response.text==='string'?response.text:'';}
  return {protocol:p,text:cleanText(text,60000),refusal:cleanText(refusal,60000),finishReason:String(reason),complete:COMPLETE[p]?.includes(reason)??true};
}
/** One provider response → OutputEnvelope. An unfinished or refused answer is rendered and flagged. */
export function fromProviderResponse(response,{protocol='auto',messageId,...options}={}) {
  const r=extractProviderText(response,{protocol});
  const id=messageId??(typeof response.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(response.id)?response.id:'message');
  const envelope=compileMessage({id,content:r.text+(r.refusal?(r.text?'\n':'')+r.refusal:'')},options);
  if(r.refusal)envelope.diagnostics.push({code:'UPSTREAM_REFUSAL',severity:'warning',message:'模型拒绝了本次请求；已保留正文与拒绝说明。'});
  else if(!r.complete)envelope.diagnostics.push({code:'UPSTREAM_INCOMPLETE',severity:'warning',message:failureMessage(r.finishReason)});
  return envelope;
}
function safeBase(raw) {
  const base=new URL(raw);
  requireContract(!base.username&&!base.password&&!base.search&&!base.hash,'PROVIDER','Base URL must not contain credentials, query or hash');
  requireContract(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname),'PROVIDER','Only HTTPS or local HTTP endpoints are allowed');
  return base.href.replace(/\/+$/,'');
}
/** Build {url, init} for one call. messages: [{role:'user'|'assistant', content:string}]. */
export function buildProviderRequest({protocol='openai-chat',preset,baseURL,apiKey,model,system='',prompt,messages,stream=true,maxTokens,tokenParameter,json=false,headers={},temperature}={}) {
  if(preset!==undefined){requireContract(Object.hasOwn(OPENAI_COMPATIBLE_PRESETS,preset),'PROVIDER','Unknown OpenAI-compatible preset');protocol='openai-chat';baseURL??=OPENAI_COMPATIBLE_PRESETS[preset];}
  requireContract(REQUEST_PROTOCOLS.includes(protocol),'PROVIDER','Request building supports openai-chat, openai-responses, anthropic, gemini and ollama');
  requireContract(typeof model==='string'&&model.length>0&&model.length<=200,'PROVIDER','model is required');
  requireContract(maxTokens===undefined||Number.isSafeInteger(maxTokens)&&maxTokens>0,'PROVIDER','maxTokens must be a positive integer');
  requireContract(tokenParameter===undefined||['max_tokens','max_completion_tokens'].includes(tokenParameter),'PROVIDER','Unknown OpenAI token parameter');
  requireContract(temperature===undefined||Number.isFinite(temperature)&&temperature>=0&&temperature<=2,'PROVIDER','temperature must be 0–2');
  const temp=temperature===undefined?{}:{temperature};
  const base=safeBase(baseURL??NATIVE_BASE[protocol]),json_={'Content-Type':'application/json'};
  // Local servers (Ollama, LM Studio, vLLM on loopback) commonly run without a key.
  requireContract(typeof apiKey==='string'&&apiKey.length>0||apiKey===undefined&&/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])[:/]/.test(base+'/'),'PROVIDER','apiKey is required for remote endpoints');
  const turns=messages??[{role:'user',content:prompt}];
  requireContract(Array.isArray(turns)&&turns.length>0&&turns.length<=64&&turns.every(m=>isRecord(m)&&['user','assistant'].includes(m.role)&&typeof m.content==='string'),'PROVIDER','Expected prompt or user/assistant text messages');
  const bearer=apiKey?{Authorization:`Bearer ${apiKey}`}:{};
  let url,h,body;
  if(protocol==='openai-chat'){
    url=`${base}/chat/completions`;h={...json_,...bearer};
    const tokenKey=tokenParameter??(new URL(base).hostname==='api.openai.com'?'max_completion_tokens':'max_tokens');
    body={model,messages:[...(system?[{role:'system',content:system}]:[]),...turns],stream,...temp,...(json?{response_format:{type:'json_object'}}:{}),...(maxTokens!==undefined?{[tokenKey]:maxTokens}:{})};
  }
  else if(protocol==='openai-responses'){url=`${base}/responses`;h={...json_,...bearer};body={model,...(system?{instructions:system}:{}),input:turns,stream,...temp,...(json?{text:{format:{type:'json_object'}}}:{}),...(maxTokens?{max_output_tokens:maxTokens}:{})};}
  else if(protocol==='anthropic'){url=`${base}/messages`;h={...json_,'x-api-key':apiKey,'anthropic-version':'2023-06-01'};body={model,max_tokens:maxTokens??4096,...temp,...(system?{system}:{}),messages:turns,stream};}
  else if(protocol==='gemini'){url=`${base}/models/${encodeURIComponent(model.replace(/^models\//,''))}:${stream?'streamGenerateContent?alt=sse':'generateContent'}`;h={...json_,'x-goog-api-key':apiKey};body={...(system?{systemInstruction:{parts:[{text:system}]}}:{}),contents:turns.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),...(maxTokens||json?{generationConfig:{...(maxTokens?{maxOutputTokens:maxTokens}:{}),...(json?{responseMimeType:'application/json'}:{})}}:{})};}
  else {url=`${base}/api/chat`;h={...json_,...bearer};body={model,messages:[...(system?[{role:'system',content:system}]:[]),...turns],stream,...(json?{format:'json'}:{}),...(maxTokens?{options:{num_predict:maxTokens}}:{})};}
  return {url,protocol,init:{method:'POST',headers:{...h,...headers},body:JSON.stringify(body)}};
}
/** Selection JSON from model text; tolerates a ```json fence or surrounding prose. */
export function parseSelection(text) {
  const raw=String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''),start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  requireContract(start>=0&&end>start,'SELECTOR','Model did not return JSON');
  const v=JSON.parse(raw.slice(start,end+1));
  return {selectedKeys:v?.selectedKeys,...(typeof v?.reason==='string'?{reason:v.reason}:{})};
}
/** A ready `select` for createSemanticSelector over any request-capable protocol. Server-side only. */
export function createProviderSelect({protocol='openai-chat',preset,baseURL,apiKey,model,headers,tokenParameter,json=true,fetch:fetchImpl=globalThis.fetch}={}) {
  buildProviderRequest({protocol,preset,baseURL,apiKey,model,tokenParameter,prompt:'probe',stream:false});
  requireContract(typeof fetchImpl==='function','PROVIDER','fetch is required');
  const resolved=preset!==undefined?'openai-chat':protocol;
  return async (request,{signal,maxOutputTokens=160}={})=>{
    const {url,init}=buildProviderRequest({protocol,preset,baseURL,apiKey,model,headers,tokenParameter,json,stream:false,maxTokens:maxOutputTokens,system:'You choose presentation views. Reply with JSON only, following the "instruction" field of the user message.',prompt:JSON.stringify(request)});
    const response=await fetchImpl(url,{...init,signal,redirect:'error'});
    if(!response.ok)throw Object.assign(new Error(`selector HTTP ${response.status}`),{code:'HTTP'});
    const raw=await boundedResponseText(response,signal);
    const result=extractProviderText(JSON.parse(raw),{protocol:resolved});
    requireContract(result.complete&&!result.refusal,'PROVIDER','Selector response did not finish normally');
    return parseSelection(result.text);
  };
}

/**
 * A ready `propose` for createAIAssist over any request-capable protocol (server-side only; the key
 * stays in request headers built here). The model's JSON is returned as-is: createAIAssist validates
 * and grounds every proposal before anything is shown. Usage is reported when the provider sends it.
 */
export function createProviderPropose({protocol='openai-chat',preset,baseURL,apiKey,model,headers,tokenParameter,json=true,temperature=0,maxOutputTokens=1200,fetch:fetchImpl=globalThis.fetch}={}) {
  buildProviderRequest({protocol,preset,baseURL,apiKey,model,tokenParameter,temperature,prompt:'probe',stream:false});
  requireContract(typeof fetchImpl==='function','PROVIDER','fetch is required');
  requireContract(Number.isSafeInteger(maxOutputTokens)&&maxOutputTokens>=64&&maxOutputTokens<=8000,'PROVIDER','maxOutputTokens must be 64–8000');
  const resolved=preset!==undefined?'openai-chat':protocol;
  return async (request,{signal,onUsage}={})=>{
    requireContract(isRecord(request)&&typeof request.instruction==='string','ASSIST','Expected an assist request');
    const {instruction,...payload}=request;
    const {url,init}=buildProviderRequest({protocol,preset,baseURL,apiKey,model,headers,tokenParameter,json,temperature,stream:false,maxTokens:maxOutputTokens,system:instruction,prompt:JSON.stringify(payload)});
    const response=await fetchImpl(url,{...init,signal,redirect:'error'});
    if(!response.ok)throw Object.assign(new Error(`propose HTTP ${response.status}`),{code:'HTTP'});
    const packet=JSON.parse(await boundedResponseText(response,signal));
    const u=packet.usage;
    if(u&&typeof onUsage==='function')onUsage({inputTokens:u.prompt_tokens??u.input_tokens,outputTokens:u.completion_tokens??u.output_tokens,totalTokens:u.total_tokens??((u.prompt_tokens??u.input_tokens??0)+(u.completion_tokens??u.output_tokens??0))});
    const result=extractProviderText(packet,{protocol:resolved});
    requireContract(result.complete&&!result.refusal,'PROVIDER','Propose response did not finish normally');
    const raw=String(result.text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''),start=raw.indexOf('{'),end=raw.lastIndexOf('}');
    requireContract(start>=0&&end>start,'ASSIST','Model did not return JSON');
    return JSON.parse(raw.slice(start,end+1));
  };
}
