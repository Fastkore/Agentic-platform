const statusLine = document.querySelector('[role=status]');
const code = new URLSearchParams(location.hash.slice(1)).get('code');
history.replaceState(null, '', location.pathname);

async function openSettings() {
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    statusLine.textContent = 'Откройте настройки заново по ссылке из Fastkore.';
    return;
  }
  try {
    const response = await fetch('/auth/fastkore/browser/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const result = await response.json();
    if (!response.ok) { statusLine.textContent = result.error ?? 'Не удалось открыть настройки.'; return; }
    if (result.redirect === '/?settings=team') { location.replace(result.redirect); return; }
  } catch { /* The browser may be offline or the server unavailable. */ }
  statusLine.textContent = 'Сервер не ответил. Откройте настройки заново из Fastkore.';
}

void openSettings();
