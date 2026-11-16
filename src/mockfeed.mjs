// 本地 fixture：同一批两篇内容分别用 RSS 2.0、Atom、JSON Feed 表达，
// 且刻意打乱字段顺序、混合 CDATA 与转义 HTML、切换 id 承载方式，
// 用于证明跨格式归一化后仍是同样的两条 canonical 条目。

const shared = {
  post1: {
    id: 'post-1',
    title: 'First post',
    link: 'https://example.test/1',
    published: 'Fri, 14 Nov 2026 10:00:00 GMT',
    publishedAtom: '2026-11-14T10:00:00Z',
    summaryHtml: 'hello <b>world</b>',
    summaryText: 'hello world',
  },
  post2: {
    // 不透明 guid（isPermaLink=false），Atom/JSON 侧改用各自稳定标识，
    // 三方都显式给出同一个 id，验证显式标识优先级最高。
    id: 'tag:example.test,2026:post-2',
    title: 'Second post',
    link: 'https://example.test/2',
    published: 'Fri, 14 Nov 2026 11:00:00 GMT',
    publishedAtom: '2026-11-14T11:00:00Z',
    summaryText: 'another item',
  },
};

export const rssFixture = `<?xml version="1.0"?>
<!-- RSS 2.0，含 CDATA、content:encoded 扩展命名空间、isPermaLink 声明 -->
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Local Feed</title><link>https://example.test/</link>
<item>
  <title>${shared.post1.title}</title>
  <link>${shared.post1.link}</link>
  <pubDate>${shared.post1.published}</pubDate>
  <guid>${shared.post1.id}</guid>
  <description><![CDATA[${shared.post1.summaryHtml}]]></description>
  <content:encoded><![CDATA[<p>hello <b>world</b></p>]]></content:encoded>
</item>
<item>
  <guid isPermaLink="false">${shared.post2.id}</guid>
  <description>${shared.post2.summaryText}</description>
  <title>${shared.post2.title}</title>
  <pubDate>${shared.post2.published}</pubDate>
  <link>${shared.post2.link}</link>
</item>
</channel></rss>`;

// 字段顺序与 RSS 完全不同（id 在前、updated 与 published 并存、xhtml 内容）。
export const atomFixture = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title>Local Feed</title>
  <link href="https://example.test/" rel="alternate" type="text/html"/>
  <link href="https://example.test/feed" rel="self"/>
  <entry>
    <id>${shared.post1.id}</id>
    <link rel="alternate" type="text/html" href="${shared.post1.link}?utm_source=rss&amp;utm_medium=feed"/>
    <updated>${shared.post1.publishedAtom}</updated>
    <published>${shared.post1.publishedAtom}</published>
    <title type="html">First &lt;b&gt;post&lt;/b&gt;</title>
    <summary type="html"><![CDATA[hello <b>world</b>]]></summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>hello <b>world</b></p></div></content>
  </entry>
  <entry>
    <id>${shared.post2.id}</id>
    <title>Second post</title>
    <link href="${shared.post2.link}"/>
    <published>${shared.post2.publishedAtom}</published>
    <updated>${shared.post2.publishedAtom}</updated>
    <summary>another item</summary>
  </entry>
</feed>`;

export const jsonFixture = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Local Feed',
  home_page_url: 'https://example.test/',
  feed_url: 'https://example.test/feed.json',
  items: [
    {
      id: shared.post1.id,
      url: `${shared.post1.link}?utm_source=rss&utm_medium=feed`,
      title: shared.post1.title,
      date_published: shared.post1.publishedAtom,
      summary: shared.post1.summaryText,
      content_html: `hello <b>world</b>`,
      authors: [{ name: 'Ada' }],
    },
    {
      // 顺序倒置：id 在最后，模拟字段顺序差异。
      date_published: shared.post2.publishedAtom,
      content_text: shared.post2.summaryText,
      url: shared.post2.link,
      title: shared.post2.title,
      id: shared.post2.id,
    },
  ],
}, null, 2);

// 兼容旧引用。
export const fixture = rssFixture;

// 边界合集：重复 id、非法日期、缺失发布时间、空条目、URL 形 guid 与 link 汇合、
// 缺 id 靠链接、全缺靠标题指纹、嵌套命名空间。
export const rssEdgeFixture = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Edge Feed</title>
  <item><guid>dup-1</guid><title>First</title><link>https://edge.test/a</link><pubDate>not-a-real-date</pubDate><description>x</description></item>
  <item><guid>dup-1</guid><title>Duplicate of first</title><link>https://edge.test/a</link><description>x</description></item>
  <item><guid isPermaLink="true">https://edge.test/b</guid><title>URL guid</title><pubDate>Sat, 14 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[<div><b>nested</b> <i>html</i></div>]]></description></item>
  <item><title>No guid at all</title><link>https://edge.test/c</link><description>falls back to link</description></item>
  <item><title>Title only item</title><description>no id no link, title fingerprint</description></item>
  <item><title></title><description></description></item>
  <item><dc:creator>Someone &amp; Co</dc:creator><guid>tag:edge.test,2026:g</guid><title>Namespace author</title><link>https://edge.test/d</link><description>dc:creator works</description></item>
</channel></rss>`;

export const atomEdgeFixture = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="http://example.test/ext">
  <title>Edge Feed Atom</title>
  <entry>
    <id>https://edge.test/b/</id>
    <link href="https://edge.test/b"/>
    <title>URL guid</title>
    <published>2026-11-14T12:00:00Z</published>
    <summary type="xhtml"><div xmlns="http://www.w3.org/2005/Atom"><b>nested</b> <i>html</i></div></summary>
  </entry>
</feed>`;

export { shared };
