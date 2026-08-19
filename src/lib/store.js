// chrome.storage.local のスキーマとアクセサ。
// 記事は feedId ごとの配列で保持し、記事 ID で重複排除して既読状態を引き継ぐ。

export const DEFAULT_SETTINGS = {
  refreshMinutes: 30,
  autoMarkRead: true,
  unreadOnly: false,
  sortOrder: 'newest',
  itemsPerFeed: 200,
  retentionDays: 30,
};

const KEYS = ['feeds', 'items', 'filters', 'settings'];

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 全データを既定値で埋めて読み出す。 */
export async function getState() {
  const raw = await chrome.storage.local.get(KEYS);
  return {
    feeds: Array.isArray(raw.feeds) ? raw.feeds : [],
    items: raw.items && typeof raw.items === 'object' ? raw.items : {},
    filters: Array.isArray(raw.filters) ? raw.filters : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function updateSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

/** URL の末尾スラッシュなどを揃えて重複登録を防ぐ。 */
function normalizeUrl(input) {
  const raw = (input || '').trim();
  if (!raw) throw new Error('URL を入力してください');
  // スキームが無い入力にだけ https:// を補う (ftp:// などを誤って通さないため)
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const withScheme = hasScheme ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('URL の形式が正しくありません');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('http または https の URL を指定してください');
  }
  url.hash = '';
  return url.href;
}

/**
 * フィードを登録する (記事の取得は行わない)。
 * @returns {{feed: object, feeds: Array<object>}}
 * @throws {Error} URL 不正 / 既に登録済みの場合
 */
export async function addFeed(url) {
  const normalized = normalizeUrl(url);
  const { feeds } = await getState();
  if (feeds.some((feed) => feed.url === normalized)) {
    throw new Error('このフィードは既に登録されています');
  }
  const feed = {
    id: newId('feed'),
    url: normalized,
    title: normalized,
    siteUrl: '',
    lastFetched: null,
    lastError: '',
  };
  const next = [...feeds, feed];
  await chrome.storage.local.set({ feeds: next });
  return { feed, feeds: next };
}

export async function removeFeed(feedId) {
  const { feeds, items } = await getState();
  delete items[feedId];
  await chrome.storage.local.set({
    feeds: feeds.filter((feed) => feed.id !== feedId),
    items,
  });
}

/** フィードのメタ情報 (タイトル / 取得時刻 / エラー) を部分更新する。 */
export async function updateFeed(feedId, patch) {
  const { feeds } = await getState();
  const next = feeds.map((feed) => (feed.id === feedId ? { ...feed, ...patch } : feed));
  await chrome.storage.local.set({ feeds: next });
  return next.find((feed) => feed.id === feedId) || null;
}

/** 手動でタイトルを変更する。titleEdited を立てて自動取得での上書きを防ぐ。 */
export async function renameFeed(feedId, title) {
  const trimmed = (title || '').trim();
  if (!trimmed) throw new Error('タイトルを入力してください');
  return updateFeed(feedId, { title: trimmed, titleEdited: true });
}

/**
 * 取得した記事を既存データにマージする。
 * 既に保存済みの ID は既読状態と初回取得時刻を保持し、本文のみ更新する。
 * @returns {number} 新規に追加された記事数
 */
export async function mergeItems(feedId, parsedItems, settings) {
  const { items } = await getState();
  const existing = items[feedId] || [];
  const byId = new Map(existing.map((item) => [item.id, item]));
  const now = Date.now();
  let added = 0;

  for (const parsed of parsedItems) {
    const previous = byId.get(parsed.id);
    if (previous) {
      byId.set(parsed.id, {
        ...previous,
        title: parsed.title || previous.title,
        link: parsed.link || previous.link,
        author: parsed.author || previous.author,
        published: parsed.published ?? previous.published,
        summary: parsed.summary || previous.summary,
        content: parsed.content || previous.content,
      });
    } else {
      byId.set(parsed.id, {
        ...parsed,
        feedId,
        // 日時を持たないフィードは取得順を時系列の代わりに使う
        published: parsed.published ?? now,
        read: false,
        fetchedAt: now,
      });
      added += 1;
    }
  }

  items[feedId] = prune(Array.from(byId.values()), settings);
  await chrome.storage.local.set({ items });
  return added;
}

/** 保持件数と保持期間で記事を間引く。未読は期間超過でも残す。 */
function prune(list, settings) {
  const { itemsPerFeed, retentionDays } = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return list
    .filter((item) => !item.read || (item.published ?? item.fetchedAt) >= cutoff)
    .sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
    .slice(0, itemsPerFeed);
}

export async function setRead(feedId, itemId, read) {
  const { items } = await getState();
  const list = items[feedId];
  if (!list) return;
  items[feedId] = list.map((item) => (item.id === itemId ? { ...item, read } : item));
  await chrome.storage.local.set({ items });
}

/**
 * 既読にする。feedId を省略すると全フィードが対象。
 * itemIds を渡すとその記事だけを対象にする (画面に表示中の記事のみ既読化する用途)。
 */
export async function markAllRead(feedId = null, itemIds = null) {
  const { items } = await getState();
  const targetIds = itemIds ? new Set(itemIds) : null;
  const feedIds = feedId ? [feedId] : Object.keys(items);
  for (const id of feedIds) {
    if (!items[id]) continue;
    items[id] = items[id].map((item) =>
      !item.read && (!targetIds || targetIds.has(item.id)) ? { ...item, read: true } : item
    );
  }
  await chrome.storage.local.set({ items });
}

export async function addFilter(keyword, mode = 'exclude') {
  const trimmed = (keyword || '').trim();
  if (!trimmed) throw new Error('キーワードを入力してください');
  const { filters } = await getState();
  const lower = trimmed.toLowerCase();
  if (filters.some((f) => f.keyword.toLowerCase() === lower && f.mode === mode)) {
    throw new Error('同じキーワードが既に登録されています');
  }
  const next = [...filters, { id: newId('flt'), keyword: trimmed, mode, enabled: true }];
  await chrome.storage.local.set({ filters: next });
  return next;
}

export async function updateFilter(filterId, patch) {
  const { filters } = await getState();
  const next = filters.map((f) => (f.id === filterId ? { ...f, ...patch } : f));
  await chrome.storage.local.set({ filters: next });
  return next;
}

export async function removeFilter(filterId) {
  const { filters } = await getState();
  const next = filters.filter((f) => f.id !== filterId);
  await chrome.storage.local.set({ filters: next });
  return next;
}

/** feedId ごとの未読数と合計を返す。 */
export function countUnread(items) {
  const perFeed = {};
  let total = 0;
  for (const [feedId, list] of Object.entries(items || {})) {
    const count = list.reduce((sum, item) => sum + (item.read ? 0 : 1), 0);
    perFeed[feedId] = count;
    total += count;
  }
  return { perFeed, total };
}
