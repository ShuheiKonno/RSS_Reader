// 拡張機能のロジックを Node 上で検証する (linkedom で DOM を用意し、chrome API をスタブ)。
import assert from 'node:assert/strict';
import { DOMParser, parseHTML } from 'linkedom';

const SRC = new URL('../src/lib', import.meta.url).pathname;

// ---- グローバルのスタブ -----------------------------------------------------
const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.DOMParser = DOMParser;
globalThis.document = document;

const memory = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          list.filter((k) => k in memory).map((k) => [k, structuredClone(memory[k])])
        );
      },
      async set(patch) {
        Object.assign(memory, structuredClone(patch));
      },
    },
  },
};

const { parseFeed } = await import(`${SRC}/parser.js`);
const store = await import(`${SRC}/store.js`);
const { applyQuery, highlightTerms, parseQuery } = await import(`${SRC}/query.js`);
const { sanitizeHtml, toPlainText } = await import(`${SRC}/sanitize.js`);
const translate = await import(`${SRC}/translate.js`);

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}

// ---- parser -----------------------------------------------------------------
console.log('\nparser.js');

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <item>
      <title>Chrome 拡張の作り方</title>
      <link>/posts/extension</link>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
      <pubDate>Tue, 18 Aug 2026 09:00:00 GMT</pubDate>
      <description><![CDATA[<p>MV3 の話</p>]]></description>
      <content:encoded><![CDATA[<p>本文です</p>]]></content:encoded>
      <dc:creator>山田</dc:creator>
    </item>
    <item>
      <title>guid なし記事</title>
      <link>https://example.com/posts/no-guid</link>
    </item>
    <item><description>タイトルなし</description></item>
  </channel>
</rss>`;

check('RSS 2.0: チャンネル情報と件数', () => {
  const feed = parseFeed(RSS2, 'https://example.com/feed.xml', DOMParser);
  assert.equal(feed.title, 'Example Blog');
  assert.equal(feed.siteUrl, 'https://example.com/');
  assert.equal(feed.items.length, 3);
});

check('RSS 2.0: 相対 link を絶対化', () => {
  const feed = parseFeed(RSS2, 'https://example.com/feed.xml', DOMParser);
  assert.equal(feed.items[0].link, 'https://example.com/posts/extension');
});

check('RSS 2.0: guid / pubDate / dc:creator / content:encoded', () => {
  const [first] = parseFeed(RSS2, 'https://example.com/feed.xml', DOMParser).items;
  assert.equal(first.id, 'tag:example.com,2026:1');
  assert.equal(first.published, Date.parse('Tue, 18 Aug 2026 09:00:00 GMT'));
  assert.equal(first.author, '山田');
  assert.equal(first.content, '<p>本文です</p>');
  assert.equal(first.summary, '<p>MV3 の話</p>');
});

check('RSS 2.0: guid が無ければ link を ID に使う', () => {
  const feed = parseFeed(RSS2, 'https://example.com/feed.xml', DOMParser);
  assert.equal(feed.items[1].id, 'https://example.com/posts/no-guid');
});

check('RSS 2.0: guid も link も無ければハッシュ ID', () => {
  const feed = parseFeed(RSS2, 'https://example.com/feed.xml', DOMParser);
  assert.match(feed.items[2].id, /^h:[0-9a-f]+$/);
});

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom サンプル</title>
  <link rel="self" href="https://atom.example/feed"/>
  <link rel="alternate" href="https://atom.example/"/>
  <entry>
    <title>Atom 記事</title>
    <id>urn:uuid:1234</id>
    <link rel="edit" href="https://atom.example/edit/1"/>
    <link rel="alternate" href="/entries/1"/>
    <updated>2026-08-17T12:00:00Z</updated>
    <summary>要約テキスト</summary>
    <content type="html">&lt;p&gt;Atom 本文&lt;/p&gt;</content>
    <author><name>Taro</name></author>
  </entry>
</feed>`;

