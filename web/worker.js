// Shared songs. A share is frozen: POST stores a copy under a fresh random id and nothing ever
// changes it, so whoever opens the link remixes their own copy. Everything else is the static app.
const MAX_BYTES = 8 * 1024 * 1024; // a song plus six 8-second voice clips fits easily
const ID = /^[a-z0-9]{10}$/;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

function newId() {
  const abc = 'abcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => abc[b % abc.length]).join('');
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);

    if (pathname === '/api/songs' && req.method === 'POST') {
      if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'too big' }, 413);
      const body = await req.text();
      if (body.length > MAX_BYTES) return json({ error: 'too big' }, 413);
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return json({ error: 'not json' }, 400);
      }
      // The app validates the song itself when it opens one; here only the shape is checked.
      if (data?.song?.v !== 3 || typeof data.clips !== 'object' || data.clips === null) return json({ error: 'not a song' }, 400);
      const id = newId();
      await env.SONGS.put(id, body);
      return json({ id }, 201);
    }

    const m = pathname.match(/^\/api\/songs\/([^/]+)$/);
    if (m && req.method === 'GET') {
      if (!ID.test(m[1])) return json({ error: 'not found' }, 404);
      const body = await env.SONGS.get(m[1]);
      if (!body) return json({ error: 'not found' }, 404);
      return new Response(body, {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};
