// RSS 2.0 / Atom 1.0 / RDF (RSS 1.0) を共通の正規化オブジェクトに変換する。
// Service Worker には DOM が無いため DOMParser の実装は呼び出し側から受け取る
// (リーダーページは window.DOMParser、バックグラウンドは offscreen document 経由)。

const ATOM_NS = 'http://www.w3.org/2005/Atom';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';

/**
 * 名前空間接頭辞を除いたローカル名を小文字で返す。
 * XML パーサによっては localName に接頭辞が残るため、':' 以降を採用する。
 */
function localName(node) {
  const name = node.localName || node.nodeName || '';
  return name.slice(name.indexOf(':') + 1).toLowerCase();
}

function hasPrefix(node) {
  return (node.nodeName || '').includes(':');
}

/**
 * 直下の子要素のうち最初に名前が一致するものを返す (孫要素は見ない)。
 * 接頭辞なしの要素を優先し、media:title のような別名前空間の要素に引っ張られないようにする。
 */
function child(parent, ...names) {
  const wanted = names.map((n) => n.toLowerCase());
  let prefixed = null;
  for (const node of parent.children) {
    if (!wanted.includes(localName(node))) continue;
    if (!hasPrefix(node)) return node;
    prefixed = prefixed || node;
  }
  return prefixed;
}

function childrenNamed(parent, name) {
  const wanted = name.toLowerCase();
  return Array.from(parent.children).filter((node) => localName(node) === wanted);
}

/**
 * 指定の名前空間 (または接頭辞) を持つ直下の子要素のテキストを返す。
 * namespaceURI を解決しないパーサでも動くよう、接頭辞名でもフォールバックする。
 */
function nsText(parent, ns, prefix, name) {
  const wanted = name.toLowerCase();
  for (const node of parent.children) {
    if (localName(node) !== wanted) continue;
    if (node.namespaceURI === ns) return node.textContent.trim();
    if ((node.nodeName || '').toLowerCase().startsWith(`${prefix}:`)) return node.textContent.trim();
  }
  return '';
}

function text(node) {
  return node ? node.textContent.trim() : '';
}

/** 相対 URL をフィード URL 基準で絶対化する。解決できなければ空文字。 */
function absolute(url, base) {
  const raw = (url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, base).href;
  } catch {
    return '';
  }
}

/** pubDate / updated / dc:date などを epoch ms に変換する。不明なら null。 */
function toEpoch(...values) {
  for (const value of values) {
    const raw = (value || '').trim();
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** Atom の link を取り出す。rel="alternate" (既定値) を優先する。 */
function atomLink(parent, base) {
  const links = childrenNamed(parent, 'link');
  const alternate =
    links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
  return alternate ? absolute(alternate.getAttribute('href'), base) : '';
}

/** guid / id / link を持たないフィード向けの安定 ID (FNV-1a)。 */
function hashId(...parts) {
  const input = parts.join(' ');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h:${hash.toString(16)}`;
}

function parseRssItem(node, base) {
  const link = absolute(text(child(node, 'link')), base);
  const guid = text(child(node, 'guid'));
  const title = text(child(node, 'title'));
  const published = toEpoch(
    text(child(node, 'pubDate')),
    nsText(node, DC_NS, 'dc', 'date'),
    text(child(node, 'date'))
  );
  return {
    id: guid || link || hashId(title, String(published ?? '')),
    title,
    link,
    author:
      nsText(node, DC_NS, 'dc', 'creator') ||
      text(child(node, 'creator')) ||
      text(child(node, 'author')),
    published,
    summary: text(child(node, 'description')),
    content: nsText(node, CONTENT_NS, 'content', 'encoded') || text(child(node, 'encoded')),
  };
}

function parseAtomEntry(node, base) {
  const link = atomLink(node, base);
  const id = text(child(node, 'id'));
  const title = text(child(node, 'title'));
  const published = toEpoch(
    text(child(node, 'updated')),
    text(child(node, 'published')),
    text(child(node, 'issued'))
  );
  const authorNode = child(node, 'author');
  return {
    id: id || link || hashId(title, String(published ?? '')),
    title,
    link,
    author: authorNode ? text(child(authorNode, 'name')) : '',
    published,
    summary: text(child(node, 'summary')),
    content: text(child(node, 'content')),
  };
}

/**
 * フィード XML を解析する。
 * @param {string} xml レスポンス本文
 * @param {string} feedUrl 相対 URL 解決とタイトルのフォールバックに使う
 * @param {typeof DOMParser} DOMParserImpl
 * @returns {{title: string, siteUrl: string, items: Array<object>}}
 * @throws {Error} XML として壊れている / 既知のフィード形式でない場合
 */
export function parseFeed(xml, feedUrl, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('XML として解析できませんでした（URL がフィードかどうか確認してください）');
  }

  const root = doc.documentElement;
  if (!root) throw new Error('空のレスポンスです');

  const rootName = localName(root);
  let title = '';
  let siteUrl = '';
  let items = [];

  if (rootName === 'feed' || root.namespaceURI === ATOM_NS) {
    // Atom 1.0
    title = text(child(root, 'title'));
    siteUrl = atomLink(root, feedUrl);
    items = childrenNamed(root, 'entry').map((node) => parseAtomEntry(node, feedUrl));
  } else if (rootName === 'rss') {
    // RSS 2.0 / 0.9x
    const channel = child(root, 'channel');
    if (!channel) throw new Error('rss 要素に channel がありません');
    title = text(child(channel, 'title'));
    siteUrl = absolute(text(child(channel, 'link')), feedUrl);
    items = childrenNamed(channel, 'item').map((node) => parseRssItem(node, feedUrl));
  } else if (rootName === 'rdf') {
    // RSS 1.0 (RDF): channel と item が root 直下に並ぶ
    const channel = child(root, 'channel');
    title = channel ? text(child(channel, 'title')) : '';
    siteUrl = channel ? absolute(text(child(channel, 'link')), feedUrl) : '';
    items = childrenNamed(root, 'item').map((node) => parseRssItem(node, feedUrl));
  } else {
    throw new Error(`対応していないフィード形式です（ルート要素: ${root.nodeName}）`);
  }

  return {
    title: title || feedUrl,
    siteUrl,
    // タイトルも本文も無い項目は表示できないため除外する
    items: items.filter((item) => item.title || item.summary || item.content),
  };
}
