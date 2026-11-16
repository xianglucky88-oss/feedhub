import { normalizeLink, sha256 } from './identity.mjs';

export const VERSION_POLICY = 'v1';
export const VERSION_POLICY_DESCRIPTION =
  'A new version is created only when the material projection of an item ' +
  '(title, link, summary text) changes. Cosmetic changes (whitespace, HTML ' +
  'markup, entity encoding, published-date reformatting) update the stored ' +
  'payload in place but do not create a version or a notification.';

/**
 * Material projection: what a subscriber cares about.
 *
 * Deliberately excludes:
 * - `published`, because feeds routinely reformat or backfill dates without
 *   the content changing;
 * - tracking query params and trailing slashes on the link, which do not
 *   change which page the item points at.
 */
export function materialProjection(item) {
  return {
    title: String(item.title ?? '').replace(/\s+/g, ' ').trim(),
    link: normalizeLink(item.link),
    summary: String(item.summary ?? '').replace(/\s+/g, ' ').trim(),
  };
}

export function payloadProjection(item) {
  return {
    title: String(item.title ?? ''),
    link: String(item.link ?? ''),
    summary: String(item.summary ?? ''),
    published: String(item.published ?? ''),
  };
}

export function contentHashes(item) {
  const material = materialProjection(item);
  const payload = payloadProjection(item);
  return {
    contentHash: sha256(JSON.stringify(material)),
    payloadHash: sha256(JSON.stringify(payload)),
    material,
    payload,
  };
}

/**
 * Decide what an observation of an item means relative to the stored row.
 *
 * Returns one of:
 *  - `new`        : first time this identity is seen
 *  - `revision`   : material content changed -> new version + update event
 *  - `metadata`   : only non-material fields changed -> update row, no event
 *  - `unchanged`  : byte-for-byte the same payload
 *  - `conflict`   : same identity, but non-material fields arrived with a
 *                   different guide/link in a way we cannot safely absorb
 *                   (currently reported, treated as metadata)
 */
export function classify(existing, incoming, identity) {
  const hashes = contentHashes(incoming);
  if (!existing) {
    return { kind: 'new', version: 1, ...hashes, identity };
  }
  if (existing.content_hash === hashes.contentHash) {
    if (existing.payload_hash === hashes.payloadHash) {
      return { kind: 'unchanged', version: existing.version, ...hashes, identity };
    }
    return { kind: 'metadata', version: existing.version, ...hashes, identity };
  }
  return { kind: 'revision', version: existing.version + 1, ...hashes, identity };
}
