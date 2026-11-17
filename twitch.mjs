const scope = 'channel:read:redemptions';
const socketUrl = 'wss://eventsub.wss.twitch.tv/ws';
export const redirectUri = new URL('admin.html', import.meta.url).href;

export function beginLogin(clientId) {
  if (!/^[a-z0-9]+$/i.test(clientId)) throw new Error('Введи Client ID из консоли Twitch.');
  const state = crypto.randomUUID();
  sessionStorage.setItem('kino-oauth', JSON.stringify({ state, clientId }));
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope, state
  });
  location.assign('https://id.twitch.tv/oauth2/authorize?' + params);
}

export function finishLogin() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  if (!hash.has('access_token') && !query.has('error') && !hash.has('error')) return null;
  history.replaceState(null, '', redirectUri);
  const saved = JSON.parse(sessionStorage.getItem('kino-oauth') || 'null');
  sessionStorage.removeItem('kino-oauth');
  if (!saved || saved.state !== (hash.get('state') || query.get('state'))) {
    throw new Error('Сессия входа устарела. Войди через Twitch ещё раз.');
  }
  if (!hash.has('access_token')) throw new Error('Доступ к Twitch не предоставлен.');
  return { clientId: saved.clientId, token: hash.get('access_token') };
}

export async function validate(auth) {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + auth.token },
    cache: 'no-store'
  });
  if (response.status === 401) throw new Error('Сессия Twitch истекла. Войди снова.');
  if (!response.ok) throw new Error('Twitch не подтвердил авторизацию.');
  const result = await response.json();
  if (result.client_id !== auth.clientId || !result.user_id || !result.scopes?.includes(scope)) {
    throw new Error('Войди заново и разреши чтение наград канала.');
  }
  return result;
}

async function helix(path, auth, options = {}) {
  const response = await fetch('https://api.twitch.tv/helix/' + path, {
    ...options,
    headers: {
      'Client-Id': auth.clientId, Authorization: 'Bearer ' + auth.token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  if (!response.ok) throw new Error(`Twitch ответил ${response.status}. Проверь доступ к наградам канала.`);
  return response.json();
}

export async function getRewards(auth, userId) {
  const result = await helix('channel_points/custom_rewards?' + new URLSearchParams({
    broadcaster_id: userId
  }), auth);
  return result.data.filter(reward => reward.is_enabled && reward.is_user_input_required);
}

export function listen({ auth, userId, rewardIds, onEvent, onStatus }) {
  const type = 'channel.channel_points_custom_reward_redemption.add';
  let current;
  let next;
  let stopped = false;
  let retry;
  let delay = 1000;
  const close = connection => {
    if (!connection) return;
    clearTimeout(connection.watchdog);
    connection.socket.close();
  };

  function stop() {
    stopped = true;
    clearTimeout(retry);
    close(current);
    close(next);
  }

  function reconnect() {
    if (stopped || retry) return;
    onStatus('Переподключение', 'Во время разрыва заявки могут быть пропущены.');
    retry = setTimeout(() => {
      retry = undefined;
      open(socketUrl);
    }, delay);
    delay = Math.min(delay * 2, 30000);
  }

  function open(url, transfer = false) {
    const socket = new WebSocket(url);
    const connection = { socket, keepalive: 15000, watchdog: null };
    if (transfer) next = connection;
    else current = connection;
    function resetWatchdog() {
      clearTimeout(connection.watchdog);
      connection.watchdog = setTimeout(() => socket.close(), connection.keepalive + 3000);
    }
    resetWatchdog();

    socket.addEventListener('close', () => {
      clearTimeout(connection.watchdog);
      if (next === connection) next = undefined;
      else if (current !== connection) return;
      else current = undefined;
      if (!current && !next) reconnect();
    });

    socket.addEventListener('message', async message => {
      if (stopped || (connection !== current && connection !== next)) return;
      let packet;
      try { packet = JSON.parse(message.data); } catch { return; }
      resetWatchdog();
      const { metadata, payload } = packet;
      switch (metadata?.message_type) {
        case 'session_welcome':
          connection.keepalive = (payload.session.keepalive_timeout_seconds || 15) * 1000;
          resetWatchdog();
          try {
            if (transfer) {
              const old = current;
              current = connection;
              next = undefined;
              close(old);
            } else {
              await helix('eventsub/subscriptions', auth, {
                method: 'POST',
                body: JSON.stringify({
                  type, version: '1',
                  condition: { broadcaster_user_id: userId },
                  transport: { method: 'websocket', session_id: payload.session.id }
                })
              });
            }
            if (stopped || current !== connection) return;
            delay = 1000;
            onStatus('Слушает награды', 'Новые заказы появятся в очереди.');
          } catch (error) {
            if (stopped || current !== connection) return;
            stop();
            onStatus('Ошибка подписки', error.message);
          }
          break;
        case 'session_reconnect': {
          const target = new URL(payload.session.reconnect_url);
          if (!next && target.protocol === 'wss:' && target.hostname === 'eventsub.wss.twitch.tv') {
            open(target.href, true);
          }
          break;
        }
        case 'notification':
          if (payload.subscription.type === type && payload.event.broadcaster_user_id === userId &&
              rewardIds.has(payload.event.reward?.id)) onEvent(payload.event);
          break;
        case 'revocation':
          stop();
          onStatus('Подписка отозвана', 'Подключи Twitch снова и проверь награду.');
          break;
      }
    });
  }

  onStatus('Подключение', '');
  open(socketUrl);
  return stop;
}