check('Atom: alternate リンクとメタ情報', () => {
  const feed = parseFeed(ATOM, 'https://atom.example/feed', DOMParser);
  assert.equal(feed.title, 'Atom サンプル');
  assert.equal(feed.siteUrl, 'https://atom.example/');
  const [entry] = feed.items;
  assert.equal(entry.id, 'urn:uuid:1234');
  assert.equal(entry.link, 'https://atom.example/entries/1', 'rel=alternate を選ぶ');
  assert.equal(entry.author, 'Taro');
  assert.equal(entry.published, Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(entry.content, '<p>Atom 本文</p>');
});

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF サンプル</title><link>https://rdf.example/</link></channel>
  <item>
    <title>RDF 記事</title>
    <link>https://rdf.example/1</link>
    <dc:date>2026-08-16T00:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

check('RDF (RSS 1.0): root 直下の item と dc:date', () => {
  const feed = parseFeed(RDF, 'https://rdf.example/rdf', DOMParser);
  assert.equal(feed.title, 'RDF サンプル');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].published, Date.parse('2026-08-16T00:00:00+09:00'));
});

check('未対応のルート要素はエラー', () => {
  assert.throws(
    () => parseFeed('<html><body>not a feed</body></html>', 'https://x.example/', DOMParser),
    /対応していないフィード形式/
  );
});

// ---- sanitize ---------------------------------------------------------------
console.log('\nsanitize.js');

check('script / iframe / on* / javascript: を除去', () => {
  const html = `<div><p onclick="alert(1)">安全<script>alert(2)</script></p>
    <iframe src="https://evil.example"></iframe>
    <a href="javascript:alert(3)">危険リンク</a>
    <a href="https://ok.example">正常リンク</a>
    <img src="javascript:alert(4)" onerror="alert(5)">
    <img src="https://ok.example/a.png" onerror="alert(6)"></div>`;
  const wrapper = document.createElement('div');
  wrapper.appendChild(sanitizeHtml(html, document));
  const out = wrapper.innerHTML;
  assert.ok(!/script/i.test(out), 'script が残っている');
  assert.ok(!/iframe/i.test(out), 'iframe が残っている');
  assert.ok(!/onclick|onerror/i.test(out), 'イベント属性が残っている');
  assert.ok(!/javascript:/i.test(out), 'javascript: が残っている');
  assert.ok(out.includes('安全'), 'テキストが失われている');
  const links = wrapper.querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute('href'), null, '危険な href は付けない');
  assert.equal(links[1].getAttribute('href'), 'https://ok.example/');
  assert.equal(links[1].getAttribute('rel'), 'noopener noreferrer');
  assert.equal(links[1].getAttribute('target'), '_blank');
  assert.equal(wrapper.querySelectorAll('img').length, 1, '危険な img だけ落とす');
});

check('許可タグは構造を保つ', () => {
  const wrapper = document.createElement('div');
  wrapper.appendChild(sanitizeHtml('<ul><li><strong>a</strong></li><li>b</li></ul>', document));
  assert.equal(wrapper.querySelectorAll('li').length, 2);
  assert.equal(wrapper.querySelector('strong').textContent, 'a');
});

check('toPlainText はタグを落として省略する', () => {
  assert.equal(toPlainText('<div><p>あ  い</p><p>う</p></div>'), 'あ いう');
  assert.equal(toPlainText('<div>' + 'x'.repeat(50) + '</div>', 10), 'xxxxxxxxxx…');
  assert.equal(toPlainText(''), '');
});

// ---- query ------------------------------------------------------------------
console.log('\nquery.js');

const ITEMS = [
  { id: '1', feedId: 'f1', title: 'Chrome 拡張の作り方', summary: 'MV3 入門', content: '', author: '', published: 300, read: false },
  { id: '2', feedId: 'f1', title: '広告のニュース', summary: 'PR 記事です', content: '', author: '', published: 200, read: true },
  { id: '3', feedId: 'f2', title: 'Rust の話', summary: '所有権', content: 'Chrome とは無関係', author: 'taro', published: 100, read: false },
];
const FEED_TITLES = { f1: 'Web ブログ', f2: 'Rust 便り' };

