import { createHash } from 'node:crypto';

export const IDENTITY_SCHEME_VERSION = 1;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Query parameters that describe how a reader found a link, not which item it
// is. They must not affect identity or revision detection.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_reader', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
  'ref', 'ref_src', 'source',
]);

export function normalizeLink(link = '') {
  const value = String(link).trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value;
  }
}

export function normalizeGuid(guid = '') {
  return String(guid).trim();
}

function compactTitle(title) {
  return String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable identity for one item.
 *
 * Rules, in priority order:
 *
 * 1. A non-empty guid is authoritative. Identity is derived from the guid
 *    alone, so editing the body of an item never changes its identity.
 * 2. Without a guid, a normalized link is the anchor. Title is mixed in so
 *    that two distinct items sharing a link do not collide, but a link-only
 *    lookup still reconciles title edits onto the same row.
 * 3. Without guid or link, title + published date is the best available
 *    anchor. This is explicitly weak: editing either field can fork the item.
 * 4. With none of the above, the summary itself is the identity.
 *
 * `weaklyIdentified` marks rules 3 and 4 so callers can surface the risk
 * instead of silently forking history.
 */
export function itemIdentity(item) {
  const guid = normalizeGuid(item.guid);
  const linkKey = normalizeLink(item.link);
  const title = compactTitle(item.title);
  const published = String(item.published ?? '').trim();

  if (guid) {
    return {
      scheme: IDENTITY_SCHEME_VERSION,
      key: `g:1:${sha256(guid).slice(0, 40)}`,
      kind: 'guid',
      guid: guid || null,
      linkKey,
      weaklyIdentified: false,
      note: 'guid',
    };
  }

  if (linkKey) {
    return {
      scheme: IDENTITY_SCHEME_VERSION,
      key: `l:1:${sha256(`${linkKey}\u0000${title}`).slice(0, 40)}`,
      kind: 'link',
      guid: null,
      linkKey,
      weaklyIdentified: false,
      note: 'link+title; reconciled by link',
    };
  }

  if (title || published) {
    return {
      scheme: IDENTITY_SCHEME_VERSION,
      key: `t:1:${sha256(`${title}\u0000${published}`).slice(0, 40)}`,
      kind: 'title',
      guid: null,
      linkKey: '',
      weaklyIdentified: true,
      note: 'title+published; edits can fork identity',
    };
  }

  return {
    scheme: IDENTITY_SCHEME_VERSION,
    key: `h:1:${sha256(String(item.summary ?? '').slice(0, 4096)).slice(0, 40)}`,
    kind: 'hash',
    guid: null,
    linkKey: '',
    weaklyIdentified: true,
    note: 'content only; any edit forks identity',
  };
}

export function guidOf(item) {
  const guid = normalizeGuid(item.guid);
  return guid ? guid : null;
}
