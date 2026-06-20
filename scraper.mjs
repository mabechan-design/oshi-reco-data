import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE  = 'https://starto.jp';
const DELAY = 2000;

// starto.jp に個別ページがなく自動取得できないアーティスト
const MANUAL_ARTISTS = [
  { group: 'DOMOTO', members: ['堂本光一', '堂本剛'] },
];

// タイトル文字列からアーティスト名を判定するマッピング（長い/具体的なものを先に）
const ARTIST_TITLE_MAP = [
  ['MILESixTONES',      'SixTONES'],
  ['SixTONES',          'SixTONES'],
  ['Hey! Say! JUMP',    'Hey! Say! JUMP'],
  ['Kis-My-Ft2',        'Kis-My-Ft2'],
  ['KIS-MY-FT2',        'Kis-My-Ft2'],
  ['A.B.C-Z',           'A.B.C-Z'],
  ['Snow Man',          'Snow Man'],
  ['SNOW MAN',          'Snow Man'],
  ['Travis Japan',      'Travis Japan'],
  ['Aぇ! group',        'Aぇ! group'],
  ['なにわ男子',         'なにわ男子'],
  ['SUPER EIGHT',       'SUPER EIGHT'],
  ['20th Century',      '20th Century'],
  ['WEST.',             'WEST.'],
  ['timelesz',          'timelesz'],
  ['DOMOTO',            'DOMOTO'],
  ['King & Prince',     'King & Prince'],
  ['ふぉ～ゆ～',         'ふぉ～ゆ～'],
  ['ふぉ〜ゆ〜',         'ふぉ～ゆ～'],
  ['TAKUYA KIMURA',     '木村拓哉'],
  ['木村拓哉',           '木村拓哉'],
  ['Ryosuke Yamada',    '山田涼介'],
  ['山田涼介',           '山田涼介'],
  ['KENTY',             '中島健人'],
  ['中島健人',           '中島健人'],
  ['堂本光一',           '堂本光一'],
  ['堂本剛',             '堂本剛'],
  ['相葉雅紀',           '相葉雅紀'],
  ['櫻井翔',             '櫻井翔'],
  ['横山裕',             '横山裕'],
  ['上田竜也',           '上田竜也'],
  ['中丸雄一',           '中丸雄一'],
  ['中島裕翔',           '中島裕翔'],
  ['内博貴',             '内博貴'],
  ['長谷川純',           '長谷川純'],
  ['岡本圭人',           '岡本圭人'],
  ['河合郁人',           '河合郁人'],
  ['草間リチャード敬太',  '草間リチャード敬太'],
  ['林翔太',             '林翔太'],
  ['室龍太',             '室龍太'],
  ['高田翔',             '高田翔'],
  ['今江大地',           '今江大地'],
  ['松本幸大',           '松本幸大'],
  ['冨岡健翔',           '冨岡健翔'],
  ['野澤祐樹',           '野澤祐樹'],
  ['藤井直樹',           '藤井直樹'],
  ['内海光司',           '内海光司'],
  ['佐藤アツヒロ',        '佐藤アツヒロ'],
  ['戸塚祥太',           '戸塚祥太'],
  ['NEWS',              'NEWS'],
];

function guessArtistFromTitle(title) {
  for (const [variant, artistName] of ARTIST_TITLE_MAP) {
    if (title.includes(variant)) return artistName;
  }
  return '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ページ末尾まで繰り返しスクロールして遅延読み込みをすべて発火
async function scrollToBottom(page) {
  let prev = 0;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prev) break;
    prev = h;
  }
}

// ── 1. アーティスト一覧を取得（ID + 名前）
async function getArtistList(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=0737&lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });
  await scrollToBottom(page);

  return page.evaluate(() => {
    const artists = [];
    const seen    = new Set();
    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const a    = li.querySelector('a[href*="/s/p/artist/"]');
      const href = a ? a.getAttribute('href') : '';
      const m    = href && href.match(/\/s\/p\/artist\/([^/?#]+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const nameEl = li.querySelector('.c-ttl-2') || li.querySelector('.c-ttl-1');
      const name   = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;
      artists.push({ id, name });
    });
    return artists;
  });
}

