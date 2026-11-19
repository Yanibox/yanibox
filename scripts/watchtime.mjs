const portal = new URL('https://yanibox.streaming.lv/');
const leaderboard = new URL('?channel_tops&type=uptime&period=global', portal);
const periods = ['global', 'month', 'week'];
const pageSize = 250;

async function portalRequest(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('WizeBot returned HTTP ' + response.status);
  return response;
}

async function openLeaderboard() {
  const response = await portalRequest(leaderboard);
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
    .find(value => value.startsWith('wizebot_network='));
  await response.body.cancel();
  if (!cookie) throw new Error('WizeBot public session unavailable');

  const headers = { cookie, referer: leaderboard.href, 'X-Requested-With': 'XMLHttpRequest' };
  const section = await portalRequest(new URL('ajax.php', portal), {
    method: 'POST', headers,
    body: new URLSearchParams({
      p: 'channel_tops', 'request[channel_tops]': '', 'request[type]': 'uptime', 'request[period]': 'global'
    })
  });
  const html = await section.text();
  // The public leaderboard provides a short-lived lookup parameter in its page fragment.
  const path = html.match(/ajax\/list\/top_viewers\.php\?t=[a-f0-9]+(?=[&"])/)?.[0];
  if (!path) throw new Error('WizeBot public leaderboard unavailable');
  return { url: new URL(path, portal), headers, html };
}

async function fetchPeriod(source, period, category = 'uptime') {
  if (!source.html.includes('data-period_key="' + period + '"') ||
      !source.html.includes('data-categ_key="' + category + '"')) {
    throw new Error('WizeBot period unavailable');
  }

  const viewers = [];
  let total;
  do {
    const url = new URL(source.url);
    url.searchParams.set('top_categ', category);
    url.searchParams.set('top_period', period);
    url.searchParams.set('start', viewers.length);
    url.searchParams.set('length', pageSize);
    const response = await portalRequest(url, { headers: source.headers });
    const { data, recordsTotal } = await response.json();
    total ??= recordsTotal;
    if (!Number.isSafeInteger(total) || total < 0 || total > 25000 || recordsTotal !== total ||
        !Array.isArray(data) || data.length !== Math.min(pageSize, total - viewers.length)) {
      throw new Error('WizeBot leaderboard changed while reading');
    }
    for (const [rank, name, value] of data) {
      const count = Number(value);
      if (rank !== viewers.length + 1 || typeof name !== 'string' || !/^[a-z0-9_]{1,25}$/i.test(name) ||
          !/^\d+$/.test(String(value)) || !Number.isSafeInteger(count)) {
        throw new Error('Unexpected WizeBot viewer record');
      }
      viewers.push(category === 'uptime' ? { name, seconds: count } : { name, count });
    }
  } while (viewers.length < total);
  if (new Set(viewers.map(row => row.name.toLowerCase())).size !== total) {
    throw new Error('WizeBot leaderboard changed while reading');
  }
  return { updatedAt: new Date().toISOString(), viewers };
}

export async function buildWatchtime(cacheUrl) {
  let source;
  try {
    source = await openLeaderboard();
  } catch {
    console.warn('WizeBot public leaderboard is temporarily unavailable.');
  }

  const results = source
    ? await Promise.allSettled([...periods.map(period => fetchPeriod(source, period)), fetchPeriod(source, 'global', 'message')])
    : [];
  const snapshot = { periods: {} };
  const failed = [];
  for (const [index, period] of periods.entries()) {
    const result = results[index];
    if (result?.status === 'fulfilled') {
      snapshot.periods[period] = result.value;
      console.log(`WizeBot ${period}: ${result.value.viewers.length} viewers.`);
    } else {
      failed.push(period);
    }
  }
  if (failed.length) console.warn('WizeBot periods unavailable: ' + failed.join(', '));
  const messages = results[periods.length];
  if (messages?.status === 'fulfilled') {
    snapshot.messages = messages.value;
    console.log(`WizeBot chat messages: ${snapshot.messages.viewers.length} viewers.`);
  } else {
    console.warn('WizeBot chat message counts unavailable.');
  }
  if ((failed.length || !snapshot.messages) && cacheUrl) {
    try {
      const response = await fetch(cacheUrl, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const previous = await response.json();
        for (const period of failed) {
          const entry = previous.periods?.[period];
          if (entry) snapshot.periods[period] = { ...entry, stale: true };
        }
        if (!snapshot.messages && previous.messages) snapshot.messages = { ...previous.messages, stale: true };
      }
    } catch {
      console.warn('Previous WizeBot data is unavailable.');
    }
  }
  return snapshot;
}
