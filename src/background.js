// Service Worker: 定期更新、未読数バッジ、リーダータブの起動。
import { refreshAll } from './lib/refresh.js';
import { countUnread, getSettings, getState } from './lib/store.js';

const ALARM_NAME = 'rss-refresh';
const OFFSCREEN_PATH = 'src/offscreen.html';
const READER_URL = chrome.runtime.getURL('src/reader.html');

// ---------------------------------------------------------------- offscreen

let creatingOffscreen = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  // 並行呼び出しで二重生成しないよう、進行中の作成を共有する
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_PARSER'],
        justification: 'RSS/Atom フィードの XML を DOMParser で解析するため',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

/** offscreen document 経由で XML を解析する。 */
async function parseViaOffscreen(xml, feedUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'parse-feed',
    xml,
    feedUrl,
  });
  if (!response) throw new Error('XML 解析プロセスが応答しませんでした');
  if (!response.ok) throw new Error(response.error);
  return response.parsed;
}

// ------------------------------------------------------------------- badge

async function updateBadge() {
  const { items } = await getState();
  const { total } = countUnread(items);
  await chrome.action.setBadgeBackgroundColor({ color: '#e8590c' });
  await chrome.action.setBadgeText({ text: total > 0 ? (total > 999 ? '999+' : String(total)) : '' });
}

// ------------------------------------------------------------------ alarms

/** 設定から実際に使う周期を求める。chrome.alarms の最小周期は 1 分。 */
async function refreshPeriodMinutes() {
  const { refreshMinutes } = await getSettings();
  return Math.max(1, Number(refreshMinutes) || 30);
}

/**
 * 定期更新のアラームが正しい周期で存在することを保証する。
 *
 * アラームを作り直すと次回実行までの待ち時間がリセットされるため、
 * 周期が変わったとき (と、そもそもアラームが無いとき) だけ作り直す。
 * これにより、翻訳設定など更新間隔と無関係な変更で更新が先送りされることが無くなる。
 *
 * @returns {Promise<'kept'|'created'|'rescheduled'>} 何をしたか (ログとテスト用)
 */
async function ensureRefreshAlarm() {
  const period = await refreshPeriodMinutes();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && existing.periodInMinutes === period) return 'kept';
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: period, delayInMinutes: period });
  return existing ? 'rescheduled' : 'created';
}

let refreshing = false;

/** 全フィードを更新する。多重起動は無視する。 */
async function runRefresh() {
  if (refreshing) return { skipped: true };
  refreshing = true;
  try {
    const result = await refreshAll(parseViaOffscreen);
    await updateBadge();
    return result;
  } finally {
    refreshing = false;
  }
}

// ------------------------------------------------------------------ events

chrome.runtime.onInstalled.addListener(() => {
  ensureRefreshAlarm();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runRefresh();
});

// 既読操作やリーダー側の更新をバッジへ反映する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.items) updateBadge();
  // 更新間隔が変わっていなければ ensureRefreshAlarm は何もしない
  if (area === 'local' && changes.settings) ensureRefreshAlarm();
});

// ツールバーアイコン: 既に開いているリーダータブを再利用する
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: READER_URL });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: READER_URL });
  }
});

// リーダーページからの要求
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  if (message.type === 'refresh-all') {
    runRefresh().then(sendResponse, (error) =>
      sendResponse({ error: error.message || '更新に失敗しました' })
    );
    return true;
  }
  if (message.type === 'update-badge') {
    updateBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- self-heal

// Service Worker は停止と再起動を繰り返し、onInstalled / onStartup は毎回は起きない。
// アラームが何らかの理由で失われると定期更新が二度と走らなくなるため、
// SW が起動するたびにトップレベルで存在を確かめ、無ければ作り直す。
ensureRefreshAlarm();
