/** Static, parser-blocking head script. No request data is interpolated into executable code. */
export const appearanceBootstrap = `(function(){
  var p={},root=document.documentElement;
  try{var v=JSON.parse(localStorage.getItem('aistudy.appearance.v1')||'null');if(v&&v.version===1&&v.preferences&&typeof v.preferences==='object')p=v.preferences;}catch(_){}
  var dark=typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme',p.theme==='dark'||(p.theme!=='light'&&dark)?'dark':'light');
  root.setAttribute('data-reading-font',p.readingFont==='sans'?'sans':'serif');
  var reduce=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.setAttribute('data-motion',p.motion==='reduce'||reduce?'reduce':'full');
})();`;
