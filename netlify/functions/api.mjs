/**
 * Netlify Function: tum /api/* ve /auth/* istekleri buraya duser.
 * Veriler Netlify Blobs'ta tutulur — ek servis, hesap veya API anahtari gerekmez.
 */

import { createApi } from '../../core/api.mjs';
import { autoStore } from '../../core/store.mjs';

export const config = {
  path: ['/api/*', '/auth/*']
};

let apiPromise;
function getApi() {
  if (!apiPromise) apiPromise = autoStore().then(createApi);
  return apiPromise;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export default async function handler(request) {
  const url = new URL(request.url);

  // Islev hem dogrudan yol eslesmesiyle hem yonlendirmeyle cagrilabilir.
  let path = url.pathname.replace(/^\/\.netlify\/functions\/api/, '');
  if (!path.startsWith('/api') && !path.startsWith('/auth')) path = `/api${path}`;

  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text) {
      try { body = JSON.parse(text); } catch {
        return new Response(JSON.stringify({ error: 'Gecersiz JSON.' }), { status: 400, headers: JSON_HEADERS });
      }
    }
  }

  const api = await getApi();
  const result = await api(request.method, `${path}${url.search}`, body, {
    authorization: request.headers.get('authorization') || ''
  });

  return new Response(JSON.stringify(result.body), { status: result.status, headers: JSON_HEADERS });
}
