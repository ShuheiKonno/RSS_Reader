// 実際の Chromium に拡張機能を読み込み、リーダー UI を操作して検証する E2E テスト。
//
//   npm run test:e2e
//
// ローカルのフィードサーバーを立て、拡張機能を --load-extension で読み込んで
// フィード追加 / 検索 / キーワードフィルタ / 未読既読 / サニタイズを一通り操作する。
// Chromium のパスを指定したい場合は CHROMIUM_PATH を設定する。
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// リポジトリのルート (manifest.json のある場所) を拡張機能として読み込む
const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOT = process.env.SCREENSHOT_DIR || os.tmpdir();
// Chromium のパスは環境変数で上書きできる。未指定なら Playwright 同梱のものを使う
const executablePath = process.env.CHROMIUM_PATH || undefined;

const FEED_A = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>技術ブログ</title>
    <link>https://tech.example/</link>
    <item>
      <title>Chrome 拡張の Manifest V3 入門</title>
      <link>/posts/mv3</link>
      <guid>a1</guid>
      <pubDate>Mon, 18 Aug 2026 10:00:00 GMT</pubDate>
      <dc:creator>山田太郎</dc:creator>
      <description>Service Worker と offscreen document の基本を解説します。</description>
      <content:encoded><![CDATA[<p>MV3 では background page が <strong>Service Worker</strong> になりました。</p>
        <script>alert('xss')</script>
        <ul><li>DOMParser は使えない</li><li>offscreen で代替する</li></ul>
        <a href="javascript:alert(1)">危険なリンク</a>
        <a href="https://developer.chrome.com/">公式ドキュメント</a>]]></content:encoded>
    </item>
    <item>
      <title>【広告】新サービスのお知らせ</title>
      <link>https://tech.example/ad</link>
      <guid>a2</guid>
      <pubDate>Sun, 17 Aug 2026 10:00:00 GMT</pubDate>
      <description>PR 記事です。</description>
    </item>
    <item>
      <title>Rust で書く CLI ツール</title>
      <link>https://tech.example/rust</link>
      <guid>a3</guid>
      <pubDate>Sat, 16 Aug 2026 10:00:00 GMT</pubDate>
      <description>所有権とライフタイムの実践。</description>
    </item>
  </channel>
