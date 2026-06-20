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

// 「もっと見る」等のボタンを繰り返しクリックして全件展開
async function clickLoadMore(page) {
  let clicked = 0;
  for (let i = 0; i < 20; i++) {
    const btn = page.locator('button, a').filter({ hasText: /もっと見る|さらに見る|load more/i }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;
    await btn.click();
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    clicked++;
  }
  if (clicked > 0) console.log(`  「もっと見る」を ${clicked} 回クリック`);
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

// ── 3. 公演一覧を取得（カードから title/date/artists を直接取得。外部リンクの公演も拾う）
async function getList(page, url, category) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await clickLoadMore(page);
  await scrollToBottom(page);

  return page.evaluate(cat => {
    // 全角・半角の括弧書き（出演日程など）を末尾から除去
    const stripParen = s => s.replace(/\s*[（(][^）)]*[）)]?\s*$/g, '').trim();

    const items = [];
    document.querySelectorAll('li.p-in_cs__list-item').forEach(li => {
      const a = li.querySelector('a.c-cs_card, a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';

      const titleEl = li.querySelector('.c-ttl-2');
      const title   = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return; // テンプレート行などを除外

      // 日付（カードに整形済みで入っている）
      // 例 "2026.08.14 - 2026.08.16" / "2026.11"（年月のみ）/ "2026.10 - 2026.11"
      const dateEl   = li.querySelector('.c-date') || li.querySelector('.c-cs_card__date');
      const dateText = dateEl ? dateEl.textContent : '';
      const dparts   = (dateText.match(/\d{4}\.\d{1,2}(?:\.\d{1,2})?/g) || [])
        .map(d => {
          const p = d.split('.');
          return p.length === 3
            ? `${p[0]}.${p[1].padStart(2, '0')}.${p[2].padStart(2, '0')}` // 年月日
            : `${p[0]}.${p[1].padStart(2, '0')}`;                          // 年月のみ
        });
      const cardDate = dparts.length === 0 ? ''
        : dparts.length === 1 ? dparts[0]
        : `${dparts[0]}-${dparts[dparts.length - 1]}`;

      // アーティスト（.c-text-3。<br>区切り＋全角スペース区切り、演出など制作陣は除外）
      const artistEl  = li.querySelector('.c-text-3');
      const rawArtist = artistEl ? (artistEl.innerText || artistEl.textContent || '') : '';
      const artists = [];
      rawArtist.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        // 制作陣（演出・脚本など）の行は除外
        if (/^(演出|脚本|作・演出|作|振付|音楽|構成|監督|原作|企画)[：:・]/.test(line)) return;
        // 行頭の役割プレフィックス（出演：/主演：など）だけを除去（名前内のコロンは保持）
        const body = line.replace(/^(出演|主演|友情出演|特別出演|ゲスト|声の出演|MC|司会)[：:]\s*/, '');
        // 全角スペースで複数名に分割し、各名から末尾の括弧書きを除去
        body.split(/[　]+/).map(n => stripParen(n.trim())).filter(Boolean)
          .forEach(n => { if (!artists.includes(n)) artists.push(n); });
      });

      // 内部公演（/s/p/live/N）か外部リンクか
      const m = href.match(/\/s\/p\/live\/(\d+)/);
      const id = m ? m[1] : `${href}|${title}`;    // 外部は URL+タイトルをキーに
      const detailHref = m ? `/s/p/live/${m[1]}` : null;

      items.push({ id, href: detailHref, external: !m, category: cat, title, cardDate, artists });
    });

    return items;
  }, category);
}

// ── 4. 詳細ページの埋め込み JS 変数 live_info_item から会場・日程を取得（内部公演のみ）
async function getDetail(page, item) {
  // 外部リンクの公演は詳細ページが無いため、カード情報のみ使用
  if (item.external || !item.href) {
    return finalize(item, item.cardDate, []);
  }

  try {
    await page.goto(`${BASE}${item.href}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(800);

    const raw = await page.evaluate(() => {
      // ページ内 <script> の const live_info_item をそのまま読む
      const data = (typeof live_info_item !== 'undefined') ? live_info_item : null;
      if (!Array.isArray(data)) return { venues: [], min: '', max: '' };

      const venues = [];
      let min = '', max = '';
      data.forEach(o => {
        if (!o || typeof o !== 'object' || !o.str_itemDate) return;
        const date = String(o.str_itemDate).replace(/-/g, '.');
        const place = [o.str_itemPlacePref, o.str_itemPlace].map(s => (s || '').trim()).filter(Boolean).join(' ');
        const time  = (o.str_itemTime || '').trim();
        const venue = [place, time].filter(Boolean).join(' ').trim();
        venues.push({ date, venue });
        if (o.str_itemDateMin) min = String(o.str_itemDateMin).replace(/-/g, '.');
        if (o.str_itemDateMax) max = String(o.str_itemDateMax).replace(/-/g, '.');
      });
      return { venues, min, max };
    });

    // 日付は live_info_item の min/max を優先、なければ venues、最後にカード日付
    let date = '';
    if (raw.min && raw.max) {
      date = raw.min === raw.max ? raw.min : `${raw.min}-${raw.max}`;
    } else if (raw.venues.length > 0) {
      const ds = raw.venues.map(v => v.date).filter(Boolean).sort();
      date = ds.length === 1 ? ds[0] : `${ds[0]}-${ds[ds.length - 1]}`;
    } else {
      date = item.cardDate;
    }

    return finalize(item, date, raw.venues);

  } catch (e) {
    console.error(`  ✗ ${item.href} 取得失敗: ${e.message}`);
    return finalize(item, item.cardDate, []);
  }
}

// 公演オブジェクトを組み立て（アーティストが空ならタイトルから推定）
function finalize(item, date, venues) {
  let artists = (item.artists && item.artists.length > 0) ? item.artists : [];
  if (artists.length === 0) {
    const guessed = guessArtistFromTitle(item.title);
    if (guessed) artists = [guessed];
  }
  return { title: item.title, date, category: item.category, venues, artists };
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
    items.slice(0, 3).forEach(it => console.log(`    例) [${it.id}] ${it.title} / ${(it.artists||[]).join(', ') || '(アーティスト未取得)'}`));
  }
  console.log(`✅ 合計 ${list.length} 件の公演を発見`);

  const lives = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    console.log(`[${i + 1}/${list.length}] ${item.external ? '(外部) ' + item.title : item.href} を取得中...`);
    const detail = await getDetail(page, item);
    lives.push(detail);
    if (!item.external) await sleep(DELAY); // 詳細ページを開いた時だけ待つ
  }

  await browser.close();

  await fs.writeFile('lives.json', JSON.stringify(lives, null, 2), 'utf-8');
  console.log(`\n🎉 完了！公演 ${lives.length} 件を lives.json に保存`);
}

main().catch(e => { console.error(e); process.exit(1); });
