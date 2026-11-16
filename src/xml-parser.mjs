// 真正的 XML 解析器：分词器 + 树构建器。
// 不是针对 RSS/Atom 各写一个正则，而是一次性把任意 XML 文档建成节点树，
// 上层格式解析只负责按本地名（local name，忽略命名空间前缀）查询节点。
// 支持：元素/属性/自闭合、CDATA、注释、处理指令、DOCTYPE、
// 预定义与数字字符引用、常见 HTML 命名实体、命名空间前缀、XHTML 嵌套元素。

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  deg: '°',
  hellip: '…',
};

export function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const codePoint = body[1].toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

const localName = (name) => {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(index + 1);
};

function makeNode(name, attrs = {}) {
  return { name, local: localName(name), attrs, children: [] };
}

const isElement = (node) => node && node.name[0] !== '#';

function appendText(parent, kind, text) {
  if (text === '') return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.name === kind) {
    last.text += text;
  } else {
    parent.children.push({ name: kind, text });
  }
}

function parseOpenTag(tagSource) {
  const selfClosing = tagSource.endsWith('/');
  const body = selfClosing ? tagSource.slice(0, -1) : tagSource;
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).trim();
  const attrs = {};
  if (space !== -1) {
    const attrSource = body.slice(space);
    // 属性值里不允许出现未转义的 '>'（那会提前结束开标签）；
    // 同时用引号状态机扫描，避免裸正则把属性间空白吃乱。
    const pattern = /([^\s=/>]+)(?:\s*=\s*("([^">]*)"|'([^'>]*)'))?/g;
    let match;
    while ((match = pattern.exec(attrSource)) !== null) {
      const raw = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : '';
      attrs[match[1]] = decodeEntities(raw);
    }
  }
  return { name, attrs, selfClosing };
}

// 跳过 <!DOCTYPE ...>（可能带内部子集，内部可能出现带引号的 '>'）。
function skipDeclaration(source, start) {
  let i = start + 2;
  let quote = '';
  let depth = 0;
  while (i < source.length) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === '>' && depth === 0) {
      return i + 1;
    }
    i += 1;
  }
  throw new Error('unterminated XML markup declaration');
}

export function parseXml(source) {
  const text = String(source).replace(/^﻿/, '');
  const root = makeNode('#root');
  const stack = [root];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '<') {
      const next = text.indexOf('<', i);
      const end = next === -1 ? text.length : next;
      appendText(stack[stack.length - 1], '#text', decodeEntities(text.slice(i, end)));
      i = end;
      continue;
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) throw new Error('unterminated XML comment');
      i = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) throw new Error('unterminated CDATA section');
      appendText(stack[stack.length - 1], '#cdata', text.slice(i + 9, end));
      i = end + 3;
      continue;
    }

    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) throw new Error('unterminated processing instruction');
      i = end + 2;
      continue;
    }

    if (text.startsWith('<!', i)) {
      i = skipDeclaration(text, i);
      continue;
    }

    if (text[i + 1] === '/') {
      const close = text.indexOf('>', i);
      if (close === -1) throw new Error('unterminated closing tag');
      const name = text.slice(i + 2, close).trim();
      const parent = stack[stack.length - 1];
      // 全名精确匹配优先；前缀与绑定不一致的真实世界输入按本地名兜底。
      if (parent.name !== name && parent.local !== localName(name)) {
        throw new Error(`unexpected closing tag </${name}> while <${parent.name}> is open`);
      }
      stack.pop();
      i = close + 1;
      continue;
    }

    const close = (() => {
      let cursor = i + 1;
      let quote = '';
      while (cursor < text.length) {
        const char = text[cursor];
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '>') {
          return cursor;
        }
        cursor += 1;
      }
      return -1;
    })();
    if (close === -1) throw new Error('unterminated opening tag');

    const { name, attrs, selfClosing } = parseOpenTag(text.slice(i + 1, close));
    const node = makeNode(name, attrs);
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = close + 1;
  }

  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new Error(`unclosed element <${open.name}>`);
  }

  const elements = root.children.filter(isElement);
  if (elements.length === 0) throw new Error('document has no root element');
  return root;
}

export function documentElement(sourceOrTree) {
  const tree = typeof sourceOrTree === 'string' ? parseXml(sourceOrTree) : sourceOrTree;
  return tree.children.filter(isElement)[0];
}

// 直接子元素，按本地名匹配，命名空间前缀无关。
export function childElements(node, local) {
  return node.children.filter((child) => isElement(child) && (local === undefined || child.local === local));
}

export function firstChild(node, local) {
  return childElements(node, local)[0] || null;
}

export function findDescendants(node, local) {
  const result = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (!isElement(child)) continue;
      if (child.local === local) result.push(child);
      walk(child);
    }
  };
  walk(node);
  return result;
}

export function attr(node, local, fallback = '') {
  if (!node) return fallback;
  const entry = Object.entries(node.attrs).find(([key]) => localName(key) === local);
  return entry === undefined ? fallback : entry[1];
}

// 元素内全部文本（含 CDATA、嵌套元素的文本），按文档顺序拼接。
export function textOf(node) {
  if (!node) return '';
  const collect = (current) => {
    let out = '';
    for (const child of current.children) {
      if (child.name === '#text' || child.name === '#cdata') {
        out += child.text;
      } else if (isElement(child)) {
        out += collect(child);
      }
    }
    return out;
  };
  return collect(node);
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 把元素子树序列回 HTML/XML 字符串，用于 Atom type="xhtml" 的内容。
export function innerHtml(node) {
  if (!node) return '';
  const serialize = (current) => {
    let out = '';
    for (const child of current.children) {
      if (child.name === '#text') {
        out += escapeText(child.text);
      } else if (child.name === '#cdata') {
        out += escapeText(child.text);
      } else if (isElement(child)) {
        const attrs = Object.entries(child.attrs)
          .map(([key, value]) => ` ${key}="${value.replace(/"/g, '&quot;')}"`)
          .join('');
        out += `<${child.name}${attrs}>`;
        out += serialize(child);
        out += `</${child.name}>`;
      }
    }
    return out;
  };
  return serialize(node);
}
