import {normalizeSources} from '../core/document.mjs';
import {themeTokens} from '../runtime/theme.mjs';
// Kept separate from the runtime so a host that only mounts blocks loads no decision code,
// and the element itself is fetched only when the first block appears.
/**
 * Mount one block segment from segmentOutput() without SenseWeave's header, toolbar or sources.
 * The host keeps its own message layout and text renderer; theme the block with --sw-* tokens.
 */
export async function mountBlock(container, segment, options = {}) {
  if (!globalThis.document || !container?.append)
    throw new Error('mountBlock requires a browser element');
  if (!segment || segment.kind !== 'block' || !segment.document)
    throw new Error('mountBlock expects a block segment from segmentOutput');
  if (!customElements.get('sense-weave')) await import('../element/sense-weave.mjs');
  const element = document.createElement('sense-weave');
  element.setAttribute('chrome', 'none');
  element.setAttribute('theme', ['dark', 'auto'].includes(options.theme) ? options.theme : 'light');
  element.dataset.segment = segment.blockId;
  // A few host colours (accent, ink, muted, line, paper, soft, font) fill every --sw-* token.
  if (options.tokens)
    for (const [k, v] of Object.entries(themeTokens(options.tokens)))
      element.style.setProperty(k, v);
  if (options.renderInline) element.renderInline = options.renderInline;
  // Motion/sketch decoration; hosts may pass hints:null to keep blocks static.
  const hintsOf = seg => options.hints === null ? null : options.hints ?? seg.hints ?? null;
  element.hints = hintsOf(segment);
  element.sources = normalizeSources(options.sources ?? segment.document.sources ?? []);
  const listener = event => {
    try {
      const r = options.onInteraction?.(structuredClone(event.detail));
      if (r && typeof r.then === 'function')
        Promise.resolve(r).catch(error => {
          try {
            options.onError?.(error);
          } catch {}
        });
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {}
    }
  };
  element.addEventListener('sw-interaction', listener);
  container.append(element);
  element.document = segment.document;
  let disposed = false;
  return Object.freeze({
    element,
    update(next) {
      if (disposed) throw new Error('SenseWeave block has been disposed');
      if (!next || next.kind !== 'block' || !next.document)
        throw new Error('update expects a block segment');
      element.dataset.segment = next.blockId;
      element.hints = hintsOf(next);
      element.document = next.document;
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      element.removeEventListener('sw-interaction', listener);
      element.remove();
    }
  });
}
