// 検索・キーワードフィルタ・未読絞り込み・並び順の適用ロジック。
// UI から切り離してあるためそのまま単体テストできる。

/** 検索文字列をスペース区切りの語に分解する (全角スペースも区切りとして扱う)。 */
export function parseQuery(input) {
  return (input || '')
    .split(/[\s　]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

/** 記事から検索対象の文字列を作る。訳文も含めるので日本語でも検索できる。 */
function haystack(item, feedTitle) {
  return [item.title, item.titleJa, item.summary, item.summaryJa, item.content, item.author, feedTitle]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/** キーワードフィルタの照合対象はタイトルと要約 (本文全文は誤爆しやすいため除く)。 */
function filterTarget(item) {
  return [item.title, item.titleJa, item.summary, item.summaryJa]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/**
 * 記事一覧に検索・フィルタ・並び順を適用する。
 * @param {Array<object>} items 対象記事 (feedId 絞り込みは呼び出し側で済ませておく)
 * @param {object} options
 * @param {string} options.search 検索文字列 (スペース区切りは AND)
 * @param {Array<object>} options.filters キーワードルール {keyword, mode, enabled}
 * @param {boolean} options.unreadOnly 未読のみ表示
 * @param {'newest'|'oldest'} options.sortOrder
 * @param {Record<string,string>} options.feedTitles feedId -> フィード名 (検索対象に含める)
 */
export function applyQuery(items, options = {}) {
  const {
    search = '',
    filters = [],
    unreadOnly = false,
    sortOrder = 'newest',
    feedTitles = {},
  } = options;

  const active = filters.filter((f) => f.enabled && f.keyword.trim());
  const excludes = active.filter((f) => f.mode === 'exclude').map((f) => f.keyword.toLowerCase());
  const includes = active.filter((f) => f.mode === 'include').map((f) => f.keyword.toLowerCase());
  const terms = parseQuery(search);

  const result = items.filter((item) => {
    const target = filterTarget(item);
    // 除外キーワードは 1 つでも一致したら落とす
    if (excludes.some((keyword) => target.includes(keyword))) return false;
    // 含めるキーワードがあるときは、いずれかに一致する記事だけ残す (OR)
    if (includes.length > 0 && !includes.some((keyword) => target.includes(keyword))) return false;
    if (terms.length > 0) {
      const searchable = haystack(item, feedTitles[item.feedId]);
      if (!terms.every((term) => searchable.includes(term))) return false;
    }
    if (unreadOnly && item.read) return false;
    return true;
  });

  const direction = sortOrder === 'oldest' ? 1 : -1;
  return result.sort(
    (a, b) => direction * ((a.published ?? a.fetchedAt ?? 0) - (b.published ?? b.fetchedAt ?? 0))
  );
}

/**
 * ハイライト対象の語 (検索語 + 有効な include キーワード) を返す。
 * 長い語を先に並べ、部分一致の取りこぼしを防ぐ。
 */
export function highlightTerms(search, filters = []) {
  const includes = filters
    .filter((f) => f.enabled && f.mode === 'include' && f.keyword.trim())
    .map((f) => f.keyword.toLowerCase());
  const unique = Array.from(new Set([...parseQuery(search), ...includes]));
  return unique.sort((a, b) => b.length - a.length);
}
