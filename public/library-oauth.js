const params = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);
const state = params.get('state');
if (state && /^[\da-f-]{36}$/i.test(state)) {
  const channel = new BroadcastChannel('library-oauth-' + state);
  channel.postMessage({ code: params.get('code') });
  channel.close();
}
document.getElementById('result').textContent = params.has('code') && state
  ? 'Вернитесь в библиотеку для выбора папки. Это окно можно закрыть.' : 'Вход отменён. Вернитесь в библиотеку, чтобы повторить подключение.';
window.close();
