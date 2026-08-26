import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG = {
  // Hertz's current public booking widget is embedded in the location page.
  bookingUrl: 'https://www.hertz.com/us/en/location/argentina/elcalafate/ftet50',
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

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

async function bark(title, body) {
  if (!BARK_KEY) throw new Error('BARK_KEY GitHub secret is missing');
  const url = `https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
}

async function fillFirst(page, selectors, value, label) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).filter({ visible: true }).first();
      if (await loc.count() > 0) {
        await loc.fill(value);
        console.log(`Filled ${label} using ${selector}`);
        return loc;
      }
    } catch {}
  }
  throw new Error(`Could not find ${label} field on Hertz page`);
}

async function selectFirst(page, selectors, label, value, formatted) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).filter({ visible: true }).first();
      if (await loc.count() > 0) {
        try { await loc.selectOption({ label: formatted }); }
        catch { await loc.selectOption(value); }
        console.log(`Selected ${label} using ${selector}`);
        return loc;
      }
    } catch {}
  }
  throw new Error(`Could not find ${label} field on Hertz page`);
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

    await page.goto(CONFIG.bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    console.log(`Loaded URL: ${page.url()}`);

    // Accept common cookie banners if present.
    for (const selector of ['#onetrust-accept-btn-handler', 'button[id*="cookie"]', 'button[class*="cookie"]']) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) { await button.click(); break; }
      } catch {}
    }

    // Hertz changed its booking widget. Prefer the current accessible/placeholder
    // fields, while keeping the selectors from the existing open-source project
    // as fallbacks.
    const pickup = await fillFirst(page, [
      'input[aria-label*="Pick-Up & Drop-Off Location" i]',
      'input[placeholder*="Pick-Up & Drop-Off" i]',
      'input[placeholder*="Pick-up" i]',
      'input[name="pickupLocationCode"]',
      'input[id*="pickupLocationCode" i]',
      'input[type="text"]'
    ], CONFIG.pickupLocation, 'pick-up location');

    await page.waitForTimeout(1500);

    // Choose an autocomplete result containing El Calafate/FTE if one appears.
    const suggestions = page.locator('[role="option"], .location-suggestion, .autocomplete-suggestion, [class*="suggestion"]');
    const suggestionCount = await suggestions.count();
    for (let i = 0; i < Math.min(suggestionCount, 20); i++) {
      try {
        const s = suggestions.nth(i);
        const text = normalise(await s.innerText());
        if (/el calafate|FTE|airport/i.test(text) && await s.isVisible()) {
          await s.click();
          console.log(`Selected location suggestion: ${text}`);
          break;
        }
      } catch {}
    }

    // The current Hertz location page uses separate pickup/drop-off detail controls.
    await fillFirst(page, [
      'input[name="pickUpDate"]',
      'input[id*="pickUpDate" i]',
      'input[placeholder*="MM/DD" i]'
    ], formatDate(CONFIG.pickupDate), 'pick-up date');

    await selectFirst(page, [
      'select[name="pickUpTime"]',
      'select[id*="pickUpTime" i]'
    ], 'pick-up time', CONFIG.pickupTime, formatTime(CONFIG.pickupTime));

    await fillFirst(page, [
      'input[name="returnDate"]',
      'input[id*="returnDate" i]'
    ], formatDate(CONFIG.dropoffDate), 'drop-off date');

    await selectFirst(page, [
      'select[name="returnTime"]',
      'select[id*="returnTime" i]'
    ], 'drop-off time', CONFIG.dropoffTime, formatTime(CONFIG.dropoffTime));

    // Search / View Vehicles.
    const buttons = page.getByRole('button');
    let clicked = false;
    for (let i = 0; i < await buttons.count(); i++) {
      const b = buttons.nth(i);
      try {
        const text = normalise(await b.innerText());
        if (/^(search|view vehicles|continue)$/i.test(text) && await b.isVisible()) {
          await b.click();
          console.log(`Clicked search button: ${text}`);
          clicked = true;
          break;
        }
      } catch {}
    }
    if (!clicked) {
      const submit = page.locator('button[type="submit"], input[type="submit"]').first();
      await submit.click();
    }

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const url = page.url();
    console.log(`Results URL: ${url}`);

    const vehicles = await page.evaluate(() => {
      const cards = document.querySelectorAll('.car-card, .vehicle-card, [class*="vehicleCard"], [data-vehicletype], [data-testid*="vehicle" i]');
      return [...cards].map((card, index) => {
        const text = card.textContent?.replace(/\s+/g, ' ').trim() || '';
        const name = card.querySelector('[class*="car-name"], [class*="vehicle-name"], h2, h3')?.textContent?.trim() || `Vehicle ${index + 1}`;
        const cls = card.querySelector('[class*="car-class"], [class*="vehicle-class"]')?.textContent?.trim() || '';
        const transmission = card.querySelector('[class*="transmission"], [class*="gear"]')?.textContent?.trim() || '';
        const price = card.querySelector('[class*="daily-rate"], [class*="price-per-day"], [class*="total-price"], [class*="total-rate"], [class*="price"]')?.textContent?.trim() || '';
        const id = card.getAttribute('data-vehicle-id') || card.getAttribute('data-vehicleid') || card.getAttribute('data-vehicletype') || `${name}|${cls}|${transmission}`;
        return { id, name, class: cls, transmission, price, text: text.slice(0, 700) };
      });
    });

    console.log(`Vehicle cards found: ${vehicles.length}`);

    if (vehicles.length === 0) {
      const bodyText = normalise(await page.locator('body').innerText().catch(() => ''));
      console.log(`Page text sample: ${bodyText.slice(0, 1500)}`);
      await page.screenshot({ path: 'hertz-debug.png', fullPage: true }).catch(() => {});

      if (/no vehicles|no cars|no results|unavailable|sold out/i.test(bodyText)) {
        console.log('Hertz explicitly reports no vehicles.');
        if (state.initialized && (state.vehicles || []).length > 0) {
          saveState([]);
        } else {
          saveState([]);
        }
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