// ── 2. タレント一覧ページからグループ→メンバーのマップを構築
async function buildMemberMap(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=2555&data=talent&lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });
  await scrollToBottom(page);

  // デバッグ: 最初の3件のHTML構造を保存
  const debugHtml = await page.evaluate(() => {
    const items = document.querySelectorAll('.p-in_artist__list-item');
    if (items.length === 0) return `NO .p-in_artist__list-item (total elements: ${document.querySelectorAll('*').length})`;
    return `FOUND: ${items.length} items\n\n` +
      Array.from(items).slice(0, 3).map(el => el.outerHTML).join('\n\n---\n\n');
  });
  await fs.writeFile('debug_talent.html', debugHtml, 'utf-8');
  console.log('  DEBUG: debug_talent.html を保存');

  return page.evaluate(() => {
    const map = {};
    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const nameEl = li.querySelector('.c-ttl-2') || li.querySelector('.c-ttl-1');
      const name   = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      // 戦略1: .c-artist_card__name-hosoku（CSSでカッコが付く可能性があるため中身だけ取る）
      const hosokuEl = li.querySelector('.c-artist_card__name-hosoku');
      let group = hosokuEl ? hosokuEl.textContent.trim().replace(/[()（）]/g, '').trim() : '';

      // 戦略2: li全体テキストのカッコ書き
      if (!group) {
        const rest = li.textContent.replace(name, '');
        const m = rest.match(/[（(]([^）)]+)[）)]/);
        group = m ? m[1].trim() : '';
      }

      // 戦略3: 名前以外のリーフ要素テキスト
      if (!group) {
        Array.from(li.querySelectorAll('*')).forEach(el => {
          if (group || el.children.length > 0) return;
          const t = el.textContent.trim().replace(/[()（）]/g, '').trim();
          if (t && t !== name && t.length > 1 && t.length < 30) group = t;
        });
      }

      if (!group) return;
      if (!map[group]) map[group] = [];
      if (!map[group].includes(name)) map[group].push(name);
    });
    return map;
  });
}

// カテゴリ別の取得URL
const LIVE_TARGETS = [
  { url: `${BASE}/s/p/live?ima=4135&ct=concert`, category: 'CONCERT' },
  { url: `${BASE}/s/p/live?ima=4245&ct=stage`,   category: 'STAGE'   },
  { url: `${BASE}/s/p/live?ima=4135&ct=event`,   category: 'EVENT'   },
];

// ── 3. 公演一覧を取得（カテゴリ別URL・アーティスト名は一覧カードの .c-text-3 から）
async function getList(page, url, category) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await scrollToBottom(page);

  return page.evaluate(cat => {
    const items = [];
    const seen  = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href  = a.getAttribute('href') || '';
      const match = href.match(/\/s\/p\/live\/(\d+)/);
      if (!match || seen.has(match[1])) return;

      // <a> タグ自体がカードをラップしている前提でタイトルと artist を取得
      const titleEl  = a.querySelector('.c-ttl-2');
      const artistEl = a.querySelector('.c-text-3');
      if (!titleEl) return; // タイトルのないナビリンクは除外

      seen.add(match[1]);
      const title  = titleEl.textContent.trim();
      // 「出演：」「主演：」などのプレフィックスを除去
      const artist = (artistEl ? artistEl.textContent.trim() : '').replace(/^[^：:]+[：:]/, '').trim();

      items.push({ id: match[1], href: `/s/p/live/${match[1]}`, category: cat, title, artist });
    });
    return items;
  }, category);
}

