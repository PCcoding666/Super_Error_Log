// 轻量增强：表单二次确认（data-confirm 属性）
document.addEventListener('submit', (e) => {
  const t = e.target;
  if (t instanceof HTMLFormElement && t.dataset.confirm) {
    if (!window.confirm(t.dataset.confirm)) {
      e.preventDefault();
    }
  }
});
