const key = 'yanibox-profile-session';
try {
  localStorage.removeItem('yanibox-viewer-session');
  localStorage.removeItem('yanibox-viewer-session-code-verifier');
} catch {}
try { sessionStorage.removeItem('yanibox-viewer-return'); } catch {}

export function session() {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function setSession(value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export function onSessionChange(listener) {
  addEventListener('storage', event => {
    if (event.key === key || event.key === null) listener();
  });
  addEventListener('pageshow', event => {
    if (event.persisted) listener();
  });
}

let config;

export function settings() {
  return config ??= fetch(new URL('data/rating-config.json', import.meta.url))
    .then(response => response.ok ? response.json() : null).catch(() => null);
}

export async function viewerRequest(action, data = {}, signal) {
  const config = await settings();
  if (!config) throw new Error('unavailable');
  const token = session();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Viewer-Session'] = token;
  const response = await fetch(new URL('/functions/v1/viewer-profile', config.url), {
    method: 'POST',
    credentials: 'omit',
    headers,
    body: JSON.stringify({ action, ...data }),
    signal,
    redirect: 'error',
  });
  if (response.status === 401 && token && session() === token) setSession(null);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(payload?.error ?? 'unavailable');
  return payload;
}

export async function publicRatings(config) {
  const response = await fetch(new URL('/rest/v1/rpc/get_film_ratings', config.url), {
    method: 'POST',
    headers: { apikey: config.key },
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('unavailable');
  return response.json();
}
