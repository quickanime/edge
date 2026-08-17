/**
 * Anahtar/deger deposu. Iki uygulama:
 *  - Netlify Blobs  (uretim: netlify uzerinde, ek servis veya anahtar gerekmez)
 *  - dosya sistemi  (yerel gelistirme)
 *
 * Sozlesme: get(key) -> nesne|null, set(key, value), del(key), list(prefix) -> anahtarlar
 */

export function memoryStore() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    async set(key, value) { map.set(key, JSON.stringify(value)); },
    async del(key) { map.delete(key); },
    async list(prefix) { return [...map.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  };
}

export async function blobStore(name = 'edge') {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name, consistency: 'strong' });
  return {
    async get(key) {
      try { return await store.get(key, { type: 'json' }); } catch { return null; }
    },
    async set(key, value) { await store.setJSON(key, value); },
    async del(key) { await store.delete(key); },
    async list(prefix) {
      const res = await store.list({ prefix });
      return res.blobs.map((b) => b.key).sort();
    }
  };
}

export async function fileStore(dir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(dir, { recursive: true });

  const toPath = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);

  return {
    async get(key) {
      try { return JSON.parse(await fs.readFile(toPath(key), 'utf8')); } catch { return null; }
    },
    async set(key, value) {
      const file = toPath(key);
      const tmp = `${file}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file);
    },
    async del(key) {
      try { await fs.unlink(toPath(key)); } catch { /* yoksa sorun degil */ }
    },
    async list(prefix) {
      const names = await fs.readdir(dir);
      return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => decodeURIComponent(n.slice(0, -5)))
        .filter((k) => k.startsWith(prefix))
        .sort();
    }
  };
}

/** Ortama gore dogru depoyu sec. */
export async function autoStore() {
  if (process.env.EDGE_STORE === 'memory') return memoryStore();
  if (process.env.NETLIFY || process.env.EDGE_STORE === 'blobs') return blobStore();
  const dir = process.env.EDGE_DATA_DIR || new URL('../data/store', import.meta.url).pathname;
  return fileStore(dir);
}
