import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE  = 'https://starto.jp';
const DELAY = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. グループ一覧を取得 ─────────────────────────────────────
async function getArtistList(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=3141&lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate(() => {
    const artists = [];
    const seen    = new Set();

    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const a = li.querySelector('a[href*="/s/p/artist/"]');
      if (!a) return;

      const href  = a.getAttribute('href') || '';
      const match = href.match(/\/s\/p\/artist\/(\d+)/);
      if (!match) return;

      const id = match[1];
      if (seen.has(id)) return;
      seen.add(id);

      const nameEl = li.querySelector('.c-ttl-2');
      const name   = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      artists.push({ id, name });
    });

    return artists;
  });
}

// ── 2. タレント一覧からグループ→メンバーマッピングを構築 ────
// ?data=talent ページでは各タレント名の下にグループ名がカッコ書きで表示される
async function getTalentGroupMap(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=2555&data=talent&lang=ja`, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(1200);

  // デバッグ: リストアイテムの構造を保存（最初の3件）
  const debugHtml = await page.evaluate(() => {
    const items = document.querySelectorAll('.p-in_artist__list-item');
    if (items.length === 0) return '<p>NO ITEMS FOUND</p>';
    return Array.from(items).slice(0, 3).map(el => el.outerHTML).join('\n\n---\n\n');
  });
  await fs.writeFile('debug_talent.html', debugHtml, 'utf-8');
  console.log(`  DEBUG: debug_talent.html に保存（リストアイテム数: ${await page.evaluate(() => document.querySelectorAll('.p-in_artist__list-item').length)}）`);

  return page.evaluate(() => {
    const map = {}; // グループ名 → メンバー名[]

    document.querySelectorAll('.p-in_artist__list-item').forEach(li => {
      const nameEl = li.querySelector('.c-ttl-2');
      const name   = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      // グループ名はカッコ書きで名前の下に出る要素（複数セレクタを試す）
      const groupEl  = li.querySelector('.c-artist_card__name-hosoku')
                    || li.querySelector('.c-subhead-2')
                    || li.querySelector('.c-ttl-3');
      const groupRaw = groupEl ? groupEl.textContent.trim() : '';
      const group    = groupRaw.replace(/[()（）]/g, '').trim();

      if (!group) return;
      if (!map[group]) map[group] = [];
      if (!map[group].includes(name)) map[group].push(name);
    });

    return map;
  });
}

// ── 3. ジュニアグループ一覧を取得 ────────────────────────────
const JR_BASE = 'https://jr-official.starto.jp';

async function getJrGroups(page) {
  try {
    await page.goto(`${JR_BASE}/s/jr/page/groups?ima=3026`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1200);
    return page.evaluate(() => {
      const names = [];
      const seen  = new Set();
      const selectors = ['.c-ttl-2', '.c-ttl-1', '[class*="name"]', 'h2', 'h3', 'h4'];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const raw = el.textContent.trim().replace(/\s+/g, ' ');
          if (!raw || raw.length > 40) return;
          // "グループ名 Group Name" → "グループ名"（日本語部分のみ）
          const jaMatch = raw.match(/^([^\x00-\x7F]+)/);
          const name = jaMatch ? jaMatch[1].trim() : raw;
          if (!name || seen.has(name)) return;
          seen.add(name);
          names.push(name);
        });
        if (names.length > 0) break;
      }
      return names;
    });
  } catch (e) {
    console.error(`  ✗ ジュニアグループ取得失敗: ${e.message}`);
    return [];
  }
}

// ── 4. ジュニア個人一覧を取得 ─────────────────────────────────
async function getJrPersons(page) {
  try {
    await page.goto(`${JR_BASE}/s/jr/page/persons?ima=3009`, { waitUntil: 'networkidle', timeout: 30000 });

    // 遅延読み込みに対応：ページ末尾まで繰り返しスクロール
    let prevCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(800);
      const count = await page.evaluate(() =>
        document.querySelectorAll('.p-in_artist__list-item, .c-artist_card, [class*="person"], [class*="artist"]').length
      );
      if (count === prevCount) break;
      prevCount = count;
    }
    await sleep(500);

    // デバッグ: ジュニア個人ページの構造を保存
    const debugJr = await page.evaluate(() => {
      const items = document.querySelectorAll('.p-in_artist__list-item');
      if (items.length > 0) {
        return `ITEMS(${items.length}):\n` + Array.from(items).slice(0, 3).map(el => el.outerHTML).join('\n---\n');
      }
      // アイテムが見つからない場合はページ全体のクラス一覧を返す
      const classes = new Set();
      document.querySelectorAll('[class]').forEach(el => {
        el.className.split(/\s+/).forEach(c => c && classes.add(c));
      });
      return 'NO .p-in_artist__list-item\nCLASSES: ' + [...classes].slice(0, 60).join(', ');
    });
    await fs.writeFile('debug_jr_persons.html', debugJr, 'utf-8');
    console.log('  DEBUG: debug_jr_persons.html を保存');

    return page.evaluate(() => {
      const toJa = raw => {
        const m = raw.match(/^([^\x00-\x7F]+)/);
        return m ? m[1].trim() : '';
      };
      const names = [];
      const seen  = new Set();

      // まず .p-in_artist__list-item 内の .c-ttl-2 を狙い打ち
      const items = document.querySelectorAll('.p-in_artist__list-item');
      if (items.length > 0) {
        items.forEach(li => {
          const nameEl = li.querySelector('.c-ttl-2') || li.querySelector('.c-ttl-1');
          if (!nameEl) return;
          const name = toJa(nameEl.textContent.trim().replace(/\s+/g, ' '));
          if (!name || seen.has(name)) return;
          seen.add(name);
          names.push(name);
        });
        return names;
      }

      // フォールバック: セレクタを順番に試す（全件収集・breakなし）
      const selectors = ['.c-ttl-2', '.c-ttl-1', '[class*="person-name"]', '[class*="member-name"]'];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const raw = el.textContent.trim().replace(/\s+/g, ' ');
          if (!raw || raw.length > 30) return;
          const name = toJa(raw) || raw;
          if (!name || seen.has(name)) return;
          seen.add(name);
          names.push(name);
        });
      });
      return names;
    });
  } catch (e) {
    console.error(`  ✗ ジュニア個人取得失敗: ${e.message}`);
    return [];
  }
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
  const page    = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

  // ── アーティスト情報 ──────────────────────────────────────
  console.log('👥 グループ一覧を取得中...');
  const artistList = await getArtistList(page);
  console.log(`✅ ${artistList.length} グループ/アーティストを発見`);

  console.log('👤 タレント一覧からメンバーマッピングを取得中...');
  const talentGroupMap = await getTalentGroupMap(page);
  console.log(`✅ ${Object.keys(talentGroupMap).length} グループのメンバー情報を取得`);

  const artists = artistList.map(a => {
    const members = talentGroupMap[a.name] || [];
    console.log(`  ${a.name}: ${members.length > 0 ? members.join(', ') : 'ソロ'}`);
    return { group: a.name, members };
  });

  // ── ジュニア情報 ──────────────────────────────────────────
  console.log('\n🎤 ジュニアグループを取得中...');
  const jrGroups = await getJrGroups(page);
  console.log(`✅ ${jrGroups.length} グループ: ${jrGroups.join(', ')}`);

  console.log('👤 ジュニア個人を取得中...');
  const jrPersons = await getJrPersons(page);
  console.log(`✅ ${jrPersons.length} 名`);

  // グループ・個人ともにメンバー紐づけなし（members: []）で追加
  const jrEntries = [
    ...jrGroups.map(name => ({ group: name, members: [] })),
    ...jrPersons.map(name => ({ group: name, members: [] })),
  ];

  const allArtists = [...artists, ...jrEntries];
  await fs.writeFile('artists.json', JSON.stringify(allArtists, null, 2), 'utf-8');
  console.log(`\n✅ アーティスト ${allArtists.length} 件（うちジュニア ${jrEntries.length} 件）を artists.json に保存`);

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
