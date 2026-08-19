// 3 カラムのリーダー UI。
// フィード由来の文字列は innerHTML に渡さず、createElement / textContent で組み立てる。

import { applyQuery, highlightTerms } from './lib/query.js';
import { parseWithDom, refreshFeed } from './lib/refresh.js';
import { sanitizeHtml, toPlainText } from './lib/sanitize.js';
import {
  addFeed,
  addFilter,
  countUnread,
  getState,
  markAllRead,
  removeFeed,
  removeFilter,
  renameFeed,
  setRead,
  updateFilter,
  updateSettings,
} from './lib/store.js';

const ALL_FEEDS = 'all';
const AUTO_MARK_READ_DELAY_MS = 400;

const el = {
  refreshAll: document.getElementById('refresh-all'),
  addFeedForm: document.getElementById('add-feed-form'),
  feedUrl: document.getElementById('feed-url'),
  addFeedMessage: document.getElementById('add-feed-message'),
  feedList: document.getElementById('feed-list'),
  addFilterForm: document.getElementById('add-filter-form'),
  filterKeyword: document.getElementById('filter-keyword'),
  filterMode: document.getElementById('filter-mode'),
  addFilterMessage: document.getElementById('add-filter-message'),
  filterList: document.getElementById('filter-list'),
  search: document.getElementById('search'),
  unreadOnly: document.getElementById('unread-only'),
  autoMarkRead: document.getElementById('auto-mark-read'),
  sortOrder: document.getElementById('sort-order'),
  markAllRead: document.getElementById('mark-all-read'),
  listStatus: document.getElementById('list-status'),
  itemList: document.getElementById('item-list'),
  previewEmpty: document.getElementById('preview-empty'),
  previewArticle: document.getElementById('preview-article'),
  previewTitle: document.getElementById('preview-title'),
  previewMeta: document.getElementById('preview-meta'),
  previewLink: document.getElementById('preview-link'),
  previewBody: document.getElementById('preview-body'),
  toggleRead: document.getElementById('toggle-read'),
};

/** 画面状態。state.data はストレージのスナップショット。 */
const state = {
  data: { feeds: [], items: {}, filters: [], settings: {} },
  selectedFeedId: ALL_FEEDS,
  selectedItemId: null,
  search: '',
  visible: [],
  refreshingFeedIds: new Set(),
};

let autoMarkReadTimer = null;
// バックグラウンド更新で本文を作り直してスクロール位置が飛ばないよう、描画済みの記事を覚えておく
let renderedPreviewId = null;

// ------------------------------------------------------------------ helpers

