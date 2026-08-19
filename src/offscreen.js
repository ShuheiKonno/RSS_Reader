// Service Worker から渡された XML を DOMParser で解析して返すだけのブリッジ。
import { parseFeed } from './lib/parser.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || message.type !== 'parse-feed') return false;
  try {
    sendResponse({ ok: true, parsed: parseFeed(message.xml, message.feedUrl, DOMParser) });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || 'XML の解析に失敗しました' });
  }
  return true;
});
