// Chrome 内蔵の Translator API (端末内実行・無料・キー不要) で件名と要約を日本語にする。
// 外部サービスへは一切送信しない。Chrome 138 以降でのみ動作するため、呼び出し側は
// isTranslatorSupported() / checkAvailability() で機能検出してから使うこと。
//
// Translator API はサービスワーカーからは使えない前提で組んでいるので、
// このモジュールはリーダーページ (reader.js) からのみ呼ばれる。

import { toPlainText } from './sanitize.js';

export const TARGET_LANG = 'ja';

// 要約は一覧で読み流す長さがあれば十分。翻訳にかける文字数もこれで抑える。
const SUMMARY_SOURCE_LIMIT = 300;

/** Translator API が使える環境か。 */
export function isTranslatorSupported() {
  return typeof Translator !== 'undefined' && typeof Translator.create === 'function';
}

/**
 * 言語ペアの利用可否を調べる。
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>}
 */
export async function checkAvailability(sourceLanguage, targetLanguage = TARGET_LANG) {
  if (!isTranslatorSupported()) return 'unavailable';
  try {
    return await Translator.availability({ sourceLanguage, targetLanguage });
  } catch {
    return 'unavailable';
  }
}

// ------------------------------------------------------------------ 言語判定

/** BCP 47 タグから地域などを落として主言語だけにする (en-US → en)。 */
function baseLanguage(tag) {
  const value = (tag || '').trim().toLowerCase();
  if (!value || value === 'und') return '';
  return value.split('-')[0];
}

/**
 * LanguageDetector を 1 つ作る。使えない環境では null。
 * 生成コストがあるので 1 回の翻訳の間だけ使い回し、終わったら release() で解放する
 * (モデルを常駐させないため、モジュール内には保持しない)。
 */
export async function createDetector() {
  if (typeof LanguageDetector === 'undefined' || typeof LanguageDetector.create !== 'function') {
    return null;
  }
  try {
    return await LanguageDetector.create();
  } catch {
    return null;
  }
}

function release(resource) {
  if (resource && typeof resource.destroy === 'function') resource.destroy();
}

/**
 * 記事本文の言語を推定する。
 * LanguageDetector が無い環境では chrome.i18n.detectLanguage にフォールバックする
 * (どちらも追加権限は不要)。判定できなければ空文字。
 * @param {string} text
 * @param {object|null} [detector] createDetector() の戻り値。省略時はこの呼び出し限りで用意する
 */
export async function detectLanguage(text, detector = undefined) {
  const sample = (text || '').trim();
  if (!sample) return '';

  const own = detector === undefined;
  const activeDetector = own ? await createDetector() : detector;
  try {
    return await detectWith(activeDetector, sample);
  } finally {
    if (own) release(activeDetector);
  }
}

async function detectWith(detector, sample) {
  if (detector) {
    try {
      const results = await detector.detect(sample);
      const best = Array.isArray(results) ? results[0] : null;
      const language = baseLanguage(best && best.detectedLanguage);
      if (language) return language;
    } catch {
      // 内蔵判定が失敗したら下のフォールバックへ落ちる
    }
  }

  if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.detectLanguage) {
    try {
      const result = await chrome.i18n.detectLanguage(sample);
      const best = (result && result.languages && result.languages[0]) || null;
      return baseLanguage(best && best.language);
    } catch {
      return '';
    }
  }
  return '';
}

// -------------------------------------------------------------------- 用語集

// 機械翻訳が壊しにくいよう、記号ではなく英数字だけのトークンを使う。
const PLACEHOLDER = (index) => `TTZ${index}ZTT`;