check('検索: スペース区切りは AND、本文と著者も対象', () => {
  assert.deepEqual(applyQuery(ITEMS, { search: 'chrome 拡張' }).map((i) => i.id), ['1']);
  assert.deepEqual(applyQuery(ITEMS, { search: 'chrome' }).map((i) => i.id), ['1', '3']);
  assert.deepEqual(applyQuery(ITEMS, { search: 'taro' }).map((i) => i.id), ['3']);
  assert.deepEqual(applyQuery(ITEMS, { search: '　全角　スペース' }).map((i) => i.id), []);
});

check('検索: フィード名も対象', () => {
  assert.deepEqual(
    applyQuery(ITEMS, { search: 'rust 便り', feedTitles: FEED_TITLES }).map((i) => i.id),
    ['3']
  );
});

check('フィルタ: exclude で除外', () => {
  const filters = [{ id: 'a', keyword: '広告', mode: 'exclude', enabled: true }];
  assert.deepEqual(applyQuery(ITEMS, { filters }).map((i) => i.id), ['1', '3']);
});

check('フィルタ: include は OR で絞り込む', () => {
  const filters = [
    { id: 'a', keyword: 'Chrome', mode: 'include', enabled: true },
    { id: 'b', keyword: 'Rust', mode: 'include', enabled: true },
  ];
  // include はタイトル + 要約のみを見るので、本文だけ一致する id:3 は Rust で拾う
  assert.deepEqual(applyQuery(ITEMS, { filters }).map((i) => i.id), ['1', '3']);
});

check('フィルタ: enabled=false は無視される', () => {
  const filters = [{ id: 'a', keyword: '広告', mode: 'exclude', enabled: false }];
  assert.equal(applyQuery(ITEMS, { filters }).length, 3);
});

check('フィルタ: exclude は include より強い', () => {
  const filters = [
    { id: 'a', keyword: 'Chrome', mode: 'include', enabled: true },
    { id: 'b', keyword: '拡張', mode: 'exclude', enabled: true },
  ];
  assert.deepEqual(applyQuery(ITEMS, { filters }).map((i) => i.id), []);
});

check('未読のみ / 並び順', () => {
  assert.deepEqual(applyQuery(ITEMS, { unreadOnly: true }).map((i) => i.id), ['1', '3']);
  assert.deepEqual(applyQuery(ITEMS, {}).map((i) => i.id), ['1', '2', '3']);
  assert.deepEqual(applyQuery(ITEMS, { sortOrder: 'oldest' }).map((i) => i.id), ['3', '2', '1']);
});

check('検索・フィルタ: 訳文も対象になる', () => {
  const translated = [
    { id: 't1', feedId: 'f1', title: 'Shipping a Rust compiler', titleJa: 'Rust コンパイラの出荷',
      summary: 'notes', summaryJa: 'リリースノート', content: '', author: '', published: 400, read: false },
  ];
  assert.deepEqual(applyQuery(translated, { search: 'コンパイラ' }).map((i) => i.id), ['t1']);
  assert.deepEqual(applyQuery(translated, { search: 'リリース' }).map((i) => i.id), ['t1']);
  const filters = [{ id: 'a', keyword: 'コンパイラ', mode: 'exclude', enabled: true }];
  assert.deepEqual(applyQuery(translated, { filters }).map((i) => i.id), []);
});

check('ハイライト対象は検索語と include キーワード', () => {
  const filters = [
    { id: 'a', keyword: 'MV3', mode: 'include', enabled: true },
    { id: 'b', keyword: '広告', mode: 'exclude', enabled: true },
  ];
  assert.deepEqual(highlightTerms('chrome 拡張', filters), ['chrome', 'mv3', '拡張']);
  assert.deepEqual(parseQuery('  a　 b '), ['a', 'b']);
});

// ---- store ------------------------------------------------------------------
console.log('\nstore.js');

await checkAsync('addFeed: URL 正規化・スキーム補完・重複拒否', async () => {
  const { feed } = await store.addFeed('example.com/feed.xml');
  assert.equal(feed.url, 'https://example.com/feed.xml');
  await assert.rejects(() => store.addFeed('https://example.com/feed.xml'), /既に登録/);
  await assert.rejects(() => store.addFeed('  '), /URL を入力/);
  await assert.rejects(() => store.addFeed('ftp://example.com/f.xml'), /http または https/);
});

