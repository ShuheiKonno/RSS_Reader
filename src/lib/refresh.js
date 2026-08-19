// フィード取得の共通ロジック。
// XML の解析だけは実行環境依存 (DOM の有無) なので parseXml を注入してもらう。

import { parseFeed } from './parser.js';
import { getSettings, getState, mergeItems, updateFeed } from './store.js';

const FETCH_TIMEOUT_MS = 15000;

/** ネットワークエラーを日本語の短いメッセージに寄せる。 */
function describeError(error) {
  if (error && error.name === 'AbortError') return 'タイムアウトしました（15 秒）';
  return (error && error.message) || '取得に失敗しました';
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-cache',
      redirect: 'follow',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1 件のフィードを取得してストレージへ反映する。例外は投げず結果で返す。
 * @param {object} feed store 上のフィード
 * @param {(xml: string, feedUrl: string) => object} parseXml 実行環境ごとの解析関数
 * @returns {Promise<{ok: boolean, added: number, error: string, title: string}>}
 */
export async function refreshFeed(feed, parseXml) {
  try {
    const xml = await fetchText(feed.url);
    const parsed = await parseXml(xml, feed.url);
    const settings = await getSettings();
    const added = await mergeItems(feed.id, parsed.items, settings);
    // 自動取得したタイトルは、ユーザーが手で変えていない場合のみ上書きする
    const keepTitle = feed.titleEdited && feed.title;
    await updateFeed(feed.id, {
      title: keepTitle || parsed.title || feed.title,
      siteUrl: parsed.siteUrl || feed.siteUrl,
      lastFetched: Date.now(),
      lastError: '',
    });
    return { ok: true, added, error: '', title: keepTitle || parsed.title || feed.title };
  } catch (error) {
    const message = describeError(error);
    await updateFeed(feed.id, { lastFetched: Date.now(), lastError: message });
    return { ok: false, added: 0, error: message, title: feed.title };
  }
}

/**
 * 全フィードを順に更新する。1 件の失敗で他を止めない。
 * @returns {Promise<{added: number, failed: number, total: number}>}
 */
export async function refreshAll(parseXml) {
  const { feeds } = await getState();
  let added = 0;
  let failed = 0;
  for (const feed of feeds) {
    const result = await refreshFeed(feed, parseXml);
    added += result.added;
    if (!result.ok) failed += 1;
  }
  return { added, failed, total: feeds.length };
}

/** リーダーページ用: ページ自身の DOMParser を使う。 */
export function parseWithDom(xml, feedUrl) {
  return parseFeed(xml, feedUrl, DOMParser);
}
