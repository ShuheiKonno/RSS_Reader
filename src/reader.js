// 3 カラムのリーダー UI。
// フィード由来の文字列は innerHTML に渡さず、createElement / textContent で組み立てる。

import { applyQuery, highlightTerms } from './lib/query.js';
import { parseWithDom, refreshFeed } from './lib/refresh.js';
import { sanitizeHtml, toPlainText } from './lib/sanitize.js';
import {
  checkAvailability,
  createTranslatorPool,
  hasTranslatableSource,
  isTranslatorSupported,
  needsTranslation,
  translateItems,
  TARGET_LANG,
} from './lib/translate.js';
import {
  addFeed,
  addFilter,
  addGlossaryEntry,
  clearTranslations,
  countUnread,
  getState,
  markAllRead,
  removeFeed,
  removeFilter,
  removeGlossaryEntry,
  renameFeed,
  setRead,
  saveTranslations,
  updateFilter,
  updateGlossaryEntry,
  updateSettings,
  updateTranslationSettings,
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
  translateVisible: document.getElementById('translate-visible'),
  markAllRead: document.getElementById('mark-all-read'),
  listStatus: document.getElementById('list-status'),
  itemList: document.getElementById('item-list'),
  previewEmpty: document.getElementById('preview-empty'),
  previewArticle: document.getElementById('preview-article'),
  previewTitle: document.getElementById('preview-title'),
  previewTitleOriginal: document.getElementById('preview-title-original'),
  previewMeta: document.getElementById('preview-meta'),
  previewLink: document.getElementById('preview-link'),
  previewBody: document.getElementById('preview-body'),
  previewTranslation: document.getElementById('preview-translation'),
  previewTranslationSummary: document.getElementById('preview-translation-summary'),
  toggleRead: document.getElementById('toggle-read'),
  translateItem: document.getElementById('translate-item'),
  translateEnabled: document.getElementById('translate-enabled'),
  translateAuto: document.getElementById('translate-auto'),
  translateShowOriginal: document.getElementById('translate-show-original'),
  translateStatus: document.getElementById('translate-status'),
  translatePrepare: document.getElementById('translate-prepare'),
  addGlossaryForm: document.getElementById('add-glossary-form'),
  glossarySource: document.getElementById('glossary-source'),
  glossaryTarget: document.getElementById('glossary-target'),
  addGlossaryMessage: document.getElementById('add-glossary-message'),
  glossaryList: document.getElementById('glossary-list'),
  retranslateAll: document.getElementById('retranslate-all'),
  openSettings: document.getElementById('open-settings'),
  closeSettings: document.getElementById('close-settings'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsSummary: document.getElementById('settings-summary'),
  refreshMinutes: document.getElementById('refresh-minutes'),
  refreshStatus: document.getElementById('refresh-status'),
  settingsTabs: Array.from(document.querySelectorAll('.settings-tab')),
  settingsPanels: Array.from(document.querySelectorAll('.settings-panel')),
};

/** 画面状態。state.data はストレージのスナップショット。 */
const state = {
  data: { feeds: [], items: {}, filters: [], glossary: [], settings: {} },
  selectedFeedId: ALL_FEEDS,
  selectedItemId: null,
  search: '',
  visible: [],
  refreshingFeedIds: new Set(),
  // 翻訳中フラグ。訳文の保存自体が storage の変更通知を起こすので、
  // 再入して同じ記事を訳し直さないようにこれで塞ぐ
  translating: false,
  translateStatus: '',
  // 内蔵翻訳の利用可否 ('available' | 'downloadable' | 'downloading' | 'unavailable')
  translatorAvailability: 'unavailable',
  // 自動翻訳で一度試した記事。失敗した記事を無限に訳し直さないための歯止め
  autoTranslateAttempted: new Set(),
  // 設定ダイアログで選択中のタブ ('filters' | 'translation' | 'glossary')。永続化はしない
  settingsTab: 'filters',
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

/** 一覧に載せる長さへ切り詰める。 */
function clip(text, limit) {
  const flat = (text || '').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// --------------------------------------------------------------- 翻訳の表示

function translationSettings() {
  return state.data.settings.translation || {};
}

/** 翻訳表示が有効で、その記事に訳文があるか。 */
function isTranslated(item) {
  return Boolean(translationSettings().enabled && (item.titleJa || item.summaryJa));
}

/**
 * 主表示に使う文字列と、併記する原文を返す。
 * 訳が無い / 翻訳表示が OFF のときは原文だけを主表示にする。
 */
function displayTitle(item) {
  const original = item.title || '(タイトルなし)';
  if (!isTranslated(item) || !item.titleJa) return { text: original, original: '' };
  return { text: item.titleJa, original: translationSettings().showOriginal ? original : '' };
}

/**
 * 一覧の要約に出す文字列。
 * 原文は詳細側の本文で読めるので、要約は原文を併記せず訳文に置き換える。
 */
function displaySummary(item, limit = 160) {
  if (isTranslated(item) && item.summaryJa) return clip(item.summaryJa, limit);
  return toPlainText(item.summary || item.content, limit);
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

    const titleText = displayTitle(item);
    const title = document.createElement('p');
    title.className = 'item-title';
    title.append(highlighted(titleText.text, terms));
    main.append(title);

    if (titleText.original) {
      const original = document.createElement('p');
      original.className = 'item-title-original';
      original.append(highlighted(titleText.original, terms));
      main.append(original);
    }

    const meta = document.createElement('p');
    meta.className = 'item-meta';
    const source = document.createElement('span');
    source.className = 'item-source';
    source.textContent = titles[item.feedId] || '';
    const time = document.createElement('time');
    time.textContent = relativeTime(item.published);
    time.title = absoluteTime(item.published);
    meta.append(source, document.createTextNode(' ・ '), time);
    if (isTranslated(item)) {
      const flag = document.createElement('span');
      flag.className = 'translated-flag';
      flag.textContent = '訳';
      flag.title = '日本語に翻訳済み';
      meta.append(document.createTextNode(' '), flag);
    }
    main.append(meta);

    const summary = document.createElement('p');
    summary.className = 'item-summary';
    summary.append(highlighted(displaySummary(item), terms));
    main.append(summary);

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

  const titleText = displayTitle(item);
  el.previewTitle.textContent = titleText.text;
  el.previewTitleOriginal.textContent = titleText.original;
  el.previewTitleOriginal.hidden = !titleText.original;
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

  const translatedSummary = isTranslated(item) ? item.summaryJa : '';
  el.previewTranslationSummary.textContent = translatedSummary;
  el.previewTranslation.hidden = !translatedSummary;

  // 翻訳表示が ON なら常に出す。翻訳済みの記事では「訳し直す」に変わり、
  // 用語集を直したあとにその記事だけ訳し直せるようにする
  el.translateItem.hidden = !(
    translationSettings().enabled && isTranslatorSupported() && hasTranslatableSource(item)
  );
  const untranslated = needsTranslation(item);
  el.translateItem.textContent = untranslated ? 'この記事を翻訳' : '訳し直す';
  el.translateItem.title = untranslated
    ? 'この記事を日本語に翻訳します'
    : '保存済みの訳文を捨てて、いまの用語集で翻訳し直します';

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

function renderGlossary() {
  el.glossaryList.replaceChildren();
  if (state.data.glossary.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'filter-empty';
    empty.textContent = '用語は未登録です。';
    el.glossaryList.append(empty);
    return;
  }
  for (const entry of state.data.glossary) {
    const row = document.createElement('li');
    row.className = 'glossary-row';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.enabled !== false;
    toggle.title = '有効 / 無効';
    toggle.addEventListener('change', async () => {
      await updateGlossaryEntry(entry.id, { enabled: toggle.checked });
    });

    const pair = document.createElement('span');
    pair.className = 'glossary-pair';
    if (entry.enabled === false) pair.classList.add('disabled');
    const source = document.createElement('span');
    source.className = 'glossary-source';
    source.textContent = entry.source;
    const target = document.createElement('span');
    target.className = 'glossary-target';
    target.textContent = entry.target;
    pair.append(source, document.createTextNode(' → '), target);

    row.append(
      toggle,
      pair,
      iconButton('✕', 'この用語を削除', () => removeGlossaryEntry(entry.id))
    );
    el.glossaryList.append(row);
  }
}

/** 翻訳セクションのチェックボックス・状態表示・準備ボタンを描画する。 */
function renderTranslationPanel() {
  const settings = translationSettings();
  el.translateEnabled.checked = Boolean(settings.enabled);
  el.translateAuto.checked = Boolean(settings.auto);
  el.translateShowOriginal.checked = Boolean(settings.showOriginal);
  el.translateAuto.disabled = !settings.enabled;
  el.translateShowOriginal.disabled = !settings.enabled;

  const supported = isTranslatorSupported();
  el.translateVisible.hidden = !(settings.enabled && supported);
  el.translatePrepare.hidden = !(
    settings.enabled && supported && state.translatorAvailability === 'downloadable'
  );

  if (!supported) {
    el.translateStatus.textContent =
      'この Chrome では内蔵翻訳を利用できません（Chrome 138 以降が必要です）。';
    el.translateStatus.hidden = false;
    return;
  }
  if (state.translateStatus) {
    el.translateStatus.textContent = state.translateStatus;
    el.translateStatus.hidden = false;
    return;
  }
  if (!settings.enabled) {
    el.translateStatus.hidden = true;
    return;
  }
  const notes = {
    downloadable: '翻訳モデルが未取得です。「翻訳モデルを準備」を押してください。',
    downloading: '翻訳モデルを取得しています…',
    unavailable: 'この端末では英語→日本語の翻訳モデルを利用できません。',
    available: '端末内で翻訳します（外部への送信はありません）。',
  };
  el.translateStatus.textContent = notes[state.translatorAvailability] || '';
  el.translateStatus.hidden = !el.translateStatus.textContent;
}

const REFRESH_CHOICES = [5, 15, 30, 60];

/** 更新間隔の選択を設定に合わせる。選択肢に無い値は最も近いものへ寄せる。 */
function renderRefreshPanel() {
  const saved = Number(state.data.settings.refreshMinutes) || 30;
  const closest = REFRESH_CHOICES.reduce((best, value) =>
    Math.abs(value - saved) < Math.abs(best - saved) ? value : best
  );
  el.refreshMinutes.value = String(closest);
  el.refreshStatus.textContent =
    closest === saved
      ? `いまは ${saved} 分ごとに全フィードを取得します。`
      : `保存されている値は ${saved} 分です（選択肢に無いため ${closest} 分を表示しています）。`;
}

/** サイドバー最下部に、設定画面へ移した項目の状態を 1 行で示す。 */
function renderSettingsSummary() {
  const filters = state.data.filters || [];
  const enabledFilters = filters.filter((f) => f.enabled !== false).length;
  const glossary = state.data.glossary || [];
  const parts = [
    `更新 ${Number(state.data.settings.refreshMinutes) || 30} 分`,
    filters.length === 0
      ? 'フィルタなし'
      : `フィルタ ${enabledFilters}/${filters.length} 件`,
    `翻訳 ${translationSettings().enabled ? 'ON' : 'OFF'}`,
  ];
  if (glossary.length > 0) parts.push(`用語 ${glossary.length} 件`);
  el.settingsSummary.textContent = `⚙ ${parts.join(' ・ ')}`;
}

/** 設定ダイアログのタブを切り替える。 */
function selectSettingsTab(name) {
  state.settingsTab = name;
  for (const tab of el.settingsTabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of el.settingsPanels) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function openSettingsDialog(tab) {
  selectSettingsTab(tab || state.settingsTab);
  if (!el.settingsDialog.open) el.settingsDialog.showModal();
}

function renderAll() {
  el.unreadOnly.checked = Boolean(state.data.settings.unreadOnly);
  el.autoMarkRead.checked = Boolean(state.data.settings.autoMarkRead);
  el.sortOrder.value = state.data.settings.sortOrder || 'newest';
  renderFeeds();
  renderFilters();
  renderGlossary();
  renderRefreshPanel();
  renderTranslationPanel();
  renderSettingsSummary();
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
    await maybeAutoTranslate();
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
    await maybeAutoTranslate();
  }
}

// ------------------------------------------------------------------- 翻訳

// 言語ペアごとの可否は記事を訳すまで分からないので、代表として英語→日本語で判定する。
// 実際の翻訳は記事ごとに判定した言語で translator を作る。
const REPRESENTATIVE_SOURCE_LANG = 'en';

function setTranslateStatus(text) {
  state.translateStatus = text;
  renderTranslationPanel();
}

async function refreshTranslatorAvailability() {
  state.translatorAvailability = await checkAvailability(REPRESENTATIVE_SOURCE_LANG, TARGET_LANG);
  renderTranslationPanel();
}

/**
 * 言語モデルの取得はユーザー操作を求められることがあるため、
 * ボタン (＝明示的な操作) からだけ実行する。
 */
async function prepareTranslationModel() {
  el.translatePrepare.disabled = true;
  setTranslateStatus('翻訳モデルを準備しています…');
  const pool = createTranslatorPool({
    onDownloadProgress: ({ loaded }) => {
      setTranslateStatus(`翻訳モデルを取得中… ${Math.round((loaded || 0) * 100)}%`);
    },
  });
  try {
    await pool.get(REPRESENTATIVE_SOURCE_LANG, TARGET_LANG);
    setTranslateStatus('翻訳モデルの準備ができました。');
  } catch (error) {
    setTranslateStatus(`翻訳モデルを準備できませんでした: ${error.message}`);
  } finally {
    await pool.close();
    el.translatePrepare.disabled = false;
    await refreshTranslatorAvailability();
  }
}

/**
 * 記事をまとめて翻訳して保存する。多重起動は state.translating で塞ぐ。
 * @param {Array<object>} items 対象記事
 * @param {{force?: boolean}} [options] force を立てると翻訳済みの記事も訳し直す
 */
async function runTranslation(items, { force = false } = {}) {
  if (state.translating) return;
  // 取得中は mergeItems と書き込みがぶつかるので待ってもらう
  if (state.refreshingFeedIds.size > 0) {
    setTranslateStatus('フィードの取得が終わってから翻訳してください。');
    return;
  }
  const targets = items.filter(force ? hasTranslatableSource : needsTranslation);
  if (targets.length === 0) {
    setTranslateStatus('翻訳が必要な記事はありません。');
    return;
  }

  state.translating = true;
  el.translateVisible.disabled = true;
  el.translateItem.disabled = true;
  setTranslateStatus(`翻訳しています… 0 / ${targets.length} 件`);
  try {
    const { results, failed, error } = await translateItems(targets, {
      glossary: state.data.glossary,
      skipSameLanguage: translationSettings().skipSameLanguage !== false,
      onProgress: ({ done, total, phase, loaded }) => {
        if (phase === 'download') {
          setTranslateStatus(`翻訳モデルを取得中… ${Math.round((loaded || 0) * 100)}%`);
        } else if (phase === 'translate') {
          setTranslateStatus(`翻訳しています… ${done} / ${total} 件`);
        }
      },
    });
    if (error) {
      setTranslateStatus(error);
      return;
    }
    const saved = await saveTranslations(results);
    setTranslateStatus(
      failed > 0 ? `${saved} 件を翻訳しました（${failed} 件は失敗）。` : `${saved} 件を翻訳しました。`
    );
  } catch (error) {
    setTranslateStatus(`翻訳に失敗しました: ${error.message}`);
  } finally {
    state.translating = false;
    el.translateVisible.disabled = false;
    el.translateItem.disabled = false;
    await reload();
  }
}

/** 自動翻訳。モデルが手元にあるときだけ走らせ、失敗した記事は繰り返さない。 */
async function maybeAutoTranslate() {
  const { enabled, auto, maxAutoItems } = translationSettings();
  if (!enabled || !auto || state.translating) return;
  if (state.refreshingFeedIds.size > 0) return;
  if (!isTranslatorSupported() || state.translatorAvailability !== 'available') return;

  const targets = Object.values(state.data.items)
    .flat()
    .filter((item) => needsTranslation(item) && !state.autoTranslateAttempted.has(item.id))
    .slice(0, maxAutoItems || 60);
  if (targets.length === 0) return;
  for (const item of targets) state.autoTranslateAttempted.add(item.id);
  await runTranslation(targets);
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

el.addGlossaryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage(el.addGlossaryMessage, '');
  try {
    await addGlossaryEntry(el.glossarySource.value, el.glossaryTarget.value);
    el.glossarySource.value = '';
    el.glossaryTarget.value = '';
  } catch (error) {
    showMessage(el.addGlossaryMessage, error.message, true);
  }
});

el.refreshAll.addEventListener('click', refreshAllFeeds);
el.markAllRead.addEventListener('click', markVisibleRead);

el.translateVisible.addEventListener('click', () => runTranslation(state.visible));

el.translateItem.addEventListener('click', () => {
  const item = state.selectedItemId ? findItem(state.selectedItemId) : null;
  // 翻訳済みでも押せるボタンなので、常に訳し直しとして実行する
  if (item) runTranslation([item], { force: true });
});

el.translatePrepare.addEventListener('click', prepareTranslationModel);

el.translateEnabled.addEventListener('change', async () => {
  // 先に値を読む。setTranslateStatus は保存前の state で再描画してチェックを戻してしまうため、
  // ここでは state を直接触るだけにする
  const enabled = el.translateEnabled.checked;
  state.translateStatus = '';
  await updateTranslationSettings({ enabled });
  if (enabled) await refreshTranslatorAvailability();
});

el.translateAuto.addEventListener('change', async () => {
  await updateTranslationSettings({ auto: el.translateAuto.checked });
  await maybeAutoTranslate();
});

el.translateShowOriginal.addEventListener('change', async () => {
  await updateTranslationSettings({ showOriginal: el.translateShowOriginal.checked });
});

el.refreshMinutes.addEventListener('change', async () => {
  // 保存すると background の ensureRefreshAlarm が周期の変化を見てアラームを組み直す
  await updateSettings({ refreshMinutes: Number(el.refreshMinutes.value) });
});

el.openSettings.addEventListener('click', () => openSettingsDialog());
el.settingsSummary.addEventListener('click', () => openSettingsDialog());
el.closeSettings.addEventListener('click', () => el.settingsDialog.close());
// 背景 (::backdrop) のクリックで閉じる。dialog 自身が click の対象になるのは背景だけ
el.settingsDialog.addEventListener('click', (event) => {
  if (event.target === el.settingsDialog) el.settingsDialog.close();
});
for (const tab of el.settingsTabs) {
  tab.addEventListener('click', () => selectSettingsTab(tab.dataset.tab));
}

el.retranslateAll.addEventListener('click', async () => {
  if (!confirm('保存済みの訳文をすべて破棄します。よろしいですか？')) return;
  state.autoTranslateAttempted.clear();
  setTranslateStatus('');
  await clearTranslations();
  await reload();
});

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
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!(changes.feeds || changes.items || changes.filters || changes.glossary || changes.settings)) {
    return;
  }
  await reload();
  // バックグラウンド更新で入った記事もここで拾う (訳文の保存自体でも発火するが、
  // 翻訳済みの記事は needsTranslation に弾かれるので繰り返しにはならない)
  if (changes.items) await maybeAutoTranslate();
});

// キーボード操作
document.addEventListener('keydown', (event) => {
  // 設定ダイアログ表示中は背後の記事一覧を操作しない (Escape での閉じるは dialog に任せる)
  if (el.settingsDialog.open) return;

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

(async () => {
  await reload();
  await refreshTranslatorAvailability();
  await maybeAutoTranslate();
})();
