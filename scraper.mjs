import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE  = 'https://starto.jp';
const DELAY = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 名前から日本語（漢字・かな）部分のみ抽出
// 例: "青木滉平 Kohei Aoki" → "青木滉平"
const toJaOnly = raw => {
  const m = raw.match(/^([^\x00-\x7F]+)/);
  return m ? m[1].trim() : raw.trim();
};

// ページをスクロールして遅延読み込みをすべて発火させる
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

// ── 1. STARTO アーティスト一覧を取得（ID付き） ───────────────
async function getArtistList(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=0737&lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });
  await scrollToBottom(page);

  return page.evaluate(() => {
    const artists = [];
    const seen    = new Set();
    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const a    = li.querySelector('a[href*="/s/p/artist/"]');
      const href = a ? a.getAttribute('href') : '';
      const m    = href && href.match(/\/s\/p\/artist\/(\d+)/);
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

// ── 2. アーティストページからメンバーを取得 ──────────────────
let debugSaved = false;

async function getMembers(page, artistId) {
  await page.goto(`${BASE}/s/p/artist/${artistId}?lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(800);

  // 最初の1件だけ cast 構造をデバッグ保存
  if (!debugSaved) {
    debugSaved = true;
    const debugInfo = await page.evaluate(() => {
      const bodyArtist = document.body.dataset.artist || '(none)';
      const allCast = Array.from(document.querySelectorAll('.c-cast__item'));
      const castInfo = allCast.slice(0, 10).map(el =>
        `data-cate="${el.dataset.cate}" text="${el.textContent.trim().slice(0,40)}"`
      ).join('\n');
      return `body[data-artist]=${bodyArtist}\ncast items(${allCast.length}):\n${castInfo || '(none)'}`;
    });
    await fs.writeFile('debug_cast.txt', debugInfo, 'utf-8');
    console.log('  DEBUG: debug_cast.txt を保存');
  }

  return page.evaluate(id => {
    const members = [];
    const seen    = new Set();

    // body の data-artist でページ上の実際のIDを確認
    const pageId = document.body.dataset.artist || id;

    // data-cate がグループID の cast アイテム = メンバー
    const items = document.querySelectorAll(`.c-cast__item[data-cate="${pageId}"]`);

    // フォールバック: data-cate="group" 以外の全 cast アイテム
    const targets = items.length > 0
      ? items
      : document.querySelectorAll('.c-cast__item:not([data-cate="group"])');

    targets.forEach(item => {
      const nameEl = item.querySelector('.c-ttl-2')
                  || item.querySelector('.c-blog__name')
                  || item.querySelector('a')
                  || item.querySelector('[class*="name"]');
      const name = (nameEl ? nameEl.textContent : item.textContent).trim().replace(/\s+/g, ' ');
      if (!name || name.length > 15 || seen.has(name)) return;
      seen.add(name);
      members.push(name);
    });
    return members;
  }, artistId);
}

// ── 2. ジュニア個人一覧を取得（漢字のみ） ────────────────────
const JR_BASE = 'https://jr-official.starto.jp';

async function getJrPersons(page) {
  await page.goto(`${JR_BASE}/s/jr/page/persons?ima=0755`, { waitUntil: 'networkidle', timeout: 30000 });
  await scrollToBottom(page);

  return page.evaluate(() => {
    const toJaOnly = raw => {
      const m = raw.match(/^([^\x00-\x7F]+)/);
      return m ? m[1].trim() : raw.trim();
    };
    const names = [];
    const seen  = new Set();
    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const nameEl = li.querySelector('.c-ttl-2') || li.querySelector('.c-ttl-1');
      if (!nameEl) return;
      const name = toJaOnly(nameEl.textContent.trim().replace(/\s+/g, ' '));
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    return names;
  });
}

// ── 5. 公演一覧を取得 ────────────────────────────────────────
async function getList(page) {
  await page.goto(`${BASE}/s/p/live`, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate(() => {
    const items = [];
    const seen  = new Set();

    document.querySelectorAll('a[href]').forEach(a => {
      const href  = a.getAttribute('href') || '';
      const match = href.match(/\/s\/p\/live\/(\d+)/);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);

      let container = a;
      for (let i = 0; i < 6; i++) {
        if (container.parentElement) container = container.parentElement;
      }
      const text = container.textContent || '';

      const dateMatch = text.match(
        /(\d{4}\.\d{2}\.\d{2})\s*[-～~]\s*(\d{4}\.\d{2}\.\d{2})|(\d{4}\.\d{2}\.\d{2})/
      );
      const date = dateMatch
        ? dateMatch[1] && dateMatch[2]
          ? `${dateMatch[1]}-${dateMatch[2]}`
          : dateMatch[3] || ''
        : '';

      const catMatch = text.match(/CONCERT|STAGE|EVENT/);

      items.push({
        id:       match[1],
        href:     `/s/p/live/${match[1]}`,
        date,
        category: catMatch ? catMatch[0] : 'CONCERT',
      });
    });

    return items;
  });
}

// ── 4. 公演詳細ページから会場・日程・タイトル・アーティストを取得 ──
async function getDetail(page, item) {
  try {
    await page.goto(`${BASE}${item.href}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1200);

    return page.evaluate(item => {
      const txt = el => el?.textContent?.trim() || '';

      const title =
        txt(document.querySelector('h1')) ||
        txt(document.querySelector('h2')) ||
        '';

      const artistCandidates = [
        document.querySelector('[class*="artist"]'),
        document.querySelector('[class*="name"]'),
        document.querySelector('h3'),
        document.querySelector('h2 + p'),
        document.querySelector('h1 + p'),
      ];
      const artistEl   = artistCandidates.find(el => el && txt(el).length > 0);
      const artistName = txt(artistEl);

      const venues = [];
      const dateRe = /(\d{4}[./]\d{1,2}[./]\d{1,2})/;

      const allEls = Array.from(document.querySelectorAll('*'));
      const scheduleHeader = allEls.find(el =>
        /^schedule$/i.test(txt(el)) && el.tagName.match(/^H[1-6]$/)
      );

      const targets  = scheduleHeader
        ? Array.from(scheduleHeader.parentElement?.children || [])
        : allEls;

      let inSchedule = !scheduleHeader;
      for (const el of targets) {
        if (el === scheduleHeader) { inSchedule = true; continue; }
        if (!inSchedule) continue;
        if (scheduleHeader && el !== scheduleHeader && el.tagName?.match(/^H[1-6]$/)) break;

        const rows    = el.querySelectorAll('tr, li, [class*="item"], [class*="row"], [class*="schedule-"]');
        const targets2 = rows.length > 0 ? Array.from(rows) : [el];

        for (const row of targets2) {
          const rowText  = txt(row);
          const dateMatch = rowText.match(dateRe);
          if (!dateMatch) continue;

          const dateStr = dateMatch[1]
            .replace(/\//g, '.')
            .replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/, (_, y, m, d) =>
              `${y}.${m.padStart(2, '0')}.${d.padStart(2, '0')}`
            );

          const venue = rowText.replace(dateMatch[1], '').replace(/\s+/g, ' ').trim();
          if (venue) venues.push({ date: dateStr, venue });
        }
      }

      return {
        title:   title || '',
        date:    item.date,
        category: item.category,
        venues,
        artists: artistName ? [artistName] : [],
      };
    }, item);

  } catch (e) {
    console.error(`  ✗ ${item.href} 取得失敗: ${e.message}`);
    return {
      title:    '',
      date:     item.date,
      category: item.category,
      venues:   [],
      artists:  [],
    };
  }
}

// ── メイン ────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

  // WOVN を日本語に固定（&lang=ja が効かないURLでも日本語にする）
  await context.addCookies([
    { name: 'wovn_selected_lang', value: 'ja', domain: 'starto.jp',             path: '/' },
    { name: 'wovn_selected_lang', value: 'ja', domain: 'jr-official.starto.jp', path: '/' },
  ]);

  // ── STARTO アーティスト ───────────────────────────────────
  console.log('👥 STARTOアーティスト一覧を取得中...');
  const artistList = await getArtistList(page);
  console.log(`✅ ${artistList.length} 件`);

  console.log('👤 各アーティストページからメンバーを取得中...');
  const artists = [];
  for (const { id, name } of artistList) {
    const members = await getMembers(page, id);
    console.log(`  ${name}（${id}）: ${members.length > 0 ? members.join(', ') : 'ソロ'}`);
    artists.push({ group: name, members });
    await sleep(DELAY);
  }

  // ── ジュニア個人 ──────────────────────────────────────────
  console.log('\n👤 ジュニア個人一覧を取得中...');
  const jrPersons = await getJrPersons(page);
  console.log(`✅ ${jrPersons.length} 名`);
  jrPersons.forEach(n => console.log(`  ${n}`));

  const allArtists = [
    ...artists,
    ...jrPersons.map(name => ({ group: name, members: [] })),
  ];
  await fs.writeFile('artists.json', JSON.stringify(allArtists, null, 2), 'utf-8');
  console.log(`\n✅ 合計 ${allArtists.length} 件（STARTO ${artists.length} + ジュニア ${jrPersons.length}）を artists.json に保存`);

  // ── 公演情報 ──────────────────────────────────────────────
  console.log('\n📋 公演一覧を取得中...');
  const list = await getList(page);
  console.log(`✅ ${list.length} 件の公演を発見`);

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
