import { PageStat, TIME_BUCKET_EDGES } from '../models/PageStat.js';
import { StorefrontDailyStat } from '../models/index.js';
import { cairoDayStart } from './storefrontService.js';

/**
 * Page analytics: how long visitors really stay on each page of the store.
 * Events arrive through POST /api/public/events (page_view carries device,
 * os and source; page_time carries the active seconds). See PageStat.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical page key for a URL path: no query/hash/trailing slash, ids
 * collapsed (/track/<uuid> -> /track), nothing odd accepted. null = ignore.
 */
export function normalizePagePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.split('#')[0].split('?')[0].trim();
  if (!p.startsWith('/') || p.length > 200 || p.includes('..') || p.includes('//')) return null;
  p = p.replace(/\/+$/, '') || '/';
  const segs = p.split('/').filter(Boolean);
  if (segs.length > 3) return null;
  if (!/^[A-Za-z0-9\-_/%.~]*$/.test(p)) return null;
  if (segs[0] === 'track' || segs[0] === 'orders') return `/${segs[0]}`;
  return `/${segs.map((s) => (UUID.test(s) ? ':id' : s)).join('/')}`.replace(/^\/$/, '/');
}

export function pageType(path) {
  if (path === '/') return 'home';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections')) return 'collection';
  if (path === '/checkout') return 'checkout';
  if (path === '/thanks') return 'thanks';
  if (path.startsWith('/track')) return 'track';
  if (path === '/cart') return 'cart';
  if (path.startsWith('/pages')) return 'page';
  if (path.startsWith('/search')) return 'search';
  return 'other';
}

function bucketIndex(seconds) {
  const i = TIME_BUCKET_EDGES.findIndex((edge) => seconds < edge);
  return i === -1 ? TIME_BUCKET_EDGES.length : i;
}

/** Median (seconds) estimated from bucket counts, interpolating inside the bucket. */
export function medianFromBuckets(buckets) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    if (acc + buckets[i] >= half && buckets[i] > 0) {
      const lo = i === 0 ? 0 : TIME_BUCKET_EDGES[i - 1];
      const hi = i < TIME_BUCKET_EDGES.length ? TIME_BUCKET_EDGES[i] : lo * 1.5;
      return Math.round(lo + ((half - acc) / buckets[i]) * (hi - lo));
    }
    acc += buckets[i];
  }
  return null;
}