</rss>`;

const FEED_B = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom ニュース</title>
  <link rel="alternate" href="https://atom.example/"/>
  <entry>
    <title>Atom 形式のフィードも読める</title>
    <id>b1</id>
    <link rel="alternate" href="/news/1"/>
    <updated>2026-08-19T01:00:00Z</updated>
    <author><name>Hanako</name></author>
    <summary>Atom 1.0 の entry を解析します。</summary>
  </entry>
</feed>`;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
    failures += 1;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/a.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(FEED_A);
  } else if (req.url === '/b.xml') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(FEED_B);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`feed server: ${base}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-ext-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});

const pageErrors = [];
const consoleErrors = [];

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  check('Service Worker が起動する', Boolean(extensionId), worker.url());

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(`chrome-extension://${extensionId}/src/reader.html`);
  await page.waitForSelector('#feed-list');
  check(
    '初期状態のガイダンスが出る',
    (await page.textContent('#list-status')).includes('URL を登録'),
    await page.textContent('#list-status')
  );

  // --- フィード追加 (RSS 2.0) ---
  await page.fill('#feed-url', `${base}/a.xml`);
  await page.click('#add-feed-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3, null, {
    timeout: 15000,
  });
  await page.waitForFunction(
    () => document.querySelector('#feed-list').textContent.includes('技術ブログ'),
    null,
    { timeout: 15000 }
  );
  check('RSS フィードのタイトルを自動取得', true);
  check(
    '追加完了メッセージ',
    (await page.textContent('#add-feed-message')).includes('3 件'),
    await page.textContent('#add-feed-message')
  );

  // --- フィード追加 (Atom) ---
  await page.fill('#feed-url', `${base}/b.xml`);
  await page.click('#add-feed-form button[type=submit]');
  await page.waitForFunction(
    () => document.querySelector('#feed-list').textContent.includes('Atom ニュース'),
    null,
    { timeout: 15000 }
  );
  check('Atom フィードも追加できる', (await page.$$('.feed-row')).length === 2);

  // --- 取得エラー ---
  await page.fill('#feed-url', `${base}/missing.xml`);
  await page.click('#add-feed-form button[type=submit]');
  await page.waitForFunction(
    () => (document.querySelector('#add-feed-message').textContent || '').includes('失敗'),
    null,
    { timeout: 15000 }
  );
  check('404 のフィードはエラー表示', (await page.textContent('#add-feed-message')).includes('404'));
  check(
    'エラーでも他のフィードは残る',
    (await page.$$('.feed-row')).length === 3 &&
      (await page.textContent('#feed-list')).includes('技術ブログ')
  );

  // --- 重複登録の拒否 ---
  await page.fill('#feed-url', `${base}/a.xml`);
  await page.click('#add-feed-form button[type=submit]');
  await page.waitForFunction(
    () => (document.querySelector('#add-feed-message').textContent || '').includes('既に登録'),
    null,
    { timeout: 5000 }
  );
  check('重複登録を拒否する', true);

  // --- すべてのフィード ---
  await page.click('.feed-item >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 4);
  check('「すべてのフィード」で全 4 件', (await page.$$('.item-row')).length === 4);
  check(
    '未読バッジに合計 4 件',
    (await page.textContent('.feed-item >> nth=0')).includes('4'),
    await page.textContent('.feed-item >> nth=0')
  );

  // --- 検索 ---
  await page.fill('#search', 'chrome');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 1);
  check('検索で 1 件に絞られる', (await page.$$('.item-row')).length === 1);
  check('検索語がハイライトされる', (await page.$$('.item-row mark')).length > 0);

  await page.fill('#search', 'chrome 存在しない語');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 0);
  check('AND 検索で 0 件', (await page.textContent('#list-status')).includes('一致する記事はありません'));

  await page.fill('#search', 'atom');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 1);
  check('フィード名でも検索できる', (await page.textContent('.item-row')).includes('Atom 形式'));

  await page.fill('#search', '');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 4);
  check('検索クリアで全件に戻る', true);

  // --- キーワードフィルタ (除外) ---
  await page.fill('#filter-keyword', '広告');
  await page.selectOption('#filter-mode', 'exclude');
  await page.click('#add-filter-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);
  check('除外キーワードで広告記事が消える', !(await page.textContent('#item-list')).includes('広告'));

  await page.uncheck('.filter-row input[type=checkbox]');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 4);
  check('フィルタを無効化すると元に戻る', true);
  await page.check('.filter-row input[type=checkbox]');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);

  // --- キーワードフィルタ (含める) ---
  await page.fill('#filter-keyword', 'Rust');
  await page.selectOption('#filter-mode', 'include');
  await page.click('#add-filter-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 1);
  check(
    '含めるキーワードで Rust 記事のみ',
    (await page.textContent('#item-list')).includes('Rust'),
    await page.textContent('#item-list')
  );
  check('include キーワードもハイライトされる', (await page.$$('.item-row mark')).length > 0);

  await page.click('.filter-row:nth-child(2) .icon-btn');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);

  // --- 永続化 ---
  await page.reload();
  await page.waitForSelector('.item-row');
  check(
    'リロード後もフィルタが残る',
    (await page.textContent('#filter-list')).includes('広告') &&
      (await page.$$('.item-row')).length === 3
  );

  // --- 未読既読 ---
  await page.click('#unread-only');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);
  const mv3Row = page.locator('.item-row', { hasText: 'Manifest V3' });
  const firstTitle = await mv3Row.locator('.item-title').textContent();

  await mv3Row.click();
  await page.waitForSelector('#preview-article:not([hidden])');
  await page.waitForFunction(
    () => document.querySelector('#preview-title').textContent.includes('Manifest V3'),
    null,
    { timeout: 5000 }
  );
  check('プレビューにタイトルが出る', (await page.textContent('#preview-title')).length > 0);
  check(
    '情報元へのリンクが絶対 URL になる',
    (await page.getAttribute('#preview-link', 'href')) === `${base}/posts/mv3`,
    await page.getAttribute('#preview-link', 'href')
  );
  check(
    'プレビューに著者とフィード名が出る',
    (await page.textContent('#preview-meta')).includes('山田太郎') &&
      (await page.textContent('#preview-meta')).includes('技術ブログ')
  );

  await page.waitForFunction(
    (t) =>
      ![...document.querySelectorAll('.item-row .item-title')]
        .map((n) => n.textContent)
        .includes(t),
    firstTitle,
    { timeout: 5000 }
  );
  check('開いた記事が自動既読になり未読一覧から外れる', true);

  // --- サニタイズ ---
  const bodyHtml = await page.innerHTML('#preview-body');
  check('script タグが除去される', !/script/i.test(bodyHtml), bodyHtml.slice(0, 200));
  check('javascript: リンクが無効化される', !/javascript:/i.test(bodyHtml));
  check('許可タグ (strong / ul) は残る', /<strong>/i.test(bodyHtml) && /<li>/i.test(bodyHtml));
  check(
    '外部リンクに rel=noopener が付く',
    (await page.getAttribute('#preview-body a[href="https://developer.chrome.com/"]', 'rel')) ===
      'noopener noreferrer'
  );

  // --- 未読に戻す ---
  await page.click('#toggle-read');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);
  check('「未読にする」で一覧に戻る', (await page.$$('.item-row')).length === 3);

  // --- すべて既読 ---
  await page.click('#mark-all-read');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 0);
  check('すべて既読で未読一覧が空になる', true);
  await page.click('#unread-only');
  await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 3);
  check('未読のみを外すと既読記事が再表示される', true);

  // --- 並び順 ---
  const newestFirst = await page.textContent('.item-row >> nth=0');
  await page.selectOption('#sort-order', 'oldest');
  await page.waitForFunction((t) => document.querySelector('.item-row').textContent !== t, newestFirst);
  check('並び順を変更できる', true);
  await page.selectOption('#sort-order', 'newest');

  // --- キーボード操作 ---
  await page.click('.item-row >> nth=0');
  const before = await page.textContent('#preview-title');
  await page.keyboard.press('j');
  await page.waitForFunction((t) => document.querySelector('#preview-title').textContent !== t, before);
  check('j キーで次の記事に移動する', true);
  await page.keyboard.press('k');
  await page.waitForFunction((t) => document.querySelector('#preview-title').textContent === t, before);
  check('k キーで前の記事に戻る', true);
  await page.keyboard.press('/');
  check('/ キーで検索にフォーカスする', await page.evaluate(() => document.activeElement.id === 'search'));

  await page.screenshot({ path: path.join(SHOT, 'reader.png') });

  check('ページ内 JS エラーが無い', pageErrors.length === 0, pageErrors.join('\n'));
  // 意図的に 404 のフィードを登録しているため、その分は除外する
  const unexpected = consoleErrors.filter((text) => !text.includes('404'));
  check('想定外のコンソールエラーが無い', unexpected.length === 0, unexpected.join('\n'));
} catch (error) {
  console.error('EXCEPTION:', error.stack || error.message);
  failures += 1;
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nE2E: すべて成功' : `\nE2E: ${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