function activeGlossary(glossary) {
  return (glossary || [])
    .filter((entry) => entry && entry.enabled !== false && entry.source && entry.target)
    // 長い語から当てないと "pull request" が "request" に食われる
    .sort((a, b) => b.source.length - a.source.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用語の出現位置に当てる正規表現。
 * ASCII の語は単語境界を見て部分一致を防ぐ (Go が Google に当たるのを避ける)。
 * 日本語などは語境界の概念が無いのでそのまま一致させる。
 */
function termPattern(source) {
  const escaped = escapeRegExp(source);
  const asciiWord = /^[A-Za-z0-9][A-Za-z0-9 .+#_-]*$/.test(source);
  return new RegExp(asciiWord ? `\\b${escaped}\\b` : escaped, 'gi');
}

/**
 * 訳す前に用語をプレースホルダへ退避する。
 * @returns {{text: string, map: Array<{token: string, source: string, target: string}>}}
 */
export function protectTerms(text, glossary) {
  const entries = activeGlossary(glossary);
  const map = [];
  let result = text || '';
  for (const entry of entries) {
    const pattern = termPattern(entry.source);
    if (!pattern.test(result)) continue;
    pattern.lastIndex = 0;
    const token = PLACEHOLDER(map.length);
    result = result.replace(pattern, token);
    map.push({ token, source: entry.source, target: entry.target });
  }
  return { text: result, map };
}

/**
 * 訳文のプレースホルダを訳語へ戻す。
 * 翻訳エンジンがトークンを壊した場合に備えて、見つからなかった用語は
 * 訳文に対する原語→訳語の素朴な置換でフォールバックする。
 */
export function restoreTerms(translated, map) {
  let result = translated || '';
  for (const { token, source, target } of map || []) {
    // 大小が変わって返ってくることがあるので大文字小文字は無視する
    const tokenPattern = new RegExp(escapeRegExp(token), 'gi');
    if (tokenPattern.test(result)) {
      tokenPattern.lastIndex = 0;
      result = result.replace(tokenPattern, target);
    } else {
      result = result.replace(termPattern(source), target);
    }
  }
  return result;
}

// ------------------------------------------------------------- translator プール

/**
 * 言語ペアごとに Translator を使い回すプールを作る。
 * 使い終わったら close() を呼んでモデルを解放すること。
 * @param {object} options
 * @param {(progress: {loaded: number, sourceLang: string}) => void} [options.onDownloadProgress]
 */
export function createTranslatorPool({ onDownloadProgress } = {}) {
  const pool = new Map();

  async function get(sourceLanguage, targetLanguage = TARGET_LANG) {
    const key = `${sourceLanguage}>${targetLanguage}`;
    if (!pool.has(key)) {
      const created = Translator.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            if (onDownloadProgress) {
              onDownloadProgress({ loaded: event.loaded, sourceLang: sourceLanguage });
            }
          });
        },
      });
      // 失敗した Promise を残すと次回以降も同じ失敗を返してしまうので消しておく
      pool.set(
        key,
        created.catch((error) => {
          pool.delete(key);
          throw error;
        })
      );
    }
    return pool.get(key);
  }

  async function close() {
    for (const pending of pool.values()) {
      try {
        const translator = await pending;
        if (translator && typeof translator.destroy === 'function') translator.destroy();
      } catch {
        // 生成に失敗した translator は解放するものが無い
      }
    }
    pool.clear();
  }

  return { get, close };
}

/** 用語集を当てながら 1 つの文字列を訳す。 */
async function translateText(translator, text, glossary) {
  if (!text) return '';
  const { text: protectedText, map } = protectTerms(text, glossary);
  const translated = await translator.translate(protectedText);
  return restoreTerms(translated, map).trim();
}

/** 翻訳対象になる原文を記事から取り出す (要約は HTML を落としてから使う)。 */
export function translationSource(item) {
  return {
    title: (item.title || '').trim(),
    summary: toPlainText(item.summary || item.content, SUMMARY_SOURCE_LIMIT),
  };
}

/** 翻訳にかけられる原文を持っているか (訳し直しの可否はこちらで判断する)。 */
export function hasTranslatableSource(item) {
  if (!item) return false;
  return Boolean((item.title || '').trim() || (item.summary || item.content || '').trim());
}

/** その記事がまだ翻訳されていないか。 */
export function needsTranslation(item) {
  if (!item) return false;
  // translatedAt は「日本語なので訳さなかった」記事にも入るので、これだけ見れば足りる
  if (item.translatedAt) return false;
  return hasTranslatableSource(item);
}

/**
 * 記事をまとめて翻訳する。1 件の失敗で全体を止めない。
 * @param {Array<object>} items 対象記事
 * @param {object} options
 * @param {Array<object>} [options.glossary] 用語集
 * @param {boolean} [options.skipSameLanguage] 既に日本語の記事を飛ばす (既定 true)
 * @param {(progress: {done: number, total: number, phase: string, loaded?: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{results: Array<object>, failed: number, error: string}>}
 *   results は store.saveTranslations にそのまま渡せる形
 */
export async function translateItems(items, options = {}) {
  const { glossary = [], skipSameLanguage = true, onProgress, signal } = options;
  const results = [];
  let failed = 0;

  if (!isTranslatorSupported()) {
    return { results, failed: 0, error: 'この Chrome では内蔵翻訳を利用できません（Chrome 138 以降が必要です）' };
  }

  const pool = createTranslatorPool({
    onDownloadProgress: ({ loaded }) => {
      if (onProgress) onProgress({ done: results.length, total: items.length, phase: 'download', loaded });
    },
  });
  // 言語判定器はこの実行の間だけ使い回す
  const detector = await createDetector();

  try {
    for (const item of items) {
      if (signal && signal.aborted) break;
      if (onProgress) onProgress({ done: results.length, total: items.length, phase: 'translate' });

      const source = translationSource(item);
      if (!source.title && !source.summary) continue;

      try {
        const sourceLang = await detectLanguage(`${source.title}\n${source.summary}`, detector);
        if (!sourceLang) {
          failed += 1;
          continue;
        }
        if (skipSameLanguage && sourceLang === TARGET_LANG) {
          // 訳さなくてよいことを記録して、次回以降の対象から外す
          results.push({ feedId: item.feedId, itemId: item.id, titleJa: '', summaryJa: '', sourceLang });
          continue;
        }

        const translator = await pool.get(sourceLang);
        results.push({
          feedId: item.feedId,
          itemId: item.id,
          titleJa: await translateText(translator, source.title, glossary),
          summaryJa: await translateText(translator, source.summary, glossary),
          sourceLang,
        });
      } catch {
        failed += 1;
      }
    }
  } finally {
    release(detector);
    await pool.close();
  }

  if (onProgress) onProgress({ done: results.length, total: items.length, phase: 'done' });
  return { results, failed, error: '' };
}
