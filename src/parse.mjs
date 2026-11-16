const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// CDATA is literal text: entities inside it must not be decoded. Decode only
// the text that sits outside CDATA sections.
function extractText(raw) {
  let out = '';
  let cursor = 0;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match;
  while ((match = cdata.exec(raw)) !== null) {
    out += decodeEntities(raw.slice(cursor, match.index));
    out += match[1];
    cursor = match.index + match[0].length;
  }
  out += decodeEntities(raw.slice(cursor));
  return out;
}

function text(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? extractText(match[1]).trim() : '';
}

/**
 * Parse RSS 2.0 into raw item records.
 *
 * `guid` is intentionally kept as the raw guid (possibly ''). Falling back to
 * link/title here would conflate "stable identity" with "content", so identity
 * derivation is a separate concern (see identity.mjs).
 */
export function parseRss(xml) {
  const items = [];
  for (const block of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []) {
    items.push({
      guid: text(block, 'guid'),
      title: text(block, 'title'),
      link: text(block, 'link'),
      published: text(block, 'pubDate'),
      summary: text(block, 'description'),
    });
  }
  return { format: 'rss', items };
}

export function parseFeed(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('feed response is empty');
  }
  const value = raw.trim();
  if (value.startsWith('{')) throw new Error('JSON Feed is not implemented yet');
  if (/<(?:feed|entry)\b/i.test(value)) throw new Error('Atom is not implemented yet');
  if (/<rss\b/i.test(value)) return parseRss(value);
  throw new Error('unsupported feed format');
}
