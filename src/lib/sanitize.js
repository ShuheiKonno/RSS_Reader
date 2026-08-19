// フィード由来の HTML を許可リスト方式でサニタイズする。
// フィード文字列を innerHTML に代入することは無く、解析結果から DOM を組み直す。

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

// 中身は保持したいが要素自体は不要なタグ (子を親に引き上げる)
const UNWRAP_TAGS = new Set(['body', 'html', 'head', 'font', 'center', 'article', 'section', 'main']);

// 中身ごと破棄するタグ
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'link', 'meta', 'noscript', 'svg', 'math', 'template',
]);

/** http(s) スキームのみ許可する (javascript: や data: を弾く)。 */
function safeUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://invalid.example/');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function copyAttributes(source, target) {
  const tag = target.tagName.toLowerCase();
  if (tag === 'a') {
    const href = safeUrl(source.getAttribute('href'));
    if (href) target.setAttribute('href', href);
    target.setAttribute('target', '_blank');
    target.setAttribute('rel', 'noopener noreferrer');
    const title = source.getAttribute('title');
    if (title) target.setAttribute('title', title);
  } else if (tag === 'img') {
    const src = safeUrl(source.getAttribute('src'));
    if (!src) return false; // 表示できない画像は要素ごと落とす
    target.setAttribute('src', src);
    target.setAttribute('alt', source.getAttribute('alt') || '');
    target.setAttribute('loading', 'lazy');
    target.setAttribute('referrerpolicy', 'no-referrer');
  }
  // 上記以外の属性 (on* / style / srcset / class など) は一切引き継がない
  return true;
}

function convert(node, doc) {
  if (node.nodeType === 3 /* Text */) return doc.createTextNode(node.nodeValue);
  if (node.nodeType !== 1 /* Element */) return null;

  const tag = node.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return null;

  if (UNWRAP_TAGS.has(tag) || !ALLOWED_TAGS.has(tag)) {
    // 未知のタグは子だけを残す
    const fragment = doc.createDocumentFragment();
    appendChildren(node, fragment, doc);
    return fragment;
  }

  const element = doc.createElement(tag);
  if (!copyAttributes(node, element)) return null;
  appendChildren(node, element, doc);
  return element;
}

function appendChildren(source, target, doc) {
  for (const childNode of source.childNodes) {
    const converted = convert(childNode, doc);
    if (converted) target.appendChild(converted);
  }
}

/**
 * 解析結果から本文の入ったノードを選ぶ。
 * text/html の解析では通常 body に入るが、body を作らない実装向けに documentElement へ退避する。
 */
function contentRoot(parsed) {
  if (parsed.body && parsed.body.childNodes.length > 0) return parsed.body;
  return parsed.documentElement || parsed.body;
}

/**
 * HTML 文字列を安全な DocumentFragment に変換する。
 * @param {string} html フィード由来の本文
 * @param {Document} doc 生成先ドキュメント (既定: グローバルの document)
 * @returns {DocumentFragment}
 */
export function sanitizeHtml(html, doc = document) {
  const fragment = doc.createDocumentFragment();
  if (!html) return fragment;
  // parseFromString('text/html') はスクリプトを実行せず、DOM だけを組み立てる
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const root = contentRoot(parsed);
  if (root) appendChildren(root, fragment, doc);
  return fragment;
}

/**
 * HTML タグを落として一覧表示用のプレーンテキストにする。
 * @param {string} html
 * @param {number} limit 最大文字数
 */
export function toPlainText(html, limit = 400) {
  if (!html) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const node of parsed.querySelectorAll('script, style')) node.remove();
  const root = contentRoot(parsed);
  const flat = ((root && root.textContent) || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
