const encoder = new TextEncoder();
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const rpc = (name: string, args: Record<string, unknown>) => fetch(supabaseUrl + '/rest/v1/rpc/' + name, {
  method: 'POST',
  headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(args),
  signal: AbortSignal.timeout(2500),
});

let config: { broadcaster: string; key: CryptoKey; expires: number } | undefined;

async function signingConfig() {
  if (config && config.expires > Date.now()) return config;
  let secret = Deno.env.get('TWITCH_EVENTSUB_SECRET');
  let broadcaster = Deno.env.get('TWITCH_BROADCASTER_ID');
  if (!secret || !broadcaster) {
    const response = await rpc('yanibox_chat_config', {});
    if (!response.ok) return null;
    const saved = await response.json();
    secret = saved?.secret;
    broadcaster = saved?.broadcaster;
  }
  if (!secret || !broadcaster) return null;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return config = { broadcaster, key, expires: Date.now() + 120000 };
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!supabaseUrl || !serviceKey) return new Response(null, { status: 503 });

  const id = request.headers.get('Twitch-Eventsub-Message-Id');
  const timestamp = request.headers.get('Twitch-Eventsub-Message-Timestamp');
  const type = request.headers.get('Twitch-Eventsub-Message-Type');
  const hash = request.headers.get('Twitch-Eventsub-Message-Signature');
  const age = timestamp ? Date.now() - Date.parse(timestamp) : NaN;
  if (!id || !timestamp || !hash || !/^sha256=[a-f0-9]{64}$/.test(hash) ||
      !Number.isFinite(age) || age < -60000 || age > 600000) {
    return new Response(null, { status: 403 });
  }
  const settings = await signingConfig().catch(() => null);
  if (!settings) return new Response(null, { status: 503 });
  const { broadcaster, key } = settings;
  const body = await request.text();
  const bytes = Uint8Array.from(hash.slice(7).match(/../g)!, pair => parseInt(pair, 16));
  if (!await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(id + timestamp + body))) {
    return new Response(null, { status: 403 });
  }

  const payload = JSON.parse(body);
  if (payload.subscription?.type !== 'channel.chat.message' ||
      payload.subscription.condition?.broadcaster_user_id !== broadcaster) {
    return new Response(null, { status: 403 });
  }
  if (type === 'webhook_callback_verification') {
    return new Response(payload.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }
  if (type === 'revocation') {
    console.warn('Twitch chat subscription revoked', payload.subscription.status);
    return new Response(null, { status: 204 });
  }
  if (type !== 'notification') return new Response(null, { status: 400 });

  const event = payload.event;
  if (event?.broadcaster_user_id !== broadcaster ||
      (event.source_broadcaster_user_id && event.source_broadcaster_user_id !== broadcaster)) {
    return new Response(null, { status: 204 });
  }
  const emotes = event.message.fragments.filter((fragment: { type: string }) => fragment.type === 'emote').length;
  const code = /^!привязать\s+([a-f0-9]{16})$/i.exec(event.message.text.trim())?.[1].toLowerCase();
  if (!emotes && !code) return new Response(null, { status: 204 });

  try {
    const jobs = [];
    if (emotes) jobs.push(rpc('record_twitch_emotes', {
      message_id: event.message_id, viewer_id: event.chatter_user_id, emotes,
    }));
    if (code) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code)));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      jobs.push(rpc('yanibox_confirm_twitch', { digest: hash, sender_id: event.chatter_user_id, sender_login: event.chatter_user_login }));
    }
    if ((await Promise.all(jobs)).every(result => result.ok)) return new Response(null, { status: 204 });
    console.warn('Could not process Twitch chat event');
  } catch {
    console.warn('Twitch emote storage unavailable');
  }
  return new Response(null, { status: 503 });
});