/** Apply page_view / page_time events of one batch. */
export async function recordPageEvents(events, now = new Date()) {
  const day = cairoDayStart(now);
  const ops = new Map();
  const slot = (path, device, src, title) => {
    const k = `${path}|${device}|${src}`;
    let o = ops.get(k);
    if (!o) {
      o = { filter: { day, path, device, src }, inc: {}, title: '' };
      ops.set(k, o);
    }
    if (title) o.title = title;
    return o;
  };
  const inc = (o, key, n = 1) => {
    o.inc[key] = (o.inc[key] || 0) + n;
  };

  for (const e of events) {
    if (e.type !== 'page_view' && e.type !== 'page_time') continue;
    const path = normalizePagePath(e.path);
    if (!path) continue;
    const device = e.device || 'unknown';
    const src = e.src || 'direct';
    const o = slot(path, device, src, e.title);
    if (e.type === 'page_view') {
      inc(o, 'views');
      if (e.os) inc(o, `os.${e.os}`);
      continue;
    }
    // page_time: `seconds` is the active time not yet reported; a final report
    // (part=false) also carries the visit's `total` and where it went next.
    if (e.part) continue;
    const total = e.total ?? e.seconds;
    inc(o, 'timed');
    inc(o, 'visitSeconds', total);
    inc(o, `t${bucketIndex(total)}`);
    if (e.cont === false) inc(o, 'exits');
    if (typeof e.scroll === 'number') {
      inc(o, 'scrollSum', e.scroll);
      inc(o, 'scrollN');
    }
  }
  if (!ops.size) return;
  await PageStat.bulkWrite(
    [...ops.values()].map((o) => ({
      updateOne: {
        filter: o.filter,
        update: { $inc: o.inc, ...(o.title ? { $set: { title: o.title } } : {}) },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

const RANGE_DAYS = { today: 0, '7d': 6, '30d': 29, '90d': 89 };

/** Table of every page with its numbers, plus device / source / funnel summaries. */
export async function getPageStats({ range = '7d', device, src, type } = {}, now = new Date()) {
  const from = cairoDayStart(now, RANGE_DAYS[range] ?? 6);
  const match = { day: { $gte: from } };
  if (device) match.device = device;
  if (src) match.src = src;

  const rows = await PageStat.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$path',
        title: { $last: '$title' },
        views: { $sum: '$views' },
        timed: { $sum: '$timed' },
        visitSeconds: { $sum: '$visitSeconds' },
        exits: { $sum: '$exits' },
        scrollSum: { $sum: '$scrollSum' },
        scrollN: { $sum: '$scrollN' },
        b0: { $sum: '$t0' },
        b1: { $sum: '$t1' },
        b2: { $sum: '$t2' },
        b3: { $sum: '$t3' },
        b4: { $sum: '$t4' },
        b5: { $sum: '$t5' },
        b6: { $sum: '$t6' },
      },
    },
  ]);
  const [byDevice, bySrc, byOs, adds] = await Promise.all([
    PageStat.aggregate([{ $match: match }, { $group: { _id: '$device', views: { $sum: '$views' } } }]),
    PageStat.aggregate([{ $match: match }, { $group: { _id: '$src', views: { $sum: '$views' } } }]),
    PageStat.aggregate([
      { $match: match },
      { $group: { _id: null, android: { $sum: '$os.android' }, ios: { $sum: '$os.ios' }, windows: { $sum: '$os.windows' }, mac: { $sum: '$os.mac' }, other: { $sum: '$os.other' } } },
    ]),
    StorefrontDailyStat.aggregate([{ $match: { day: { $gte: from } } }, { $group: { _id: '$slug', adds: { $sum: '$adds' } } }]),
  ]);
  const addsBySlug = new Map(adds.map((a) => [a._id, a.adds]));

  let pages = rows.map((r) => {
    const buckets = [r.b0, r.b1, r.b2, r.b3, r.b4, r.b5, r.b6];
    const t = pageType(r._id);
    const slug = t === 'product' ? r._id.slice('/products/'.length) : null;
    const added = slug ? addsBySlug.get(slug) || addsBySlug.get(decodeURIComponent(slug)) || 0 : null;
    return {
      path: r._id,
      title: r.title,
      type: t,
      views: r.views,
      timed: r.timed,
      avgSeconds: r.timed ? Math.round(r.visitSeconds / r.timed) : null,
      medianSeconds: medianFromBuckets(buckets),
      quickLeaveRate: r.timed ? Math.round((r.b0 / r.timed) * 100) : null,
      exitRate: r.timed ? Math.round((r.exits / r.timed) * 100) : null,
      avgScroll: r.scrollN ? Math.round(r.scrollSum / r.scrollN) : null,
      adds: added,
      addRate: added !== null && r.views ? Math.round((added / r.views) * 100) : null,
      lowSample: r.timed < 30,
    };
  });
  if (type) pages = pages.filter((p) => p.type === type);
  pages.sort((a, b) => (b.views || 0) - (a.views || 0));

  const viewsOf = (pred) => rows.filter((r) => pred(r._id)).reduce((n, r) => n + r.views, 0);
  const funnel = {
    home: viewsOf((p) => p === '/'),
    products: viewsOf((p) => p.startsWith('/products/')),
    checkout: viewsOf((p) => p === '/checkout'),
    thanks: viewsOf((p) => p === '/thanks'),
  };
  return {
    range,
    from,
    pages,
    funnel,
    devices: Object.fromEntries(byDevice.map((d) => [d._id, d.views])),
    sources: Object.fromEntries(bySrc.map((d) => [d._id, d.views])),
    os: byOs[0] ? (({ _id, ...o }) => o)(byOs[0]) : {},
  };
}
