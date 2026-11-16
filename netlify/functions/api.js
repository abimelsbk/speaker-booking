/*
 * Netlify Function serving every /api/* route.
 * Bookings are stored as one JSON document in Netlify Blobs (store "bookings",
 * key "db"); writes use the blob's ETag so two people can't grab the same slot.
 *
 * Required environment variable (Site configuration → Environment variables):
 *   ADMIN_PASSWORD — password for /admin
 */

import { getStore } from '@netlify/blobs';
import siteConfig from '../../config.json' with { type: 'json' };
import { createApi } from '../../lib/core.js';

const EMPTY_DB = () => ({ bookings: [], blocks: [] });
const store = () => getStore({ name: 'bookings', consistency: 'strong' });

const storage = {
  async read() {
    const entry = await store().getWithMetadata('db', { type: 'json' });
    if (!entry) return { db: EMPTY_DB(), version: null };
    // Production Blobs returns an ETag; if one is ever missing, write
    // unconditionally and rely on core.js reading the result back.
    return { db: { ...EMPTY_DB(), ...entry.data }, version: entry.etag || 'no-etag' };
  },
  async write(db, version) {
    const opts = version === null ? { onlyIfNew: true } : version === 'no-etag' ? {} : { onlyIfMatch: version };
    const { modified } = await store().setJSON('db', db, opts);
    return modified;
  },
};

const handle = createApi({
  getConfig: () => siteConfig,
  storage,
  adminPassword: process.env.ADMIN_PASSWORD,
  log: (msg) => console.log(msg),
});

export default async (request, context) => handle(request, { ip: context.ip || 'unknown' });

export const config = { path: '/api/*' };
