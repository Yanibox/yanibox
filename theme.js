(() => {
  const key = 'yanibox-theme';
  const scheme = matchMedia('(prefers-color-scheme: light)');
  let theme = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {
    // The selector still works when browser storage is unavailable.
  }

  function apply() {
    document.documentElement.dataset.theme = theme === 'system' ? (scheme.matches ? 'light' : 'dark') : theme;
  }

  apply();
  scheme.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('site-theme');
    select.value = theme;
    select.hidden = false;
    select.addEventListener('change', () => {
      theme = select.value;
      apply();
      try {
        localStorage.setItem(key, theme);
      } catch {
        // Keep the new theme for this page.
      }
    });
  });
})();