function relativeTime(epoch) {
  if (!epoch) return '';
  const diff = Date.now() - epoch;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 日前`;
  return new Date(epoch).toLocaleDateString('ja-JP');
}

function absoluteTime(epoch) {
  return epoch ? new Date(epoch).toLocaleString('ja-JP') : '';
}

function showMessage(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('message-error', isError);
  node.hidden = !text;
}

/** 検索語 / include キーワードを <mark> で強調したノードを返す。 */
function highlighted(text, terms) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;
  if (terms.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  const lower = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    let bestIndex = -1;
    let bestTerm = '';
    for (const term of terms) {
      const index = lower.indexOf(term, cursor);
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (bestIndex > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, bestIndex)));
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(bestIndex, bestIndex + bestTerm.length);
    fragment.appendChild(mark);
    cursor = bestIndex + bestTerm.length;
  }
  return fragment;
}

function feedTitleMap() {
  return Object.fromEntries(state.data.feeds.map((feed) => [feed.id, feed.title]));
}

function findItem(itemId) {
  for (const list of Object.values(state.data.items)) {
    const found = list.find((item) => item.id === itemId);
    if (found) return found;
  }
  return null;
}

/** 現在選択中のフィード範囲の記事をフラットに集める。 */
function scopedItems() {
  const { items } = state.data;
  if (state.selectedFeedId === ALL_FEEDS) return Object.values(items).flat();
  return items[state.selectedFeedId] || [];
}

// -------------------------------------------------------------------- render

function renderFeeds() {
  const { perFeed, total } = countUnread(state.data.items);
  el.feedList.replaceChildren();

  const allRow = document.createElement('li');
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'feed-item';
  allButton.classList.toggle('selected', state.selectedFeedId === ALL_FEEDS);
  const allLabel = document.createElement('span');
  allLabel.className = 'feed-title';
  allLabel.textContent = 'すべてのフィード';
  allButton.append(allLabel);
  if (total > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(total);
    allButton.append(badge);
  }
  allButton.addEventListener('click', () => selectFeed(ALL_FEEDS));
  allRow.append(allButton);
  el.feedList.append(allRow);

  for (const feed of state.data.feeds) {
    const row = document.createElement('li');
    row.className = 'feed-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feed-item';
    button.classList.toggle('selected', state.selectedFeedId === feed.id);
    button.title = feed.url;

    const title = document.createElement('span');
    title.className = 'feed-title';
    title.textContent = feed.title;
    button.append(title);

    if (state.refreshingFeedIds.has(feed.id)) {
      const spinner = document.createElement('span');
      spinner.className = 'feed-flag';
      spinner.textContent = '…';
      button.append(spinner);
    } else if (feed.lastError) {
      const warn = document.createElement('span');
      warn.className = 'feed-flag feed-error';
      warn.textContent = '!';
      warn.title = `取得エラー: ${feed.lastError}`;
      button.append(warn);
    }

    const unread = perFeed[feed.id] || 0;
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(unread);
      button.append(badge);
    }
    button.addEventListener('click', () => selectFeed(feed.id));
    row.append(button);

    const actions = document.createElement('span');
    actions.className = 'feed-actions';
    actions.append(
      iconButton('⟳', 'このフィードを更新', () => refreshOne(feed)),
      iconButton('✓', 'このフィードをすべて既読にする', () => markFeedRead(feed.id)),
      iconButton('✎', 'タイトルを変更', () => promptRename(feed)),
      iconButton('✕', 'このフィードを削除', () => deleteFeed(feed))
    );
    row.append(actions);

    if (feed.lastError) {
      const error = document.createElement('p');
      error.className = 'feed-error-text';
      error.textContent = feed.lastError;
      row.append(error);
    }

    el.feedList.append(row);
  }

  if (state.data.feeds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'feed-empty';
    empty.textContent = 'フィードが未登録です。';
    el.feedList.append(empty);
  }
}

function iconButton(label, title, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function renderFilters() {
  el.filterList.replaceChildren();
  if (state.data.filters.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'filter-empty';
    empty.textContent = 'キーワードは未登録です。';
    el.filterList.append(empty);
    return;
  }
  for (const filter of state.data.filters) {
    const row = document.createElement('li');
    row.className = 'filter-row';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = filter.enabled;
    toggle.title = '有効 / 無効';
    toggle.addEventListener('change', async () => {
      await updateFilter(filter.id, { enabled: toggle.checked });
    });

    const keyword = document.createElement('span');
    keyword.className = 'filter-keyword';
    keyword.textContent = filter.keyword;
    if (!filter.enabled) keyword.classList.add('disabled');

    const mode = document.createElement('select');
    mode.className = 'filter-mode';
    for (const [value, label] of [['exclude', '除外する'], ['include', '含める']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = filter.mode === value;
      mode.append(option);
    }
    mode.addEventListener('change', async () => {
      await updateFilter(filter.id, { mode: mode.value });
    });

    row.append(toggle, keyword, mode, iconButton('✕', 'このキーワードを削除', () => removeFilter(filter.id)));
    el.filterList.append(row);
  }
}

function renderList() {
  const titles = feedTitleMap();
  state.visible = applyQuery(scopedItems(), {
    search: state.search,
    filters: state.data.filters,
    unreadOnly: Boolean(state.data.settings.unreadOnly),
    sortOrder: state.data.settings.sortOrder,
    feedTitles: titles,
  });

  const terms = highlightTerms(state.search, state.data.filters);
  el.itemList.replaceChildren();

  for (const item of state.visible) {
    const row = document.createElement('li');
    row.className = 'item-row';
    row.classList.toggle('unread', !item.read);
    row.classList.toggle('selected', item.id === state.selectedItemId);
    row.dataset.itemId = item.id;

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'read-dot';
    dot.title = item.read ? '未読に戻す' : '既読にする';
    dot.setAttribute('aria-label', dot.title);
    dot.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleRead(item);
    });

    const main = document.createElement('div');
    main.className = 'item-main';

    const title = document.createElement('p');
    title.className = 'item-title';
    title.append(highlighted(item.title || '(タイトルなし)', terms));

    const meta = document.createElement('p');
    meta.className = 'item-meta';
    const source = document.createElement('span');
    source.className = 'item-source';
    source.textContent = titles[item.feedId] || '';
    const time = document.createElement('time');
    time.textContent = relativeTime(item.published);
    time.title = absoluteTime(item.published);
    meta.append(source, document.createTextNode(' ・ '), time);

    const summary = document.createElement('p');
    summary.className = 'item-summary';
    summary.append(highlighted(toPlainText(item.summary || item.content, 160), terms));

    main.append(title, meta, summary);

    const openLink = document.createElement('a');
    openLink.className = 'item-open';
    openLink.href = item.link || '#';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = '↗';
    openLink.title = '元記事を新しいタブで開く';
    openLink.addEventListener('click', (event) => event.stopPropagation());

    row.append(dot, main, openLink);
    row.addEventListener('click', () => selectItem(item.id));
    el.itemList.append(row);
  }

  renderListStatus();
}

function renderListStatus() {
  const scoped = scopedItems();
  const unread = state.visible.reduce((sum, item) => sum + (item.read ? 0 : 1), 0);
  if (state.data.feeds.length === 0) {
    el.listStatus.textContent = '左のフォームから RSS / Atom フィードの URL を登録してください。';
    return;
  }
  if (state.visible.length === 0) {
    el.listStatus.textContent =
      scoped.length === 0
        ? '記事がありません。「更新」でフィードを取得してください。'
        : `条件に一致する記事はありません（対象 ${scoped.length} 件）。`;
    return;
  }
  el.listStatus.textContent = `${state.visible.length} 件表示（未読 ${unread} 件 / 対象 ${scoped.length} 件）`;
}

function renderPreview() {
  const item = state.selectedItemId ? findItem(state.selectedItemId) : null;
  if (!item) {
    el.previewArticle.hidden = true;
    el.previewEmpty.hidden = false;
    renderedPreviewId = null;
    return;
  }
  el.previewEmpty.hidden = true;
  el.previewArticle.hidden = false;

  el.previewTitle.textContent = item.title || '(タイトルなし)';
  if (item.link) {
    el.previewTitle.href = item.link;
    el.previewLink.href = item.link;
    el.previewLink.hidden = false;
  } else {
    el.previewTitle.removeAttribute('href');
    el.previewLink.hidden = true;
  }

  const titles = feedTitleMap();
  const metaParts = [titles[item.feedId], item.author, absoluteTime(item.published)].filter(Boolean);
  el.previewMeta.textContent = metaParts.join(' ・ ');

  el.toggleRead.textContent = item.read ? '未読にする' : '既読にする';

  // 同じ記事を再描画するときは本文とスクロール位置をそのまま残す
  if (renderedPreviewId === item.id) return;
  renderedPreviewId = item.id;

  const body = item.content || item.summary || '';
  el.previewBody.replaceChildren();
  if (body) {
    el.previewBody.append(sanitizeHtml(body));
  } else {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '本文が含まれていないフィードです。「元記事を開く」でご覧ください。';
    el.previewBody.append(note);
  }
  el.previewBody.scrollTop = 0;
}

function renderAll() {
  el.unreadOnly.checked = Boolean(state.data.settings.unreadOnly);
  el.autoMarkRead.checked = Boolean(state.data.settings.autoMarkRead);
  el.sortOrder.value = state.data.settings.sortOrder || 'newest';
  renderFeeds();
  renderFilters();
  renderList();
  renderPreview();
}

// -------------------------------------------------------------------- actions

async function reload({ render = true } = {}) {
  state.data = await getState();
  if (state.selectedFeedId !== ALL_FEEDS && !state.data.feeds.some((f) => f.id === state.selectedFeedId)) {
    state.selectedFeedId = ALL_FEEDS;
  }
  if (render) renderAll();
}

function selectFeed(feedId) {
  state.selectedFeedId = feedId;
  renderFeeds();
  renderList();
}

function selectItem(itemId) {
  state.selectedItemId = itemId;
  renderList();
  renderPreview();
  scrollSelectedIntoView();

  clearTimeout(autoMarkReadTimer);
  const item = findItem(itemId);
  if (state.data.settings.autoMarkRead && item && !item.read) {
    autoMarkReadTimer = setTimeout(() => {
      setRead(item.feedId, item.id, true);
    }, AUTO_MARK_READ_DELAY_MS);
  }
}

function scrollSelectedIntoView() {
  const row = el.itemList.querySelector('.item-row.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

async function toggleRead(item) {
  clearTimeout(autoMarkReadTimer);
  await setRead(item.feedId, item.id, !item.read);
}

async function markFeedRead(feedId) {
  await markAllRead(feedId);
}

/** ツールバーの「すべて既読」: いま表示中の記事だけを既読にする。 */
async function markVisibleRead() {
  const ids = state.visible.filter((item) => !item.read).map((item) => item.id);
  if (ids.length === 0) return;
  await markAllRead(state.selectedFeedId === ALL_FEEDS ? null : state.selectedFeedId, ids);
}

async function refreshOne(feed) {
  state.refreshingFeedIds.add(feed.id);
  renderFeeds();
  try {
    const result = await refreshFeed(feed, parseWithDom);
    if (!result.ok) showMessage(el.addFeedMessage, `${feed.title}: ${result.error}`, true);
  } finally {
    state.refreshingFeedIds.delete(feed.id);
    await reload();
  }
}

async function refreshAllFeeds() {
  el.refreshAll.disabled = true;
  el.refreshAll.textContent = '更新中…';
  showMessage(el.addFeedMessage, '');
  try {
    for (const feed of state.data.feeds) state.refreshingFeedIds.add(feed.id);
    renderFeeds();
    // 逐次実行して相手サーバーへの同時接続を抑える
    let failed = 0;
    for (const feed of state.data.feeds) {
      const result = await refreshFeed(feed, parseWithDom);
      if (!result.ok) failed += 1;
      state.refreshingFeedIds.delete(feed.id);
      await reload();
    }
    if (failed > 0) {
      showMessage(el.addFeedMessage, `${failed} 件のフィードの取得に失敗しました。`, true);
    }
  } finally {
    state.refreshingFeedIds.clear();
    el.refreshAll.disabled = false;
    el.refreshAll.textContent = '更新';
    await reload();
  }
}

async function deleteFeed(feed) {
  if (!confirm(`「${feed.title}」を削除しますか？（保存済みの記事も削除されます）`)) return;
  await removeFeed(feed.id);
  if (state.selectedFeedId === feed.id) state.selectedFeedId = ALL_FEEDS;
  await reload();
}

async function promptRename(feed) {
  const input = prompt('フィードのタイトル', feed.title);
  if (input === null) return;
  try {
    // renameFeed は titleEdited を立てるので、以降の自動更新でタイトルは上書きされない
    await renameFeed(feed.id, input);
    await reload();
  } catch (error) {
    showMessage(el.addFeedMessage, error.message, true);
  }
}

// ---------------------------------------------------------------- listeners

el.addFeedForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = el.feedUrl.value;
  showMessage(el.addFeedMessage, '');
  let created;
  try {
    created = await addFeed(url);
  } catch (error) {
    showMessage(el.addFeedMessage, error.message, true);
    return;
  }
  el.feedUrl.value = '';
  await reload();
  showMessage(el.addFeedMessage, '取得中…');
  const result = await refreshFeed(created.feed, parseWithDom);
  await reload();
  if (result.ok) {
    showMessage(el.addFeedMessage, `「${result.title}」を追加しました（${result.added} 件）。`);
    selectFeed(created.feed.id);
  } else {
    showMessage(el.addFeedMessage, `追加しましたが取得に失敗しました: ${result.error}`, true);
  }
});

el.addFilterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage(el.addFilterMessage, '');
  try {
    await addFilter(el.filterKeyword.value, el.filterMode.value);
    el.filterKeyword.value = '';
  } catch (error) {
    showMessage(el.addFilterMessage, error.message, true);
  }
});

el.refreshAll.addEventListener('click', refreshAllFeeds);
el.markAllRead.addEventListener('click', markVisibleRead);

let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = el.search.value;
    renderList();
  }, 150);
});

el.unreadOnly.addEventListener('change', async () => {
  await updateSettings({ unreadOnly: el.unreadOnly.checked });
});

el.autoMarkRead.addEventListener('change', async () => {
  await updateSettings({ autoMarkRead: el.autoMarkRead.checked });
});

el.sortOrder.addEventListener('change', async () => {
  await updateSettings({ sortOrder: el.sortOrder.value });
});

el.toggleRead.addEventListener('click', () => {
  const item = state.selectedItemId ? findItem(state.selectedItemId) : null;
  if (item) toggleRead(item);
});

// バックグラウンド更新や他タブの操作を即座に反映する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.feeds || changes.items || changes.filters || changes.settings) reload();
});

// キーボード操作
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');

  if (event.key === '/' && !typing) {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (event.key === 'Escape' && target === el.search) {
    el.search.value = '';
    state.search = '';
    renderList();
    el.search.blur();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  const index = state.visible.findIndex((item) => item.id === state.selectedItemId);
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    const next = state.visible[index + 1] || state.visible[index === -1 ? 0 : index];
    if (next) selectItem(next.id);
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (index > 0) selectItem(state.visible[index - 1].id);
  } else if (event.key === 'm') {
    const item = state.selectedItemId ? findItem(state.selectedItemId) : null;
    if (item) toggleRead(item);
  } else if (event.key === 'o' || event.key === 'Enter') {
    const item = state.selectedItemId ? findItem(state.selectedItemId) : null;
    if (item && item.link) window.open(item.link, '_blank', 'noopener,noreferrer');
  }
});

reload();
