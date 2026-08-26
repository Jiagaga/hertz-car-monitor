import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG = {
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
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ initialized: true, checked_at: new Date().toISOString(), vehicles }, null, 2));
}

function normalise(text) { return (text || '').replace(/\s+/g, ' ').trim(); }
function formatDate(iso) { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; }
function formatTime(time) { const [h, m] = time.split(':').map(Number); const suffix = h >= 12 ? 'PM' : 'AM'; const hour = h % 12 || 12; return `${hour}:${String(m).padStart(2, '0')} ${suffix}`; }

async function bark(title, body) {
  if (!BARK_KEY) throw new Error('BARK_KEY GitHub secret is missing');
  const url = `https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
}

async function visibleLocator(page, selector) {
  try {
    const loc = page.locator(selector).first();
    if (await loc.count() > 0 && await loc.isVisible({ timeout: 1500 })) return loc;
  } catch {}
  return null;
}

async function fillFirst(page, selectors, value, label) {
  for (const selector of selectors) {
    const loc = await visibleLocator(page, selector);
    if (loc) {
      await loc.fill(value);
      console.log(`Filled ${label} using ${selector}`);
      return loc;
    }
  }
  throw new Error(`Could not find ${label} field on Hertz page`);
}

async function fillByRole(page, nameRegex, value, label) {
  try {
    const loc = page.getByRole('textbox', { name: nameRegex }).first();
    if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
      await loc.fill(value);
      console.log(`Filled ${label} using accessible textbox ${nameRegex}`);
      return loc;
    }
  } catch (e) {
    console.log(`Accessible textbox lookup failed for ${label}: ${e.message}`);
  }
  return null;
}

async function selectFirst(page, selectors, label, value, formatted) {
  for (const selector of selectors) {
    const loc = await visibleLocator(page, selector);
    if (loc) {
      try { await loc.selectOption({ label: formatted }); } catch { await loc.selectOption(value); }
      console.log(`Selected ${label} using ${selector}`);
      return loc;
    }
  }
  throw new Error(`Could not find ${label} field on Hertz page`);
}

async function dumpFormDiagnostics(page) {
  console.log('--- HERTZ FORM DIAGNOSTICS ---');
  const fields = await page.locator('input, select, textarea, button').evaluateAll(els => els.map((el, i) => ({
    i,
    tag: el.tagName,
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id,
    placeholder: el.getAttribute('placeholder'),
    aria: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    value: el.value,
    text: (el.innerText || '').trim().slice(0, 120),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  })).slice(0, 120));
  for (const f of fields) console.log(JSON.stringify(f));
  console.log('--- ACCESSIBLE TEXTBOXES ---');
  try {
    const textboxes = await page.getByRole('textbox').evaluateAll(els => els.map((el, i) => ({
      i, aria: el.getAttribute('aria-label'), name: el.getAttribute('name'), id: el.id,
      placeholder: el.getAttribute('placeholder'), value: el.value,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    })));
    for (const t of textboxes) console.log(JSON.stringify(t));
  } catch (e) { console.log(`Textbox diagnostics failed: ${e.message}`); }
  console.log('--- BODY SAMPLE ---');
  console.log(normalise(await page.locator('body').innerText().catch(() => '')).slice(0, 2500));
}

async function main() {
  console.log('========================================');
  console.log('HERTZ INVENTORY MONITOR');
  console.log('========================================');
  console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);

  const state = loadState();
  console.log(`Previously known vehicles: ${state.vehicles?.length ?? 0}`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] });

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

    for (const selector of ['#onetrust-accept-btn-handler', 'button[id*="cookie"]', 'button[class*="cookie"]']) {
      try { const button = page.locator(selector).first(); if (await button.isVisible({ timeout: 1000 })) { await button.click(); break; } } catch {}
    }

    // Current Hertz pages expose the location box through the accessible name
    // "Pick-Up & Drop-Off Location". Keep older CSS selectors as fallbacks.
    let pickup = await fillByRole(page, /Pick-Up\s*&\s*Drop-Off Location/i, CONFIG.pickupLocation, 'pick-up location');
    if (!pickup) {
      pickup = await fillFirst(page, [
        'input[aria-label*="Pick-Up & Drop-Off Location" i]',
        'input[placeholder*="Pick-Up & Drop-Off" i]',
        'input[placeholder*="Pick-up" i]',
        'input[name="pickupLocationCode"]',
        'input[id*="pickupLocationCode" i]'
      ], CONFIG.pickupLocation, 'pick-up location');
    }

    await page.waitForTimeout(1200);

    // Select the El Calafate Airport suggestion. If the current UI uses a
    // combobox/listbox, use that first; then fall back to common suggestion classes.
    let suggestionClicked = false;
    for (const selector of ['[role="option"]', '[role="listbox"] [role="option"]', '.location-suggestion', '.autocomplete-suggestion', '[class*="suggestion"]']) {
      const suggestions = page.locator(selector);
      for (let i = 0; i < Math.min(await suggestions.count(), 40); i++) {
        try {
          const s = suggestions.nth(i);
          const text = normalise(await s.innerText());
          if (/el calafate|FTE|airport/i.test(text) && await s.isVisible()) {
            await s.click();
            console.log(`Selected location suggestion: ${text}`);
            suggestionClicked = true;
            break;
          }
        } catch {}
      }
      if (suggestionClicked) break;
    }

    if (!suggestionClicked) {
      // Keyboard fallback for autocomplete widgets.
      try {
        await pickup.press('ArrowDown');
        await pickup.press('Enter');
        console.log('Selected location using keyboard autocomplete fallback.');
      } catch {}
    }

    // Same-location return is the default on current Hertz pages. Only use a
    // separate drop-off field if the page exposes one.
    await fillFirst(page, [
      'input[name="pickUpDate"]',
      'input[id*="pickUpDate" i]',
      'input[placeholder*="MM/DD" i]'
    ], formatDate(CONFIG.pickupDate), 'pick-up date');

    await selectFirst(page, ['select[name="pickUpTime"]', 'select[id*="pickUpTime" i]'], 'pick-up time', CONFIG.pickupTime, formatTime(CONFIG.pickupTime));

    await fillFirst(page, [
      'input[name="returnDate"]',
      'input[id*="returnDate" i]',
      'input[placeholder*="MM/DD" i]'
    ], formatDate(CONFIG.dropoffDate), 'drop-off date');

    await selectFirst(page, ['select[name="returnTime"]', 'select[id*="returnTime" i]'], 'drop-off time', CONFIG.dropoffTime, formatTime(CONFIG.dropoffTime));

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
    if (!clicked) await page.locator('button[type="submit"], input[type="submit"]').first().click();

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);
    console.log(`Results URL: ${page.url()}`);

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
      if (/no vehicles|no cars|no results|unavailable|sold out/i.test(bodyText)) saveState([]);
      else throw new Error('No vehicle cards found and page does not clearly report zero inventory. Treating as a scrape failure.');
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
  } catch (error) {
    // On selector failures, print the live form structure and save a screenshot.
    // This makes the next fix evidence-based rather than guessing selectors.
    console.error(error?.stack || error);
    try {
      await dumpFormDiagnostics(page);
      await page.screenshot({ path: 'hertz-debug.png', fullPage: true });
    } catch (diagnosticError) {
      console.error(`Diagnostics also failed: ${diagnosticError?.stack || diagnosticError}`);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
