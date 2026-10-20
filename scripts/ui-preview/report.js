(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  for (const id of ['scenario', 'appearance', 'viewport', 'version']) if (query.has(id) && [...$(id).options].some(option => option.value === query.get(id))) $(id).value = query.get(id);
  $('text').checked = query.get('text') === '200';
  $('motion').checked = query.get('motion') === 'reduce';
  function fitFrames() {
    const [width, height] = $('viewport').value.split('x').map(Number);
    for (const version of ['before', 'after']) {
      const frame = $(`${version}-frame`).parentElement;
      if (!frame.clientWidth) continue;
      const available = Math.max(1, frame.clientWidth - 16);
      const scale = Math.min(1, available / width);
      frame.style.setProperty('--fit-scale', String(scale));
      frame.style.setProperty('--fit-left', `${8 + (available - width * scale) / 2}px`);
      frame.style.setProperty('--fit-height', `${height * scale}px`);
    }
  }
  let pendingFit = 0;
  function scheduleFit() {
    if (!pendingFit) pendingFit = requestAnimationFrame(() => { pendingFit = 0; fitFrames(); });
  }
  function update() {
    const scenario = $('scenario').value, theme = $('appearance').value;
    const [width, height] = $('viewport').value.split('x');
    document.documentElement.style.setProperty('--phone', `${width}px`);
    document.documentElement.style.setProperty('--height', `${height}px`);
    document.body.classList.toggle('appearance-dark', theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme:dark)').matches);
    const args = new URLSearchParams({ theme, text: $('text').checked ? '200' : '100', motion: $('motion').checked ? 'reduce' : 'system' });
    for (const version of ['before', 'after']) {
      const url = `${version}/${scenario}.html?${args}`;
      const iframe = $(`${version}-frame`);
      // Version toggles and fitting preserve in-frame input/navigation state.
      if (iframe.dataset.scenarioUrl !== url) { iframe.src = url; iframe.dataset.scenarioUrl = url; }
      $(`${version}-link`).href = url;
      $(`${version}-panel`).classList.toggle('mobile-hidden', $('version').value !== version);
    }
    const current = new URLSearchParams({ scenario, appearance: theme, viewport: $('viewport').value, version: $('version').value, text: $('text').checked ? '200' : '100', motion: $('motion').checked ? 'reduce' : 'system' });
    history.replaceState(null, '', `?${current}`);
    scheduleFit();
  }
  document.querySelectorAll('select,input').forEach(control => control.addEventListener('change', update));
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleFit);
    document.querySelectorAll('.frame').forEach(frame => observer.observe(frame));
  }
  window.addEventListener('resize', scheduleFit);
  update();
})();
