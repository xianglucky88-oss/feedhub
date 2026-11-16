import { itemIdentity } from './identity.mjs';

export function stripHtml(value = '') {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize parsed fields into the shape stored in the items table.
 *
 * Normalization is intentionally limited to cosmetic cleanup that must not
 * produce a revision: HTML stripping and date canonicalization. The identity
 * is computed from this normalized value so that it is stable across re-parses.
 */
export function normalizeItem(item) {
  const date = item.published ? new Date(item.published) : null;
  const normalized = {
    ...item,
    title: stripHtml(item.title),
    summary: stripHtml(item.summary),
    link: String(item.link ?? '').trim(),
    published:
      date && !Number.isNaN(date.valueOf()) ? date.toISOString() : String(item.published ?? '').trim(),
  };
  const identity = itemIdentity(normalized);
  return { ...normalized, identity };
}