await checkAsync('mergeItems: 新規追加と既読状態の保持', async () => {
  const feedId = (await store.getState()).feeds[0].id;
  const now = Date.now();
  const first = await store.mergeItems(
    feedId,
    [
      { id: 'a', title: 'A', link: 'https://e/a', author: '', published: now - 3000, summary: 's', content: '' },
      { id: 'b', title: 'B', link: 'https://e/b', author: '', published: now - 2000, summary: 's', content: '' },
    ],
    { itemsPerFeed: 200, retentionDays: 30 }
  );
  assert.equal(first, 2, '2 件追加');

  await store.setRead(feedId, 'a', true);

  // 同じ ID を再取得しても既読は維持され、新規分だけカウントされる
  const second = await store.mergeItems(
    feedId,
    [
      { id: 'a', title: 'A 改題', link: 'https://e/a', author: '', published: now - 3000, summary: 's2', content: '' },
      { id: 'c', title: 'C', link: 'https://e/c', author: '', published: now - 1000, summary: 's', content: '' },
    ],
    { itemsPerFeed: 200, retentionDays: 30 }
  );
  assert.equal(second, 1, '新規は c だけ');

  const { items } = await store.getState();
  const list = items[feedId];
  assert.equal(list.length, 3, '重複していない');
  const a = list.find((i) => i.id === 'a');
  assert.equal(a.read, true, '既読が維持されている');
  assert.equal(a.title, 'A 改題', '本文は更新される');
});

await checkAsync('countUnread: フィードごとと合計', async () => {
  const { items } = await store.getState();
  const { total } = store.countUnread(items);
  assert.equal(total, 2, 'a を既読にしたので残り 2');
});

await checkAsync('markAllRead: itemIds 指定で表示中のみ既読', async () => {
  const feedId = (await store.getState()).feeds[0].id;
  await store.markAllRead(feedId, ['b']);
  let { items } = await store.getState();
  assert.equal(store.countUnread(items).total, 1);
  await store.markAllRead();
  ({ items } = await store.getState());
  assert.equal(store.countUnread(items).total, 0, '全既読');
});

