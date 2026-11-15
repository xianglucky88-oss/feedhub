function text(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

export function parseRss(xml) {
  const items = [];
  for (const block of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []) {
    const guid = text(block, 'guid') || text(block, 'link') || text(block, 'title');
    items.push({
      guid,
      title: text(block, 'title'),
      link: text(block, 'link'),
      published: text(block, 'pubDate'),
      summary: text(block, 'description'),
    });
  }
  return { format: 'rss', items };
}

export function parseFeed(raw) {
  const value = raw.trim();
  if (value.startsWith('{')) throw new Error('JSON Feed is not implemented yet');
  if (/<(?:feed|entry)\b/i.test(value)) throw new Error('Atom is not implemented yet');
  if (/<rss\b/i.test(value)) return parseRss(value);
  throw new Error('unsupported feed format');
}
