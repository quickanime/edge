/**
 * Netlify Function: tum /api/* ve /auth/* istekleri buraya duser.
 *
 * Yonlendirme netlify.toml'daki rewrite kurallariyla yapilir; boylece islev
 * her zaman /.netlify/functions/api adresinde durur ve yol bilgisi URL'de
 * tasinir. Veriler Netlify Blobs'ta saklanir — ek servis veya anahtar gerekmez.
 */

import { createApi } from '../../core/api.mjs';
import { blobStore } from '../../core/store.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

let apiPromise;
function getApi() {
  if (!apiPromise) apiPromise = blobStore('edge').then(createApi);
  return apiPromise;
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export default async function handler(request) {
  const url = new URL(request.url);

  // Yol, islev adresinin ardindan gelir: /.netlify/functions/api/api/companies
  let path = url.pathname.replace(/^\/\.netlify\/functions\/api/, '');
  if (!path.startsWith('/api') && !path.startsWith('/auth')) path = `/api${path}`;

  // Basit sağlık kontrolu: yayinin ve deponun ayakta oldugunu dogrular.
  if (path === '/api/health') {
    try {
      const store = await blobStore('edge');
      const probe = `health/${Date.now().toString(36)}`;
      await store.set(probe, { ok: true });
      const back = await store.get(probe);
      await store.del(probe);
      return reply(200, { ok: true, store: back && back.ok ? 'blobs' : 'broken', runtime: 'netlify' });
    } catch (err) {
      return reply(500, { ok: false, error: `Store error: ${err.message}` });
    }
  }

  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text.length > 8_000_000) return reply(413, { error: 'Request body is too large.' });
    if (text) {
      try { body = JSON.parse(text); } catch { return reply(400, { error: 'Invalid JSON.' }); }
    }
  }

  try {
    const api = await getApi();
    const result = await api(request.method, `${path}${url.search}`, body, {
      authorization: request.headers.get('authorization') || '',
      'x-nf-client-connection-ip': request.headers.get('x-nf-client-connection-ip') || '',
      'x-forwarded-for': request.headers.get('x-forwarded-for') || ''
    });
    return reply(result.status, result.body);
  } catch (err) {
    console.error('edge islev hatasi:', err);
    return reply(500, { error: 'Server error.' });
  }
}