// ── 4. 公演詳細ページから会場・日程・タイトル・アーティストを取得
async function getDetail(page, item) {
  try {
    await page.goto(`${BASE}${item.href}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1200);

    const raw = await page.evaluate(() => {
      const txt = el => el?.textContent?.trim() || '';

      const venues = [];
      const dateRe = /(\d{4}[./]\d{1,2}[./]\d{1,2})/;

      const allEls = Array.from(document.querySelectorAll('*'));
      const scheduleHeader = allEls.find(el =>
        /^schedule$/i.test(txt(el)) && el.tagName.match(/^H[1-6]$/)
      );

      const targets = scheduleHeader
        ? Array.from(scheduleHeader.parentElement?.children || [])
        : allEls;

      let inSchedule = !scheduleHeader;
      for (const el of targets) {
        if (el === scheduleHeader) { inSchedule = true; continue; }
        if (!inSchedule) continue;
        if (scheduleHeader && el !== scheduleHeader && el.tagName?.match(/^H[1-6]$/)) break;

        const rows     = el.querySelectorAll('tr, li, [class*="item"], [class*="row"], [class*="schedule-"]');
        const targets2 = rows.length > 0 ? Array.from(rows) : [el];

        for (const row of targets2) {
          const rowText   = txt(row);
          const dateMatch = rowText.match(dateRe);
          if (!dateMatch) continue;

          const dateStr = dateMatch[1]
            .replace(/\//g, '.')
            .replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/, (_, y, mo, d) =>
              `${y}.${mo.padStart(2, '0')}.${d.padStart(2, '0')}`
            );

          const venue = rowText.replace(dateMatch[1], '').replace(/\s+/g, ' ').trim();
          if (venue) venues.push({ date: dateStr, venue });
        }
      }

      return { venues };
    });

    const { venues } = raw;

    // venues の最小・最大日付からツアー期間を計算
    const dates = venues.map(v => v.date).filter(Boolean).sort();
    const date  = dates.length === 0 ? ''
      : dates.length === 1           ? dates[0]
      : `${dates[0]}-${dates[dates.length - 1]}`;

    // 一覧ページから取得済みのタイトル・アーティスト名を使用
    // アーティストが取得できなかった場合のみタイトルマッチングで補完
    const artistName = item.artist || guessArtistFromTitle(item.title);

    return {
      title:    item.title,
      date,
      category: item.category,
      venues,
      artists:  artistName ? [artistName] : [],
    };

  } catch (e) {
    console.error(`  ✗ ${item.href} 取得失敗: ${e.message}`);
    return { title: item.title, date: '', category: item.category, venues: [], artists: item.artist ? [item.artist] : [] };
  }
}

// ── メイン
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

  // WOVN を日本語に固定（URL の &lang=ja が効かない場合の保険）
  await context.addCookies([
    { name: 'wovn_selected_lang', value: 'ja', domain: 'starto.jp', path: '/' },
  ]);

  // ── アーティスト情報
  console.log('👥 アーティスト一覧を取得中...');
  const artistList = await getArtistList(page);
  console.log(`✅ ${artistList.length} 件`);

  console.log('👤 タレントページからメンバーマッピングを構築中...');
  const memberMap = await buildMemberMap(page);
  console.log(`✅ ${Object.keys(memberMap).length} グループのメンバー情報を取得`);

  const artists = artistList.map(({ name }) => {
    const members = memberMap[name] || [];
    console.log(`  ${name}: ${members.length > 0 ? members.join(', ') : 'ソロ'}`);
    return { group: name, members };
  });

  const allArtists = [...artists, ...MANUAL_ARTISTS];
  await fs.writeFile('artists.json', JSON.stringify(allArtists, null, 2), 'utf-8');
  console.log(`\n✅ ${allArtists.length} 件を artists.json に保存（手動追加 ${MANUAL_ARTISTS.length} 件含む）`);

  // ── 公演情報（カテゴリ別URLから重複なしで収集）
  console.log('\n📋 公演一覧を取得中...');
  const seenIds = new Set();
  const list = [];
  for (const { url, category } of LIVE_TARGETS) {
    const items = await getList(page, url, category);
    items.forEach(item => { if (!seenIds.has(item.id)) { seenIds.add(item.id); list.push(item); } });
    console.log(`  ${category}: ${items.length} 件`);
  }
  console.log(`✅ 合計 ${list.length} 件の公演を発見`);

  const lives = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    console.log(`[${i + 1}/${list.length}] ${item.href} を取得中...`);
    const detail = await getDetail(page, item);
    lives.push(detail);
    await sleep(DELAY);
  }

  await browser.close();

  await fs.writeFile('lives.json', JSON.stringify(lives, null, 2), 'utf-8');
  console.log(`\n🎉 完了！公演 ${lives.length} 件を lives.json に保存`);
}

main().catch(e => { console.error(e); process.exit(1); });
