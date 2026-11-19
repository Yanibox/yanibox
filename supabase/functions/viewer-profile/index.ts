import { generateAuthenticationOptions, verifyAuthenticationResponse } from 'npm:@simplewebauthn/server@14.1.0';
import { argon2idAsync } from 'npm:@noble/hashes@2.0.1/argon2.js';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const origin = new URL(Deno.env.get('YANIBOX_PROFILE_ORIGIN') || 'https://yanibox.github.io').origin;
const rpID = new URL(origin).hostname;
const database = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const random = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)));
const sha256 = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const base64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const recoveryCode = /^[a-f0-9]{32}$/;
const loginName = /^[a-zа-яё0-9_]{3,24}$/;
const dummySalt = crypto.getRandomValues(new Uint8Array(16));
const sessionCode = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-viewer-session',
  'Vary': 'Origin',
  'Cache-Control': 'no-store',
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });

class RequestError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

function result<T>({ data, error }: { data: T; error: unknown }) {
  if (error) throw error;
  return data;
}

async function rpc(name: string, args: Record<string, unknown>) {
  return result(await database.rpc(name, args));
}

async function rateLimit(request: Request, group: string, account?: string) {
  const subject = account || request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (!await rpc('yanibox_limit', { bucket_key: await sha256(secret + ':' + group + ':' + subject) })) {
    throw new RequestError('rate-limit', 429);
  }
}

let appToken: { value: string; expiresAt: number } | undefined;

async function twitchUser(query: URLSearchParams) {
  const clientId = Deno.env.get('TWITCH_CLIENT_ID');
  const clientSecret = Deno.env.get('TWITCH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new RequestError('twitch-unavailable', 503);
  if (!appToken || appToken.expiresAt <= Date.now()) {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new RequestError('twitch-unavailable', 503);
    const data = await response.json();
    appToken = { value: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
  }
  const response = await fetch('https://api.twitch.tv/helix/users?' + query, {
    headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + appToken.value },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) appToken = undefined;
  if (!response.ok) throw new RequestError('twitch-unavailable', 503);
  const user = (await response.json()).data?.[0];
  return user && /^[0-9]{1,25}$/.test(user.id) && /^[a-z0-9_]{1,25}$/.test(user.login)
    ? { id: String(user.id), login: String(user.login) } : null;
}

async function beginLegacyLogin() {
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const saved = result(await database.from('yanibox_challenges').insert({
    purpose: 'login', challenge: options.challenge,
  }).select('id').single());
  if (!saved) throw new RequestError('unavailable', 503);
  return { id: saved.id, options };
}

async function finishLegacyLogin(body: Record<string, unknown>) {
  if (typeof body.id !== 'string' || !uuid.test(body.id) || !body.response || typeof body.response !== 'object') {
    throw new RequestError('passkey');
  }
  const challenge = result(await database.from('yanibox_challenges').delete()
    .eq('id', body.id).eq('purpose', 'login').gt('expires_at', new Date().toISOString())
    .select().maybeSingle());
  if (!challenge) throw new RequestError('passkey');
  const session = random(32);
  const assertion = body.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'];
  if (typeof assertion.id !== 'string' || assertion.id.length > 1024) throw new RequestError('passkey');
  const saved = result(await database.from('yanibox_passkeys').select('*').eq('id', assertion.id).maybeSingle());
  if (!saved || assertion.response?.userHandle !== base64url(saved.profile_id)) throw new RequestError('passkey');
  const verified = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: {
      id: saved.id, publicKey: Uint8Array.from(atob(saved.public_key), char => char.charCodeAt(0)),
      counter: saved.counter, transports: saved.transports,
    },
  }).catch(() => { throw new RequestError('passkey'); });
  if (!verified.verified || !await rpc('yanibox_finish_login', {
    key_id: saved.id, key_bytes: saved.public_key, previous_counter: saved.counter,
    next_counter: verified.authenticationInfo.newCounter, session_hash: await sha256(session),
  })) throw new RequestError('passkey');
  return { session };
}

async function passwordVerifier(password: string, salt: Uint8Array) {
  const digest = await argon2idAsync(encoder.encode(password), salt, { m: 19456, t: 2, p: 1, dkLen: 32 });
  return 'argon2id-1:' + hex(salt) + ':' + hex(digest);
}

