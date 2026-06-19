import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE  = 'https://starto.jp';
const OUT   = 'lives.json';
const DELAY = 2000; // サーバーへの負荷を減らすため2秒待つ

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. 一覧ページから公演リストを取得 ──────────────────────────────
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

      // 親要素をさかのぼってテキストを拾う
      let container = a;
      for (let i = 0; i < 6; i++) {
        if (container.parentElement) container = container.parentElement;
      }
      const text = container.textContent || '';

      // 日程（例: 2025.12.13-2026.01.12 または 2026.08.13 の単日）
      const dateMatch = text.match(
        /(\d{4}\.\d{2}\.\d{2})\s*[-～~]\s*(\d{4}\.\d{2}\.\d{2})|(\d{4}\.\d{2}\.\d{2})/
      );
      const date = dateMatch
        ? dateMatch[1] && dateMatch[2]
          ? `${dateMatch[1]}-${dateMatch[2]}`
          : dateMatch[3] || ''
        : '';

      // カテゴリ
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

// ── 2. 詳細ページから会場・日程・タイトル・アーティストを取得 ────────
async function getDetail(page, item) {
  try {
    await page.goto(`${BASE}${item.href}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1200); // JS描画を待つ

    return page.evaluate(item => {
      const txt = el => el?.textContent?.trim() || '';

      // タイトル
      const title =
        txt(document.querySelector('h1')) ||
        txt(document.querySelector('h2')) ||
        '';

      // アーティスト名（タイトル直下にあることが多い）
      const artistCandidates = [
        document.querySelector('[class*="artist"]'),
        document.querySelector('[class*="name"]'),
        document.querySelector('h3'),
        document.querySelector('h2 + p'),
        document.querySelector('h1 + p'),
      ];
      const artistEl   = artistCandidates.find(el => el && txt(el).length > 0);
      const artistName = txt(artistEl);

      // 会場・日程（SCHEDULEセクションを探す）
      const venues = [];
      // YYYY.MM.DD または YYYY/MM/DD 形式の日付パターン
      const dateRe = /(\d{4}[./]\d{1,2}[./]\d{1,2})/;

      // ページ内のすべての要素を走査してSCHEDULEっぽいセクションを特定
      const allEls = Array.from(document.querySelectorAll('*'));
      const scheduleHeader = allEls.find(el =>
        /^schedule$/i.test(txt(el)) && el.tagName.match(/^H[1-6]$/)
      );

      // SCHEDULEヘッダーの次の兄弟要素群を対象にする
      const targets = scheduleHeader
        ? Array.from(scheduleHeader.parentElement?.children || [])
        : allEls;

      let inSchedule = !scheduleHeader;
      for (const el of targets) {
        if (el === scheduleHeader) { inSchedule = true; continue; }
        if (!inSchedule) continue;
        // 次のH2が来たら終わり
        if (scheduleHeader && el !== scheduleHeader && el.tagName?.match(/^H[1-6]$/)) break;

        // テーブル行・リストアイテム・div を探す
        const rows = el.querySelectorAll('tr, li, [class*="item"], [class*="row"], [class*="schedule-"]');
        const targets2 = rows.length > 0 ? Array.from(rows) : [el];

        for (const row of targets2) {
          const rowText = txt(row);
          const dateMatch = rowText.match(dateRe);
          if (!dateMatch) continue;

          // 日付を YYYY.MM.DD に正規化
          const dateStr = dateMatch[1]
            .replace(/\//g, '.')
            .replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/, (_, y, m, d) =>
              `${y}.${m.padStart(2, '0')}.${d.padStart(2, '0')}`
            );

          // 日付部分を除いた残りが会場名
          const venue = rowText.replace(dateMatch[1], '').replace(/\s+/g, ' ').trim();
          if (venue) venues.push({ date: dateStr, venue });
        }
      }

      return {
        title:    title || '',
        date:     item.date,
        category: item.category,
        venues,
        artists:  artistName ? [artistName] : [],
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

// ── メイン ────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  // 日本語ページを確実に取得するためヘッダーを設定
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

  console.log('📋 一覧ページを取得中...');
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

  await fs.writeFile(OUT, JSON.stringify(lives, null, 2), 'utf-8');
  console.log(`\n🎉 完了！${lives.length} 件を ${OUT} に保存しました`);
}

main().catch(e => { console.error(e); process.exit(1); });
