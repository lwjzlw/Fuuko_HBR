// 在页面绘制前确定主题，避免闪烁：手动选择 > ?theme= 参数 > 系统设置。只存本机浏览器偏好。
(function () {
  var key = 'hbr-theme', root = document.documentElement, choice = null;
  try { choice = localStorage.getItem(key); } catch (e) { choice = null; }
  var param = new URLSearchParams(location.search).get('theme');
  var system = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var theme = choice === 'dark' || choice === 'light' ? choice : (param === 'dark' || param === 'light' ? param : system);
  root.dataset.theme = theme;
  window.hbrToggleTheme = function () {
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(key, next); } catch (e) { /* 只影响下次打开 */ }
    return next;
  };
})();