async function passwordAction(action: string, request: Request, body: Record<string, unknown>, previousSession: string | null = null) {
  const name = typeof body.login === 'string' ? body.login.trim().normalize('NFC') : '';
  const login = name.toLowerCase();
  if (!loginName.test(login)) throw new RequestError(action === 'password-login' ? 'credentials' : 'invalid-login');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    throw new RequestError(action === 'password-login' ? 'credentials' : 'invalid-password');
  }
  await rateLimit(request, 'password');
  const session = random(32);
  const sessionHash = await sha256(session);
  if (action === 'password-login') {
    await rateLimit(request, 'password-account', login);
    const profile = result(await database.from('yanibox_profiles').select('password_hash').eq('login', login).maybeSingle());
    const stored = profile?.password_hash as string | undefined;
    const rawSalt = stored?.split(':')[1];
    const salt = rawSalt ? Uint8Array.from(rawSalt.match(/../g)!, byte => parseInt(byte, 16)) : dummySalt;
    const verifier = await passwordVerifier(body.password, salt);
    if (!stored || !timingSafeEqual(encoder.encode(stored), encoder.encode(verifier)) ||
       !await rpc('yanibox_login_password', { handle: login, verifier, session_hash: sessionHash })) {
      throw new RequestError('credentials');
    }
    return { session };
  }
  let legacyCode = null;
  if (action === 'password-upgrade-recovery') {
    if (typeof body.recovery !== 'string' || !recoveryCode.test(body.recovery)) throw new RequestError('invalid-recovery');
    legacyCode = await sha256(body.recovery);
  }
  const verifier = await passwordVerifier(body.password, crypto.getRandomValues(new Uint8Array(16)));
  if (action === 'password-register') {
    if (!await rpc('yanibox_register_password', { handle: login, name, verifier, session_hash: sessionHash })) {
      throw new RequestError('login-taken', 409);
    }
    return { session };
  }
  try {
    if (!await rpc('yanibox_upgrade_password', {
      handle: login, verifier, new_session: sessionHash, previous_session: previousSession, legacy_code: legacyCode,
    })) throw new RequestError(legacyCode ? 'invalid-recovery' : 'invalid-upgrade');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new RequestError('login-taken', 409);
    throw error;
  }
  return { session };
}

const fields = 'id,display_name,twitch_id,twitch_login,login';

async function accountAction(action: string, request: Request, body: Record<string, unknown>) {
  const token = request.headers.get('x-viewer-session');
  if (!token || !sessionCode.test(token)) throw new RequestError('session', 401);
  const tokenHash = await sha256(token);
  const session = result(await database.from('yanibox_sessions').select('profile_id')
    .eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).maybeSingle());
  if (!session) throw new RequestError('session', 401);
  const id = session.profile_id;
  const profile = result(await database.from('yanibox_profiles').select(fields).eq('id', id).maybeSingle());
  if (!profile) throw new RequestError('session', 401);

  switch (action) {
    case 'profile': {
      return { name: profile.display_name, twitch: profile.twitch_login, needsPassword: !profile.login };
    }
    case 'password-upgrade':
      if (profile.login) throw new RequestError('invalid-upgrade');
      return passwordAction(action, request, body, tokenHash);
    case 'refresh-twitch': {
      if (!profile.twitch_id) return { twitch: null };
      await rateLimit(request, action, id);
      const user = await twitchUser(new URLSearchParams({ id: profile.twitch_id }));
      if (user && user.login !== profile.twitch_login) {
        result(await database.from('yanibox_profiles').update({ twitch_login: user.login })
          .eq('id', id).eq('twitch_id', profile.twitch_id));
      }
      return { twitch: user?.login ?? profile.twitch_login };
    }
    case 'link': {
      const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
      if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new RequestError('invalid-twitch');
      await rateLimit(request, action, id);
      const user = await twitchUser(new URLSearchParams({ login }));
      if (!user) throw new RequestError('invalid-twitch');
      const code = random(8);
      if (!await rpc('yanibox_start_link', { account_id: id, digest: await sha256(code), target_twitch_id: user.id })) {
        throw new RequestError('already-linked', 409);
      }
      return { code };
    }
    case 'emotes':
      return { count: await rpc('yanibox_emotes', { account_id: id }) };
    case 'ratings':
      return { ratings: await rpc('yanibox_private_ratings', { account_id: id }) };
    case 'vote': {
      if (!profile.twitch_id) throw new RequestError('link-required', 403);
      if (!Number.isInteger(body.score) || Number(body.score) < 1 || Number(body.score) > 10 ||
        typeof body.movie !== 'string' || body.movie.length > 150) throw new RequestError('invalid-vote');
      const rating = await rpc('yanibox_vote', { account_id: id, movie_id: body.movie, rating: body.score });
      if (!rating) throw new RequestError('invalid-vote');
      return { rating };
    }
    case 'logout':
      result(await database.from('yanibox_sessions').delete().eq('token_hash', tokenHash));
      return {};
    case 'unlink':
    case 'delete':
      await rpc('yanibox_remove_link', { account_id: id, delete_profile: action === 'delete' });
      return {};
    default:
      throw new RequestError('unknown', 404);
  }
}

Deno.serve(async request => {
  if (request.headers.get('Origin') !== origin) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET') {
    return new Response(null, {
      status: Deno.env.get('TWITCH_CLIENT_ID') && Deno.env.get('TWITCH_CLIENT_SECRET') ? 204 : 503,
      headers: cors,
    });
  }
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  try {
    if (Number(request.headers.get('content-length')) > 24000) throw new RequestError('size', 413);
    const raw = await request.text();
    if (raw.length > 24000) throw new RequestError('size', 413);
    const body = JSON.parse(raw);
    if (!body || typeof body.action !== 'string') throw new RequestError('invalid');
    if (body.action === 'login-begin' || body.action === 'login-finish') {
      await rateLimit(request, 'passkey');
      return json(await (body.action === 'login-begin' ? beginLegacyLogin() : finishLegacyLogin(body)));
    }
    if (['password-login', 'password-register', 'password-upgrade-recovery'].includes(body.action)) {
      return json(await passwordAction(body.action, request, body));
    }
    return json(await accountAction(body.action, request, body));
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'invalid' }, 400);
    console.warn('Viewer profile request failed');
    return json({ error: 'unavailable' }, 503);
  }
});
