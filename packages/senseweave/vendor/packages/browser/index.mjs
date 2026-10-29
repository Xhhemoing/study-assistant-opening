import {createSenseWeave, createOutputSession} from '../runtime/index.mjs';
import {normalizeSources} from '../core/document.mjs';
import {createPreferenceStore, resolveContext} from '../policy/index.mjs';
/** This entry itself is SSR-safe: the DOM module loads only when explicitly mounted in a browser. */
export async function mountSenseWeave(container, options = {}) {
  if (!globalThis.document || !container?.append) throw new Error('mountSenseWeave requires a browser element');
  if (!customElements.get('sense-weave')) await import('../element/sense-weave.mjs');
  const element = document.createElement('sense-weave');
  const preferences=options.preferences??createPreferenceStore();
  let runtime=createSenseWeave({...options,preferences}),lastResult=null,hostContext={...options.context};
  const reportError=(error,handler=options.onError)=>{
    try {const result=handler?.(error);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});} catch {}
  };
  const observe=(callback,value,onError=options.onError)=>{
    try {const result=callback?.(value);if(result&&typeof result.then==='function')Promise.resolve(result).catch(error=>reportError(error,onError));} catch(error){reportError(error,onError);}
  };
  const panel=document.createElement('details');panel.className='senseweave-decision';panel.style.cssText='font:14px/1.6 system-ui;margin:8px 0;max-width:900px';
  const updateDecision=result=>{
    lastResult=result;observe(options.onDecision,structuredClone(result.decision));
    if(options.showDecision!==true)return;
    panel.replaceChildren();const summary=document.createElement('summary');summary.textContent=`呈现选择：${result.mode==='rich'?'增强':'保持文字'} · 为什么？`;panel.append(summary);
    const description=document.createElement('p');description.textContent=result.decision.reason+'。'+result.decision.selected.map(c=>`${c.type}: ${c.reasons.join('；')}`).join(' / ');panel.append(description);
    for(const [label,helpful]of [['这次增强有帮助',true],['这次不需要增强',false]]){const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=result.mode!=='rich'||!result.decision.selected.length;button.style.marginRight='8px';button.addEventListener('click',()=>{for(const c of result.decision.selected)runtime.feedback({component:c.type,task:result.decision.task??'auto',helpful});description.textContent='已记录本地偏好，仅影响后续选择；可重置。不发送正文，不代表学会或业务成功。';for(const b of panel.querySelectorAll('button'))b.disabled=true;});panel.append(button);}
  };
  let sources = normalizeSources(options.sources ?? []), session = null, disposed = false;
  element.sources = sources;
  element.setAttribute('theme', ['dark', 'auto'].includes(options.theme) ? options.theme : 'light');
  if (options.chrome === 'none') element.setAttribute('chrome', 'none');
  if (options.renderInline) element.renderInline = options.renderInline;
  const listener = event => observe(options.onInteraction,structuredClone(event.detail));
  element.addEventListener('sw-interaction', listener);
  container.append(element);
  if(options.showDecision===true)container.append(panel);
  const ensure = () => {if (disposed) throw new Error('SenseWeave mount has been disposed');};
  return Object.freeze({
    element,
    render(message, override = {}) {
      ensure();
      const result = runtime.render(message, {...override,sources,context:{...hostContext,...override.context}});
      session?.dispose(); session = null;
      element.showNotice('');
      element.hints = result.hints ?? null;
      element.document = result.document; updateDecision(result);
      return result;
    },
    stream(override = {}) {
      ensure();
      const {onUpdate,onError=options.onError,...sessionOptions}=override;
      const next = createOutputSession({...options,...sessionOptions, preferences,
        context:{...hostContext,...sessionOptions.context},policy:{...options.policy,...sessionOptions.policy},sources,
        onError:error=>reportError(error,onError),
        onUpdate(state) {
          if (disposed) return;
          if (state.status === 'streaming') element.setPreview(state.document, state.pending);
          else {element.hints = state.hints ?? null; element.document = state.document; updateDecision(state); if (state.reason) element.showNotice(state.reason);}
          observe(onUpdate,state,onError);
        }
      });
      session?.dispose(); session = next;
      element.showNotice('');
      return session;
    },
    setContext(context) {ensure();resolveContext(context);const next={...hostContext,...context};resolveContext(next);hostContext=next;runtime.clearCache();},
    resetPreferences() {ensure();runtime.resetPreferences();},
    getStats:()=>runtime.getStats(),
    setSources(next) {
      ensure(); const normalized = normalizeSources(next);
      // Apply validated authorization first; a bad registry must not disrupt an active stream.
      element.sources = normalized; sources = normalized; runtime.clearCache();
      // A session has an immutable source snapshot. Revoke it before it can restore stale access.
      const previous = session, wasStreaming = previous?.getState().status === 'streaming';
      previous?.dispose(); session = null;
      if (wasStreaming) {
        const state = previous.getState();
        // The element revalidates this final, lossless document against the new registry.
        element.document = state.document; updateDecision(state);
        element.showNotice('来源访问范围已更新，当前输出已停止；已保留收到的内容。');
      }
    },
    unmount() {if (disposed) return; disposed = true; session?.dispose(); element.removeEventListener('sw-interaction', listener); element.remove();panel.remove();runtime.clearCache();}
  });
}

export {mountBlock} from './block.mjs';
