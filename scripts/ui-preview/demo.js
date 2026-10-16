/* Preview-only adapter. No production script, network call, cookie, or server write. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') || 'system';
  if (theme === 'light' || theme === 'dark') {
    document.getElementById('demo-app-style').href = `assets/${theme}.css`;
    document.documentElement.style.colorScheme = theme;
  }
  if (params.get('text') === '200') document.documentElement.style.fontSize = '200%';
  if (params.get('motion') === 'reduce') document.documentElement.classList.add('demo-reduce-motion');
  const version = location.pathname.includes('/before/') ? 'before' : 'after';
  const key = `sel-ui-preview:${version}:`;
  const status = document.getElementById('demo-status');
  const say = message => { status.textContent = message; status.scrollIntoView({ block: 'nearest', behavior: 'instant' }); };
  const read = name => { try { return JSON.parse(sessionStorage.getItem(key + name) || 'null'); } catch { return null; } };
  const save = (name, value) => { try { sessionStorage.setItem(key + name, JSON.stringify(value)); return true; } catch { return false; } };
  const go = (scene, message) => {
    if (message) save('notice', message);
    location.href = `${scene}.html${location.search}`;
  };
  const queued = read('notice');
  if (queued) { status.textContent = queued; save('notice', null); }
  document.querySelectorAll('a[href$=".html"]').forEach(link => {
    if (!link.hasAttribute('target')) link.href += location.search;
  });
  document.querySelectorAll('[data-voice-for]').forEach(voice => {
    voice.classList.remove('hidden');
    const privacy = voice.querySelector('[data-testid="voice-privacy"]');
    if (privacy) privacy.textContent = '静态演示不录音、不转写。请用文字输入。';
  });
  document.querySelectorAll('input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let box = document.getElementById('demo-local-photo');
      if (!box) {
        box = document.createElement('section'); box.id = 'demo-local-photo'; box.className = 'card';
        document.querySelector('main').appendChild(box);
      }
      box.replaceChildren();
      const title = document.createElement('p'); title.textContent = `本机预览：${file.name}。文件没有上传，离开此页即清除。`; box.appendChild(title);
      const image = document.createElement('img'); image.alt = '本机选择的图片，仅在当前浏览器显示'; image.className = 'crop';
      const blobUrl = URL.createObjectURL(file); image.onload = () => URL.revokeObjectURL(blobUrl);
      image.onerror = () => { URL.revokeObjectURL(blobUrl); image.remove(); title.textContent += ' 浏览器不能显示此格式；仍可查看下面的合成演示。'; };
      image.src = blobUrl; box.appendChild(image);
      const next = document.createElement('a'); next.href = `photos.html${location.search}`; next.className = 'btn'; next.textContent = '查看合成识别示例'; box.appendChild(next);
      say('已在本机显示所选文件。没有上传或识别；下一步展示预设的合成题。');
    });
  });
  document.querySelectorAll('form[data-pick-count]').forEach(form => {
    const boxes = [...form.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
    const max = Number(form.dataset.max || 8), min = Number(form.dataset.min || 1);
    const button = document.querySelector(`[form="${form.id}"][data-count-label]`);
    const update = () => {
      const n = boxes.filter(box => box.checked).length;
      boxes.forEach(box => { box.closest('label').classList.toggle('selected', box.checked); });
      if (button) { button.disabled = n < min; button.textContent = n ? button.dataset.template.replace('{n}', String(n)) : button.dataset.empty; }
    };
    boxes.forEach(box => box.addEventListener('change', () => {
      if (boxes.filter(candidate => candidate.checked).length > max) { box.checked = false; say(`最多选 ${max} 道；先去掉一道再添加。`); }
      update();
    }));
    update();
  });
  document.querySelectorAll('textarea[data-count]').forEach(input => {
    input.addEventListener('input', () => { const label = document.querySelector(input.dataset.count); if (label) label.textContent = `还能写 ${input.maxLength - input.value.length} 字`; });
  });
  document.querySelectorAll('input[name$="Other"]').forEach(input => input.addEventListener('input', () => {
    const radio = input.form.querySelector(`input[name="${input.name.replace(/Other$/, '')}"][value="__other"]`); if (radio) radio.checked = true;
  }));
  const settings = document.querySelector('[data-demo-form="settings"]');
  if (settings) {
    const previous = read('settings');
    if (previous) for (const [name, value] of Object.entries(previous)) {
      const field = settings.elements.namedItem(name);
      if (field && 'value' in field) field.value = value;
    }
  }
  const answer = document.getElementById('answer-text');
  if (answer && read('answer')) answer.value = read('answer');
  document.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    const values = new FormData(form), kind = form.dataset.demoForm;
    switch (kind) {
      case 'login':
        if (!String(values.get('code') || '').trim()) { say('演示登录：随便输入文字即可进入，请勿输入真实邀请码。'); return; }
        go('today', '已进入合成错题本；没有兑换邀请码，也没有创建真实登录会话。'); break;
      case 'logout': go('login', '已返回演示登录页；不会影响真实账号。'); break;
      case 'consent': go('capture', '这里只切换演示页面；没有提交真实上传同意，也没有上传照片。'); break;
      case 'settings': {
        const saved = save('settings', Object.fromEntries(values.entries()));
        say(saved ? '演示设置已记在当前标签页，刷新后可见。没有保存到服务器。' : '浏览器未允许本地存储；设置仅在当前页显示，没有保存到服务器。');
        break;
      }
      case 'choose': {
        const n = values.getAll('itemIds').length;
        if (!n) { say('至少选 1 道题再继续。'); return; }
        go('why', `你选了 ${n} 道。接下来展示固定的合成追问；没有建立或保存练习。`); break;
      }
      case 'pick': go('items', '已切换到固定的合成题目列表；没有识别或保存所选题目。'); break;
      case 'answer': save('answer', values.get('answer')); go('confirm', '文字只用于浏览器演示。下面是固定的合成建议；没有发送给 AI。'); break;
      case 'reflection': {
        if (['attemptState', 'cause', 'masteryFeeling'].some(name => !values.has(name))) { say('请选一下当时怎么了、主要错在哪，以及自己的把握。'); return; }
        say('已收到本页演示选择。没有提交反思，也没有生成练习纸。静态预览不提供打印或结果记录服务。'); break;
      }
      case 'photo': say('所选图片只在本机显示，没有上传。点「查看合成识别示例」继续。'); break;
      default: say('此操作需要真实服务。静态预览不会修改、录音、打印或记录学习结果。请用场景选择器查看其他页面。');
    }
  }, true);
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link && (link.getAttribute('href') === '#demo-unavailable' || link.hasAttribute('data-print'))) {
      event.preventDefault(); say('此操作需要真实服务。静态预览不打印、不记录结果、不修改题目；可通过对照入口切换场景。'); return;
    }
    const button = event.target.closest('button');
    if (!button || button.disabled || button.type !== 'button') return;
    if (button.closest('[data-voice-for]')) say('静态演示不录音、不转写。请直接在文本框输入。');
    else if (button.dataset.key === 'install-dismiss') { button.closest('.a2hs')?.remove(); say('已在本页收起提示，刷新后恢复。'); }
    else say('这是静态演示：此按钮需要真实服务，不会发送请求。');
  });
  // Reproduce only browser layout measurement, separately from production behavior.
  const resizeBar = () => {
    const bar = document.querySelector('.next-bar');
    if (bar) document.documentElement.style.setProperty('--bar-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  };
  if (typeof ResizeObserver !== 'undefined') { const bar = document.querySelector('.next-bar'); if (bar) new ResizeObserver(resizeBar).observe(bar); }
  resizeBar();
})();
