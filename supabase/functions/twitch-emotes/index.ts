const encoder = new TextEncoder();
const secret = Deno.env.get('TWITCH_EVENTSUB_SECRET');
const broadcaster = Deno.env.get('TWITCH_BROADCASTER_ID');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const signatureKey = secret
  ? crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  : null;

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!signatureKey || !broadcaster || !supabaseUrl || !serviceKey) return new Response(null, { status: 503 });

  const id = request.headers.get('Twitch-Eventsub-Message-Id');
  const timestamp = request.headers.get('Twitch-Eventsub-Message-Timestamp');
  const type = request.headers.get('Twitch-Eventsub-Message-Type');
  const hash = request.headers.get('Twitch-Eventsub-Message-Signature');
  const age = timestamp ? Date.now() - Date.parse(timestamp) : NaN;
  if (!id || !timestamp || !hash || !/^sha256=[a-f0-9]{64}$/.test(hash) ||
      !Number.isFinite(age) || age < -60000 || age > 600000) {
    return new Response(null, { status: 403 });
  }
  const body = await request.text();
  const bytes = Uint8Array.from(hash.slice(7).match(/../g)!, pair => parseInt(pair, 16));
  if (!await crypto.subtle.verify('HMAC', await signatureKey, bytes, encoder.encode(id + timestamp + body))) {
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
  if (!emotes) return new Response(null, { status: 204 });

  try {
    const result = await fetch(supabaseUrl + '/rest/v1/rpc/record_twitch_emotes', {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: event.message_id, viewer_id: event.chatter_user_id, emotes }),
      signal: AbortSignal.timeout(2500)
    });
    if (result.ok) return new Response(null, { status: 204 });
    console.warn('Could not record Twitch emotes', result.status);
  } catch {
    console.warn('Twitch emote storage unavailable');
  }
  return new Response(null, { status: 503 });
});