await checkAsync('prune: 保持件数を超えたら古い記事を落とす', async () => {
  const feedId = (await store.getState()).feeds[0].id;
  await store.mergeItems(
    feedId,
    Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`, title: `P${i}`, link: '', author: '', published: Date.now() + (i + 1) * 1000, summary: '', content: '',
    })),
    { itemsPerFeed: 5, retentionDays: 30 }
  );
  const { items } = await store.getState();
  assert.equal(items[feedId].length, 5);
  assert.deepEqual(items[feedId].map((i) => i.id), ['p9', 'p8', 'p7', 'p6', 'p5']);
});

await checkAsync('prune: 保持期間を過ぎた既読は消え、未読は残る', async () => {
  const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const { feed } = await store.addFeed('https://retention.example/feed');
  await store.mergeItems(
    feed.id,
    [
      { id: 'old-read', title: 'old', link: '', author: '', published: old, summary: '', content: '' },
      { id: 'old-unread', title: 'old2', link: '', author: '', published: old, summary: '', content: '' },
    ],
    { itemsPerFeed: 200, retentionDays: 30 }
  );
  await store.setRead(feed.id, 'old-read', true);
  // 再マージで prune が走る
  await store.mergeItems(feed.id, [], { itemsPerFeed: 200, retentionDays: 30 });
  const { items } = await store.getState();
  assert.deepEqual(items[feed.id].map((i) => i.id), ['old-unread']);
});

await checkAsync('filters CRUD と重複拒否', async () => {
  await store.addFilter('広告', 'exclude');
  await assert.rejects(() => store.addFilter(' 広告 ', 'exclude'), /既に登録/);
  await store.addFilter('広告', 'include'); // mode が違えば登録できる
  let filters = await store.getState().then((s) => s.filters);
  assert.equal(filters.length, 2);
  await store.updateFilter(filters[0].id, { enabled: false });
  filters = await store.getState().then((s) => s.filters);
  assert.equal(filters[0].enabled, false);
  await store.removeFilter(filters[0].id);
  assert.equal((await store.getState()).filters.length, 1);
  await assert.rejects(() => store.addFilter('   '), /キーワードを入力/);
});

await checkAsync('renameFeed は titleEdited を立てる', async () => {
  const feedId = (await store.getState()).feeds[0].id;
  const feed = await store.renameFeed(feedId, '  手動タイトル  ');
  assert.equal(feed.title, '手動タイトル');
  assert.equal(feed.titleEdited, true);
  await assert.rejects(() => store.renameFeed(feedId, '  '), /タイトルを入力/);
});

await checkAsync('removeFeed はフィードと記事を消す', async () => {
  const before = await store.getState();
  const target = before.feeds[0];
  await store.removeFeed(target.id);
  const after = await store.getState();
  assert.ok(!after.feeds.some((f) => f.id === target.id));
  assert.ok(!(target.id in after.items));
});

await checkAsync('settings は既定値とマージされる', async () => {
  const settings = await store.updateSettings({ unreadOnly: true });
  assert.equal(settings.unreadOnly, true);
  assert.equal(settings.refreshMinutes, 30, '既定値が残る');
  assert.equal((await store.getSettings()).unreadOnly, true);
});


// ---- refresh ----------------------------------------------------------------
console.log('\nrefresh.js');

const { parseWithDom, refreshFeed, refreshAll } = await import(`${SRC}/refresh.js`);

/** fetch をスタブする。url -> レスポンス定義 */
function stubFetch(routes) {
  globalThis.fetch = async (url) => {
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    if (route.abort) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return {
      ok: route.status === undefined || route.status < 400,
      status: route.status ?? 200,
      statusText: route.statusText ?? 'OK',
      async text() {
        return route.body ?? '';
      },
    };
  };
}

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>取得テスト</title><link>https://fetch.example/</link>
  <item><title>記事 1</title><link>https://fetch.example/1</link><guid>g1</guid></item>
  <item><title>記事 2</title><link>https://fetch.example/2</link><guid>g2</guid></item>
</channel></rss>`;

await checkAsync('refreshFeed: 取得成功でタイトル・記事・lastError を更新', async () => {
  const { feed } = await store.addFeed('https://fetch.example/feed.xml');
  stubFetch({ 'https://fetch.example/feed.xml': { body: FEED_XML } });
  const result = await refreshFeed(feed, parseWithDom);
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  const state = await store.getState();
  const saved = state.feeds.find((f) => f.id === feed.id);
  assert.equal(saved.title, '取得テスト', 'フィード名を自動取得する');
  assert.equal(saved.siteUrl, 'https://fetch.example/');
  assert.equal(saved.lastError, '');
  assert.ok(saved.lastFetched > 0);
  assert.equal(state.items[feed.id].length, 2);
  assert.equal(state.items[feed.id].every((i) => i.read === false), true, '新着は未読');
});

await checkAsync('refreshFeed: 再取得しても重複せず既読が残る', async () => {
  const state0 = await store.getState();
  const feed = state0.feeds.find((f) => f.url === 'https://fetch.example/feed.xml');
  await store.setRead(feed.id, 'g1', true);
  const result = await refreshFeed(feed, parseWithDom);
  assert.equal(result.added, 0, '新規なし');
  const state = await store.getState();
  assert.equal(state.items[feed.id].length, 2);
  assert.equal(state.items[feed.id].find((i) => i.id === 'g1').read, true);
});

await checkAsync('refreshFeed: 手動リネーム後は自動取得でタイトルを上書きしない', async () => {
  let feed = (await store.getState()).feeds.find((f) => f.url === 'https://fetch.example/feed.xml');
  await store.renameFeed(feed.id, 'わたしの名前');
  feed = (await store.getState()).feeds.find((f) => f.id === feed.id);
  await refreshFeed(feed, parseWithDom);
  const saved = (await store.getState()).feeds.find((f) => f.id === feed.id);
  assert.equal(saved.title, 'わたしの名前');
});

await checkAsync('refreshFeed: HTTP エラーを lastError に記録して例外は投げない', async () => {
  const { feed } = await store.addFeed('https://fetch.example/404.xml');
  stubFetch({ 'https://fetch.example/404.xml': { status: 404, statusText: 'Not Found' } });
  const result = await refreshFeed(feed, parseWithDom);
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404/);
  const saved = (await store.getState()).feeds.find((f) => f.id === feed.id);
  assert.match(saved.lastError, /HTTP 404/);
});

await checkAsync('refreshFeed: タイムアウトと解析エラーもメッセージ化される', async () => {
  const { feed: slow } = await store.addFeed('https://fetch.example/slow.xml');
  stubFetch({ 'https://fetch.example/slow.xml': { abort: true } });
  assert.match((await refreshFeed(slow, parseWithDom)).error, /タイムアウト/);

  const { feed: notFeed } = await store.addFeed('https://fetch.example/page.html');
  stubFetch({ 'https://fetch.example/page.html': { body: '<html><body>hi</body></html>' } });
  assert.match((await refreshFeed(notFeed, parseWithDom)).error, /対応していないフィード形式/);
});

await checkAsync('refreshAll: 1 件失敗しても残りを続行する', async () => {
  const before = await store.getState();
  for (const feed of before.feeds) await store.removeFeed(feed.id);
  const a = (await store.addFeed('https://multi.example/a.xml')).feed;
  const b = (await store.addFeed('https://multi.example/b.xml')).feed;
  stubFetch({
    'https://multi.example/a.xml': { status: 500, statusText: 'Server Error' },
    'https://multi.example/b.xml': { body: FEED_XML },
  });
  const result = await refreshAll(parseWithDom);
  assert.equal(result.total, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.added, 2, '成功した b の記事は取り込まれる');
  const state = await store.getState();
  assert.match(state.feeds.find((f) => f.id === a.id).lastError, /HTTP 500/);
  assert.equal(state.feeds.find((f) => f.id === b.id).lastError, '');
});

// ---- translate --------------------------------------------------------------
console.log('\ntranslate.js');

/**
 * Translator API の偽実装。
 * translateFn(text) を差し替えることで、訳し方 (プレースホルダを壊すかどうか) を変えられる。
 */
function stubTranslator({ translateFn, detected = 'en', available = 'available' } = {}) {
  const created = [];
  const destroyed = [];
  globalThis.Translator = {
    async availability() {
      return available;
    },
    async create({ sourceLanguage, targetLanguage }) {
      const pair = `${sourceLanguage}>${targetLanguage}`;
      created.push(pair);
      return {
        async translate(text) {
          return translateFn ? translateFn(text) : `[${sourceLanguage}->${targetLanguage}] ${text}`;
        },
        destroy() {
          destroyed.push(pair);
        },
      };
    },
  };
  globalThis.LanguageDetector = {
    async create() {
      return {
        async detect(text) {
          const language = typeof detected === 'function' ? detected(text) : detected;
          return [{ detectedLanguage: language, confidence: 0.9 }];
        },
      };
    },
  };
  return { created, destroyed };
}

const GLOSSARY = [
  { id: 'g1', source: 'pull request', target: 'プルリクエスト', enabled: true },
  { id: 'g2', source: 'request', target: 'リクエスト', enabled: true },
  { id: 'g3', source: 'Go', target: 'Go 言語', enabled: true },
  { id: 'g4', source: 'stale', target: '無効', enabled: false },
];

check('用語集: 長い語を先に当て、大文字小文字は無視する', () => {
  const { text, map } = translate.protectTerms('Open a Pull Request for the request', GLOSSARY);
  assert.match(text, /TTZ0ZTT/, 'pull request がプレースホルダになる');
  assert.equal(map[0].target, 'プルリクエスト');
  assert.equal(translate.restoreTerms(text, map).includes('プルリクエスト'), true);
  assert.equal(translate.restoreTerms(text, map).includes('リクエスト'), true);
  assert.equal(translate.restoreTerms(text, map).includes('プルリクエストクエスト'), false);
});

check('用語集: ASCII 語は語境界を見るので部分一致しない', () => {
  const { map } = translate.protectTerms('Google is not Go', GLOSSARY);
  const restored = translate.restoreTerms(
    translate.protectTerms('Google is not Go', GLOSSARY).text,
    map
  );
  assert.equal(restored, 'Google is not Go 言語');
});

check('用語集: enabled=false の語は使わない', () => {
  const { map } = translate.protectTerms('a stale entry', GLOSSARY);
  assert.deepEqual(map.map((m) => m.source), []);
});

check('用語集: プレースホルダが壊れたら訳文への直接置換で救う', () => {
  const { text, map } = translate.protectTerms('Open a pull request', GLOSSARY);
  assert.match(text, /TTZ0ZTT/);
  // 翻訳エンジンがトークンを落として原語を訳し戻した想定
  const mangled = 'pull request を開く';
  assert.equal(translate.restoreTerms(mangled, map), 'プルリクエスト を開く');
});

await checkAsync('translateItems: 訳文を返し、言語ペアごとに translator を使い回す', async () => {
  const stub = stubTranslator();
  const items = [
    { id: 'i1', feedId: 'f1', title: 'Hello', summary: '<p>World</p>' },
    { id: 'i2', feedId: 'f1', title: 'Second', summary: '<p>Body</p>' },
  ];
  const { results, failed, error } = await translate.translateItems(items, { glossary: [] });
  assert.equal(error, '');
  assert.equal(failed, 0);
  assert.equal(results.length, 2);
  assert.equal(results[0].titleJa, '[en->ja] Hello');
  assert.equal(results[0].summaryJa, '[en->ja] World');
  assert.equal(results[0].sourceLang, 'en');
  assert.deepEqual(stub.created, ['en>ja'], '同じ言語ペアは 1 度だけ生成する');
  assert.deepEqual(stub.destroyed, ['en>ja'], '使い終わったら解放する');
});

await checkAsync('translateItems: 用語集の訳語が訳文に反映される', async () => {
  // 原文をそのまま返す = プレースホルダは保たれる
  stubTranslator({ translateFn: (text) => text });
  const items = [{ id: 'i1', feedId: 'f1', title: 'Reviewing a pull request', summary: '' }];
  const { results } = await translate.translateItems(items, { glossary: GLOSSARY });
  assert.equal(results[0].titleJa, 'Reviewing a プルリクエスト');
});

await checkAsync('translateItems: 日本語の記事は訳さず記録だけ残す', async () => {
  stubTranslator({ detected: 'ja' });
  // linkedom はタグを含まない文字列の解析で body を作らないため、既存テストと同じくタグ付きで渡す
  const items = [{ id: 'i1', feedId: 'f1', title: '日本語の記事', summary: '<p>要約</p>' }];
  const { results } = await translate.translateItems(items, { glossary: [] });
  assert.equal(results.length, 1);
  assert.equal(results[0].titleJa, '');
  assert.equal(results[0].sourceLang, 'ja');
  // 記録が保存されれば以降は対象外になる
  assert.equal(translate.needsTranslation({ title: 'x', translatedAt: Date.now() }), false);
});

await checkAsync('translateItems: 1 件失敗しても残りを続行する', async () => {
  stubTranslator({
    translateFn: (text) => {
      if (text.includes('boom')) throw new Error('translate failed');
      return `ja:${text}`;
    },
  });
  const items = [
    { id: 'i1', feedId: 'f1', title: 'boom', summary: '' },
    { id: 'i2', feedId: 'f1', title: 'fine', summary: '' },
  ];
  const { results, failed } = await translate.translateItems(items, { glossary: [] });
  assert.equal(failed, 1);
  assert.deepEqual(results.map((r) => r.itemId), ['i2']);
});

check('needsTranslation と hasTranslatableSource の使い分け', () => {
  const untranslated = { title: 'Hello', summary: '' };
  const translated = { title: 'Hello', summary: '', titleJa: 'こんにちは', translatedAt: Date.now() };
  const empty = { title: '  ', summary: '', content: '' };

  // 一括翻訳は未翻訳のものだけを拾う
  assert.equal(translate.needsTranslation(untranslated), true);
  assert.equal(translate.needsTranslation(translated), false);
  assert.equal(translate.needsTranslation(empty), false);

  // 訳し直し (force) は翻訳済みでも対象にする。原文が空のものだけ除く
  assert.equal(translate.hasTranslatableSource(untranslated), true);
  assert.equal(translate.hasTranslatableSource(translated), true);
  assert.equal(translate.hasTranslatableSource(empty), false);
});

await checkAsync('translateItems: 翻訳済みの記事も渡せば訳し直せる', async () => {
  // 用語集を足したあとに訳し直すと、新しい訳語が反映される
  stubTranslator({ translateFn: (text) => text });
  const item = {
    id: 'i1',
    feedId: 'f1',
    title: 'Reviewing a pull request',
    summary: '',
    titleJa: '古い訳',
    translatedAt: Date.now(),
  };
  const { results } = await translate.translateItems([item], { glossary: GLOSSARY });
  assert.equal(results[0].titleJa, 'Reviewing a プルリクエスト');
});

await checkAsync('Translator API が無い環境では理由を返して落ちない', async () => {
  delete globalThis.Translator;
  delete globalThis.LanguageDetector;
  assert.equal(translate.isTranslatorSupported(), false);
  assert.equal(await translate.checkAvailability('en'), 'unavailable');
  const { results, error } = await translate.translateItems([{ id: 'i1', title: 'x' }], {});
  assert.deepEqual(results, []);
  assert.match(error, /Chrome 138/);
});

// ---- store (翻訳) -----------------------------------------------------------
console.log('\nstore.js (翻訳)');

await checkAsync('translation 設定は入れ子でも既定値が埋まる', async () => {
  await store.updateTranslationSettings({ enabled: true });
  const settings = await store.getSettings();
  assert.equal(settings.translation.enabled, true);
  assert.equal(settings.translation.showOriginal, true, '触っていない項目は既定値のまま');
  assert.equal(settings.autoMarkRead, true, '他の設定を壊さない');
});

await checkAsync('用語集の追加・重複拒否・削除', async () => {
  await store.addGlossaryEntry('pull request', 'プルリクエスト');
  await assert.rejects(() => store.addGlossaryEntry('Pull Request', 'x'), /既に登録/);
  await assert.rejects(() => store.addGlossaryEntry('only source', ''), /両方を入力/);
  const { glossary } = await store.getState();
  assert.equal(glossary.length, 1);
  assert.equal(glossary[0].enabled, true);
  await store.removeGlossaryEntry(glossary[0].id);
  assert.equal((await store.getState()).glossary.length, 0);
});

await checkAsync('saveTranslations: 訳文を保存し、原文が変わると破棄される', async () => {
  const feedId = (await store.addFeed('https://translate.example/feed.xml')).feed.id;
  const settings = { itemsPerFeed: 200, retentionDays: 30 };
  const base = { id: 'x1', link: 'https://e/x1', author: '', published: Date.now(), content: '' };
  await store.mergeItems(feedId, [{ ...base, title: 'Original', summary: 'Summary' }], settings);

  const saved = await store.saveTranslations([
    { feedId, itemId: 'x1', titleJa: '原文', summaryJa: '要約', sourceLang: 'en' },
  ]);
  assert.equal(saved, 1);
  const translated = (await store.getState()).items[feedId][0];
  assert.equal(translated.titleJa, '原文');
  assert.ok(translated.translatedAt);

  // 原文が変わらない再取得では訳文を保持する
  await store.mergeItems(feedId, [{ ...base, title: 'Original', summary: 'Summary' }], settings);
  assert.equal((await store.getState()).items[feedId][0].titleJa, '原文');

  // タイトルが書き換わったら訳文を捨てて訳し直させる
  await store.mergeItems(feedId, [{ ...base, title: 'Updated', summary: 'Summary' }], settings);
  const stale = (await store.getState()).items[feedId][0];
  assert.equal(stale.titleJa, '');
  assert.equal(stale.translatedAt, null);
  assert.equal(translate.needsTranslation(stale), true);
});

await checkAsync('clearTranslations: すべての訳文を破棄する', async () => {
  const { items } = await store.getState();
  const feedId = Object.keys(items).find((id) => items[id].some((item) => item.id === 'x1'));
  await store.saveTranslations([
    { feedId, itemId: 'x1', titleJa: '訳', summaryJa: '訳', sourceLang: 'en' },
  ]);
  await store.clearTranslations();
  for (const list of Object.values((await store.getState()).items)) {
    for (const item of list) assert.equal(item.titleJa, '');
  }
});

console.log(`\n${passed} 件のチェックが成功${process.exitCode ? '（失敗あり）' : ''}`);
