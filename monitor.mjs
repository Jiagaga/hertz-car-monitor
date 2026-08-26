import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG = {
  bookingUrl: 'https://www.hertz.com/us/en/location/argentina/elcalafate/ftet50',
  pickupLocation: 'El Calafate Airport (FTE)',
  pickupDate: '2026-09-27', pickupTime: '17:00',
  dropoffDate: '2026-10-04', dropoffTime: '17:00',
  stateFile: 'state.json'
};
const BARK_KEY = process.env.BARK_KEY;

const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const fmtDate = iso => { const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };
const fmtTime = t => { const [h,m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`; };
function loadState() { try { return JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8')); } catch { return {initialized:false,vehicles:[]}; } }
function saveState(vehicles) { fs.writeFileSync(CONFIG.stateFile, JSON.stringify({initialized:true,checked_at:new Date().toISOString(),vehicles},null,2)); }

async function bark(title, body) {
  if (!BARK_KEY) throw new Error('BARK_KEY GitHub secret is missing');
  const r = await fetch(`https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`);
  if (!r.ok) throw new Error(`Bark HTTP ${r.status}`);
}

async function visible(page, selector) {
  try { const x = page.locator(selector).first(); if (await x.isVisible({timeout:1000})) return x; } catch {}
  return null;
}

async function inputByKeywords(page, selectors, keywords=[]) {
  for (const s of selectors) { const x = await visible(page,s); if (x) return x; }
  const inputs = page.locator('input');
  let best=null, score=-1;
  for (let i=0;i<await inputs.count();i++) {
    const x=inputs.nth(i); if (!(await x.isVisible().catch(()=>false))) continue;
    const a=await x.evaluate(el=>[el.type,el.name,el.id,el.placeholder,el.getAttribute('aria-label')].join(' ').toLowerCase());
    let n=0; for (const k of keywords) if (a.includes(k.toLowerCase())) n+=10;
    if (['text','date',''].includes(await x.getAttribute('type'))) n++;
    if(n>score){score=n;best=x;}
  }
  return best;
}

async function chooseLocation(page, input) {
  await page.waitForTimeout(1200);
  for (const s of ['[role="option"]','[role="listbox"] [role="option"]','[class*="suggestion"]']) {
    const xs=page.locator(s);
    for(let i=0;i<Math.min(await xs.count(),40);i++) {
      try { const x=xs.nth(i), t=norm(await x.innerText()); if(/el calafate|FTE|airport/i.test(t)&&await x.isVisible()){await x.click();console.log(`Selected location: ${t}`);return;} } catch {}
    }
  }
  await input.press('ArrowDown').catch(()=>{}); await input.press('Enter').catch(()=>{});
  console.log('Selected location using keyboard fallback');
}

async function selectTime(page, selectors, label, value, fallback) {
  for(const s of selectors){const x=await visible(page,s);if(x){try{await x.selectOption({label:fmtTime(value)});}catch{await x.selectOption(value);}console.log(`Selected ${label}: ${fmtTime(value)}`);return;}}
  const combos=page.getByRole('combobox');
  if(await combos.count()>fallback){const x=combos.nth(fallback);if(await x.isVisible().catch(()=>false)){await x.selectOption({label:fmtTime(value)}).catch(async()=>await x.fill(fmtTime(value)));console.log(`Selected ${label}: ${fmtTime(value)}`);return;}}
  throw new Error(`Could not find ${label} control on Hertz page`);
}

async function diagnostics(page){
  console.log('--- HERTZ DIAGNOSTICS ---');
  console.log(`URL: ${page.url()}`);
  const fields=await page.locator('input,select,button,[role="combobox"],[role="textbox"]').evaluateAll(es=>es.slice(0,150).map((e,i)=>({i,tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',aria:e.getAttribute('aria-label')||'',placeholder:e.getAttribute('placeholder')||'',text:norm(e.innerText||'').slice(0,100),value:e.value||'',visible:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)})));
  for(const f of fields) console.log(JSON.stringify(f));
  console.log(`BODY: ${norm(await page.locator('body').innerText().catch(()=>'' )).slice(0,2500)}`);
}

async function main(){
  console.log('========================================'); console.log('HERTZ INVENTORY MONITOR'); console.log('========================================');
  console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);
  const state=loadState(); console.log(`Previously known vehicles: ${state.vehicles?.length ?? 0}`);
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});
  let page=null;
  try{
    const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',viewport:{width:1280,height:900},locale:'en-US'});
    page=await context.newPage(); page.setDefaultTimeout(30000);
    await page.goto(CONFIG.bookingUrl,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(7000); console.log(`Loaded URL: ${page.url()}`);
    for(const s of ['#onetrust-accept-btn-handler','button[id*="cookie"]','button[class*="cookie"]']){try{const b=page.locator(s).first();if(await b.isVisible({timeout:1000})){await b.click();break;}}catch{}}

    const pickup=await inputByKeywords(page,[
      'input[aria-label*="Pick-Up & Drop-Off Location" i]',
      'input[aria-label*="Select your location" i]',
      'input[aria-label*="location" i]',
      'input[placeholder*="Pick-Up & Drop-Off" i]',
      'input[placeholder*="location" i]'
    ],['location','pickup']);
    if(!pickup) throw new Error('Could not find pick-up location field on Hertz page');
    await pickup.fill(CONFIG.pickupLocation); console.log(`Filled pick-up location: ${CONFIG.pickupLocation}`); await chooseLocation(page,pickup);

    const pickupDate=await inputByKeywords(page,[
      'input[name="pickUpDate"]','input[id*="pickUpDate" i]','input[aria-label*="pickup date" i]','input[placeholder*="MM/DD" i]'
    ],['pickupdate','pickup date']);
    if(!pickupDate) throw new Error('Could not find pick-up date field on Hertz page');
    await pickupDate.fill(fmtDate(CONFIG.pickupDate)); console.log(`Filled pick-up date: ${fmtDate(CONFIG.pickupDate)}`);

    let dropDate=await inputByKeywords(page,['input[name="returnDate"]','input[id*="returnDate" i]','input[aria-label*="drop-off date" i]','input[aria-label*="return date" i]'],['returndate','dropoff date','return date']);
    if(!dropDate){const xs=page.locator('input');const visible=[];for(let i=0;i<await xs.count();i++){if(await xs.nth(i).isVisible().catch(()=>false))visible.push(xs.nth(i));}if(visible.length>=3)dropDate=visible[2];}
    if(!dropDate) throw new Error('Could not find drop-off date field on Hertz page');
    await dropDate.fill(fmtDate(CONFIG.dropoffDate)); console.log(`Filled drop-off date: ${fmtDate(CONFIG.dropoffDate)}`);

    await selectTime(page,['select[name="pickUpTime"]','select[id*="pickUpTime" i]'],'pick-up time',CONFIG.pickupTime,0);
    await selectTime(page,['select[name="returnTime"]','select[id*="returnTime" i]'],'drop-off time',CONFIG.dropoffTime,1);

    const buttons=page.getByRole('button'); let clicked=false;
    for(let i=0;i<await buttons.count();i++){const b=buttons.nth(i);try{const t=norm(await b.innerText());if(/^(search|view vehicles|continue)$/i.test(t)&&await b.isVisible()){await b.click();console.log(`Clicked search button: ${t}`);clicked=true;break;}}catch{}}
    if(!clicked){const b=page.locator('button[type="submit"],input[type="submit"]').first();if(await b.count())await b.click();else throw new Error('Could not find Hertz search button');}
    await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); await page.waitForTimeout(6000); console.log(`Results URL: ${page.url()}`);

    const vehicles=await page.evaluate(()=>[...document.querySelectorAll('.car-card,.vehicle-card,[class*="vehicleCard"],[data-vehicletype],[data-testid*="vehicle" i]')].map((card,i)=>{const text=card.textContent?.replace(/\s+/g,' ').trim()||'';const name=card.querySelector('[class*="car-name"],[class*="vehicle-name"],h2,h3')?.textContent?.trim()||`Vehicle ${i+1}`;const cls=card.querySelector('[class*="car-class"],[class*="vehicle-class"]')?.textContent?.trim()||'';const transmission=card.querySelector('[class*="transmission"],[class*="gear"]')?.textContent?.trim()||'';const price=card.querySelector('[class*="daily-rate"],[class*="price-per-day"],[class*="total-price"],[class*="total-rate"],[class*="price"]')?.textContent?.trim()||'';const id=card.getAttribute('data-vehicle-id')||card.getAttribute('data-vehicleid')||card.getAttribute('data-vehicletype')||`${name}|${cls}|${transmission}`;return{id,name,class:cls,transmission,price,text:text.slice(0,700)}}));
    console.log(`Vehicle cards found: ${vehicles.length}`);
    if(!vehicles.length){const body=norm(await page.locator('body').innerText().catch(()=>''));console.log(`Page text sample: ${body.slice(0,1500)}`);await page.screenshot({path:'hertz-debug.png',fullPage:true}).catch(()=>{});if(/no vehicles|no cars|no results|unavailable|sold out/i.test(body)){saveState([]);return;}throw new Error('No vehicle cards found and page does not clearly report zero inventory.');}

    const current=vehicles.map(v=>`${v.id}|${norm(v.name)}|${norm(v.class)}|${norm(v.transmission)}|${norm(v.price)}`).sort();
    const previous=new Set(state.vehicles||[]);
    if(!state.initialized){console.log('First successful check: saving baseline without Bark notification.');saveState(current);return;}
    const added=current.filter(v=>!previous.has(v)); const removed=[...previous].filter(v=>!current.includes(v)); console.log(`Current: ${current.length}; added: ${added.length}; removed: ${removed.length}`);
    if(added.length){await bark('🚨 Hertz 新增库存',`El Calafate Airport\n2026-09-27 17:00 → 2026-10-04 17:00\n\n${added.slice(0,10).map(v=>`🚗 ${v}`).join('\n')}`);console.log('Bark notification sent.');}
    saveState(current);
  }catch(e){console.error(e?.stack||e);if(page){try{await diagnostics(page);await page.screenshot({path:'hertz-debug.png',fullPage:true});}catch(de){console.error(`Diagnostics also failed: ${de?.stack||de}`);}}process.exitCode=1;}
  finally{await browser.close();}
}
main();
