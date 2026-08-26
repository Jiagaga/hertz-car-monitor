import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG = {
  pickupLocation: 'El Calafate Airport (FTE)',
  dropoffLocation: 'El Calafate Airport (FTE)',
  pickupDate: '2026-09-27',
  pickupTime: '17:00',
  dropoffDate: '2026-10-04',
  dropoffTime: '17:00',
  stateFile: 'state.json',
};

const BARK_KEY = process.env.BARK_KEY;

function loadState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')); }
  catch { return { initialized: false, vehicles: [] }; }
}

function saveState(vehicles) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify({
    initialized: true,
    checked_at: new Date().toISOString(),
    vehicles,
  }, null, 2));
}

function normalise(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function bark(title, body) {
  if (!BARK_KEY) throw new Error('BARK_KEY GitHub secret is missing');
  const url = `https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
}

async function main() {
  console.log('========================================');
  console.log('HERTZ INVENTORY MONITOR');
  console.log('========================================');
  console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);

  const state = loadState();
  console.log(`Previously known vehicles: ${state.vehicles?.length ?? 0}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto('https://www.hertz.com/rentacar/reservation/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // Accept common cookie banners if present.
    for (const selector of ['#onetrust-accept-btn-handler', 'button[id*="cookie"]', 'button[class*="cookie"]']) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) { await button.click(); break; }
      } catch {}
    }

    const pickup = page.locator('input[name="pickupLocationCode"], input[id*="pickupLocationCode"], input[placeholder*="Pick-up"]').first();
    await pickup.fill(CONFIG.pickupLocation);
    await page.waitForTimeout(1200);

    // Pick the first visible autocomplete result.
    const suggestions = page.locator('.location-suggestion, .autocomplete-suggestion, [class*="suggestion"]');
    try { if (await suggestions.first().isVisible({ timeout: 2500 })) await suggestions.first().click(); } catch {}

    const pickupDate = page.locator('input[name="pickUpDate"], input[id*="pickUpDate"], input[placeholder*="MM/DD"]').first();
    await pickupDate.fill('09/27/2026');

    const pickupTime = page.locator('select[name="pickUpTime"], select[id*="pickUpTime"]').first();
    try { await pickupTime.selectOption({ label: '5:00 PM' }); } catch { await pickupTime.selectOption('17:00'); }

    const returnDate = page.locator('input[name="returnDate"], input[id*="returnDate"]').first();
    await returnDate.fill('10/04/2026');

    const returnTime = page.locator('select[name="returnTime"], select[id*="returnTime"]').first();
    try { await returnTime.selectOption({ label: '5:00 PM' }); } catch { await returnTime.selectOption('17:00'); }

    const searchButton = page.locator('button[type="submit"], input[type="submit"], button[id*="search"], button[class*="search"]').first();
    await searchButton.click();

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const url = page.url();
    console.log(`Results URL: ${url}`);

    const vehicles = await page.evaluate(() => {
      const cards = document.querySelectorAll('.car-card, .vehicle-card, [class*="vehicleCard"], [data-vehicletype]');
      return [...cards].map((card, index) => {
        const text = card.textContent?.replace(/\s+/g, ' ').trim() || '';
        const name = card.querySelector('[class*="car-name"], [class*="vehicle-name"], h2, h3')?.textContent?.trim() || `Vehicle ${index + 1}`;
        const cls = card.querySelector('[class*="car-class"], [class*="vehicle-class"]')?.textContent?.trim() || '';
        const transmission = card.querySelector('[class*="transmission"]')?.textContent?.trim() || '';
        const price = card.querySelector('[class*="daily-rate"], [class*="price-per-day"], [class*="total-price"], [class*="total-rate"]')?.textContent?.trim() || '';
        const id = card.getAttribute('data-vehicle-id') || card.getAttribute('data-vehicleid') || `${name}|${cls}|${transmission}`;
        return { id, name, class: cls, transmission, price, text: text.slice(0, 500) };
      });
    });

    console.log(`Vehicle cards found: ${vehicles.length}`);

    if (vehicles.length === 0) {
      // Do NOT overwrite a known-good inventory with an empty result caused by a page/parser failure.
      const bodyText = normalise(await page.locator('body').innerText().catch(() => ''));
      console.log(`Page text sample: ${bodyText.slice(0, 1000)}`);
      if (/no vehicles|no cars|unavailable|sold out/i.test(bodyText)) {
        console.log('Hertz explicitly reports no vehicles.');
        saveState([]);
      } else {
        throw new Error('No vehicle cards found and page does not clearly report zero inventory. Treating as a scrape failure.');
      }
      return;
    }

    const current = vehicles.map(v => `${v.id}|${normalise(v.name)}|${normalise(v.class)}|${normalise(v.transmission)}|${normalise(v.price)}`).sort();
    const previous = new Set(state.vehicles || []);

    if (!state.initialized) {
      console.log('First successful check: saving baseline without Bark notification.');
      saveState(current);
      return;
    }

    const added = current.filter(v => !previous.has(v));
    const removed = [...previous].filter(v => !current.includes(v));

    console.log(`Current: ${current.length}; added: ${added.length}; removed: ${removed.length}`);

    if (added.length > 0) {
      const lines = added.slice(0, 10).map(v => `🚗 ${v}`);
      await bark('🚨 Hertz 新增库存', `El Calafate Airport\n2026-09-27 17:00 → 2026-10-04 17:00\n\n${lines.join('\n')}`);
      console.log('Bark notification sent.');
    }

    saveState(current);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
