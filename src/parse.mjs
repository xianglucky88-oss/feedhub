// 多格式 feed 解析入口。
// 职责边界：本文件只做“忠实提取”——按各格式规范把字段搬进统一的中性中间结构；
// canonical id 优先级、URL 规范化、日期校验、HTML 剥离、空条目与重复处理
// 全部集中在 normalize.mjs，避免解析与归一化两套逻辑再次分散。
//
// 中间条目结构（字段缺失一律为 ''，不用 undefined，方便下游统一处理）：
//   id          各格式声明的稳定标识（rss guid / atom id / json id），可能为空
//   idPermanent rss guid 的 isPermaLink=false 等“该 id 不是 URL”的显式声明
//   title / link / published / updated
//   summary     摘要（description / summary / json summary，可能是 HTML）
//   content     正文（content:encoded / atom content / json content_html）
//   authors     作者名列表
//   links       Atom 的多链接候选（{href, rel, type}），供归一化挑选
//   sourceFormat 来源格式，仅用于诊断

import { documentElement, childElements, firstChild, findDescendants, attr, textOf, innerHtml } from './xml-parser.mjs';

const blank = {
  id: '',
  idPermanent: true,
  title: '',
  link: '',
  published: '',
  updated: '',
  summary: '',
  content: '',
  authors: [],
  links: [],
  sourceFormat: '',
};

function readHtmlElement(node) {
  if (!node) return '';
  const type = attr(node, 'type').toLowerCase();
  if (type === 'xhtml') {
    // type="xhtml" 时内容是一个带命名空间的 div，需要保留嵌套标签。
    const wrapper = firstChild(node);
    return wrapper ? innerHtml(wrapper) : textOf(node);
  }
  // text / html / 默认（Atom 默认是 text）都直接取转义后的文本。
  return textOf(node);
}

function parseRssLike(root) {
  // RSS 2.0：根 rss > channel > item；RSS 1.0：根 rdf:RDF 下 item 为直接子元素。
  const channel = firstChild(root, 'channel');
  const itemNodes = channel
    ? childElements(channel, 'item')
    : childElements(root, 'item');

  const items = itemNodes.map((node) => {
    const guidNode = firstChild(node, 'guid');
    const contentNode = childElements(node, 'encoded')
      .find((candidate) => candidate.name.includes(':')) || null;
    const linkNode = firstChild(node, 'link');
    const authors = childElements(node, 'creator')
      .map((author) => textOf(author).trim())
      .filter(Boolean);
    const authorNode = firstChild(node, 'author');
    if (authorNode) {
      const fallback = textOf(authorNode).trim();
      if (fallback) authors.push(fallback);
    }
    return {
      ...blank,
      sourceFormat: 'rss',
      id: textOf(guidNode).trim(),
      // isPermaLink 缺省视为 true；显式 false 表示 guid 是不透明标识而非 URL。
      idPermanent: guidNode ? attr(guidNode, 'isPermaLink', 'true').toLowerCase() !== 'false' : true,
      title: textOf(firstChild(node, 'title')).trim(),
      link: textOf(linkNode).trim() || attr(node, 'about'),
      published: textOf(firstChild(node, 'pubDate')).trim() ||
        textOf(firstChild(node, 'date')).trim(),
      updated: textOf(firstChild(node, 'date')).trim(),
      summary: textOf(firstChild(node, 'description')).trim(),
      content: contentNode ? textOf(contentNode).trim() : '',
      authors,
    };
  });

  const meta = channel ? { title: textOf(firstChild(channel, 'title')).trim(), link: textOf(firstChild(channel, 'link')).trim() } : { title: '', link: '' };
  return { format: 'rss', meta, items };
}

function parseAtom(root) {
  const linkOf = (node) => {
    // Atom 规范：缺省 rel 即 alternate；缺省 type 视为 text/html。
    const links = childElements(node, 'link').map((link) => ({
      href: attr(link, 'href'),
      rel: attr(link, 'rel') || 'alternate',
      type: attr(link, 'type') || 'text/html',
    }));
    const alternate = links.find((link) => link.rel === 'alternate' && (!link.type || link.type === 'text/html'))
      || links.find((link) => link.rel === 'alternate')
      || links[0];
    return { links, href: alternate ? alternate.href : '' };
  };

  const authorOf = (node) => childElements(node, 'author')
    .map((author) => textOf(firstChild(author, 'name')).trim())
    .filter(Boolean);

  const items = childElements(root, 'entry').map((node) => {
    const { links, href } = linkOf(node);
    return {
      ...blank,
      sourceFormat: 'atom',
      id: textOf(firstChild(node, 'id')).trim(),
      title: textOf(firstChild(node, 'title')).trim(),
      link: href,
      published: textOf(firstChild(node, 'published')).trim(),
      updated: textOf(firstChild(node, 'updated')).trim(),
      summary: readHtmlElement(firstChild(node, 'summary')),
      content: readHtmlElement(firstChild(node, 'content')),
      authors: authorOf(node),
      links,
    };
  });

  return {
    format: 'atom',
    meta: { title: textOf(firstChild(root, 'title')).trim(), link: linkOf(root).href },
    items,
  };
}

function asString(value) {
  return value === null || value === undefined ? '' : String(value);
}

function parseJsonFeed(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON Feed: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || !/jsonfeed\.org\/version/.test(asString(doc.version))) {
    throw new Error('unsupported feed format: missing JSON Feed version');
  }

  const items = Array.isArray(doc.items) ? doc.items.map((entry) => {
    const item = entry && typeof entry === 'object' ? entry : {};
    const link = asString(item.url) || asString(item.external_url);
    return {
      ...blank,
      sourceFormat: 'json',
      id: asString(item.id),
      title: asString(item.title),
      link,
      published: asString(item.date_published),
      updated: asString(item.date_modified),
      summary: asString(item.summary),
      // content_html 可能携带标签，content_text 是纯文本兜底。
      content: asString(item.content_html) || asString(item.content_text),
      authors: Array.isArray(item.authors)
        ? item.authors.map((author) => asString(author && author.name)).filter(Boolean)
        : (item.author && item.author.name ? [asString(item.author.name)] : []),
      links: link ? [{ href: link, rel: 'alternate', type: 'text/html' }] : [],
    };
  }) : [];

  return {
    format: 'json',
    meta: { title: asString(doc.title), link: asString(doc.home_page_url) },
    items,
  };
}

export function detectFormat(raw) {
  const value = String(raw).trim();
  if (value.startsWith('{') || value.startsWith('[')) return 'json';
  const root = documentElement(value);
  if (root.local === 'feed') return 'atom';
  if (root.local === 'rss') return 'rss';
  if (root.local === 'RDF') return 'rss'; // RSS 1.0：rdf:RDF
  throw new Error(`unsupported feed format: unknown root element <${root.name}>`);
}

export function parseFeed(raw) {
  const format = detectFormat(raw);
  if (format === 'json') return parseJsonFeed(raw);
  const root = documentElement(raw.trim());
  return format === 'atom' ? parseAtom(root) : parseRssLike(root);
}
