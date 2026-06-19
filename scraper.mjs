import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE  = 'https://starto.jp';
const DELAY = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. アーティスト一覧を取得 ────────────────────────────────
async function getArtistList(page) {
  await page.goto(`${BASE}/s/p/search/artist?ima=3141`, { waitUntil: 'networkidle', timeout: 30000 });

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

// ── 2. アーティスト詳細ページからメンバーを取得 ─────────────
async function getArtistMembers(page, artist) {
  try {
    await page.goto(`${BASE}/s/p/artist/${artist.id}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1200);

    return page.evaluate((artistName) => {
      const txt = el => el?.textContent?.trim() || '';

      const members = [];
      const seen    = new Set([artistName.replace(/\s/g, '')]);

      // アーティスト一覧と同じ .c-ttl-2 クラスでメンバー名が列挙されている
      document.querySelectorAll('.c-ttl-2').forEach(el => {
        const name = txt(el).replace(/\s+/g, '');
        if (!name || seen.has(name)) return;
        seen.add(name);
        members.push(txt(el).trim());
      });

      return members;
    }, artist.name);
  } catch (e) {
    console.error(`  ✗ ${artist.name} メンバー取得失敗: ${e.message}`);
    return [];
  }
}

// ── 3. 公演一覧を取得 ────────────────────────────────────────
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
  console.log('👥 アーティスト一覧を取得中...');
  const artistList = await getArtistList(page);
  console.log(`✅ ${artistList.length} 名のアーティストを発見`);

  const artists = [];
  for (let i = 0; i < artistList.length; i++) {
    const artist = artistList[i];
    console.log(`[${i + 1}/${artistList.length}] ${artist.name} のメンバーを取得中...`);
    const members = await getArtistMembers(page, artist);
    artists.push({ group: artist.name, members });
    console.log(`  → ${members.length > 0 ? members.join(', ') : 'ソロ'}`);
    await sleep(DELAY);
  }

  await fs.writeFile('artists.json', JSON.stringify(artists, null, 2), 'utf-8');
  console.log(`\n✅ アーティスト ${artists.length} 件を artists.json に保存`);

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
