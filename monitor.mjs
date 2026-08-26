import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG = {
  bookingUrl: 'https://www.hertz.com.ar/en',
  pickupLocation: 'El Calafate - Airport',
  pickupDate: '2026-09-27', pickupTime: '17:00',
  dropoffDate: '2026-10-04', dropoffTime: '17:00',
  stateFile: 'state.json'
};
const BARK_KEY = process.env.BARK_KEY;
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const fmtDate = iso => { const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };
function loadState(){try{return JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8'));}catch{return {initialized:false,vehicles:[]};}}
function saveState(vehicles){fs.writeFileSync(CONFIG.stateFile,JSON.stringify({initialized:true,checked_at:new Date().toISOString(),vehicles},null,2));}
async function bark(title,body){if(!BARK_KEY)throw new Error('BARK_KEY GitHub secret is missing');const r=await fetch(`https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`);if(!r.ok)throw new Error(`Bark HTTP ${r.status}`);}

async function choosePlace(page, targetIndex){
  const selects=page.getByText('Select place',{exact:true});
  const count=await selects.count();
  console.log(`Select place controls found: ${count}`);
  const visible=[];
  for(let i=0;i<count;i++){
    const el=selects.nth(i);
    try{if(await el.isVisible()) visible.push(el);}catch{}
  }
  console.log(`Visible Select place controls: ${visible.length}`);
  if(!visible.length) throw new Error('No visible Hertz location controls found');
  const button=visible[Math.min(targetIndex,visible.length-1)];
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForTimeout(1000);
  const candidates=page.getByText(/El Calafate\s*-\s*Airport|El Calafate Airport/i);
  for(let i=0;i<await candidates.count();i++){
    const c=candidates.nth(i); try{if(await c.isVisible()){console.log(`Selecting location option: ${norm(await c.innerText())}`);await c.click();return;}}catch{}
  }
  throw new Error('Could not find El Calafate Airport in Hertz Argentina location choices');
}

async function fillInput(page, locator, value, label){await locator.waitFor({state:'visible'});await locator.fill(value);await locator.press('Tab').catch(()=>{});console.log(`Filled ${label}: ${value}`);}

async function diagnostics(page){
  console.log('--- HERTZ ARGENTINA DIAGNOSTICS ---'); console.log(`URL: ${page.url()}`);
  const fields=await page.locator('input,select,button,[role="combobox"],[role="textbox"]').evaluateAll(es=>es.slice(0,180).map((e,i)=>({i,tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',aria:e.getAttribute('aria-label')||'',placeholder:e.getAttribute('placeholder')||'',text:(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,120),value:e.value||'',visible:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)})));
  for(const f of fields)console.log(JSON.stringify(f));
  console.log(`BODY: ${norm(await page.locator('body').innerText().catch(()=>'' )).slice(0,3500)}`);
}

async function main(){
 console.log('========================================');console.log('HERTZ INVENTORY MONITOR');console.log('========================================');console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);
 const state=loadState();console.log(`Previously known vehicles: ${state.vehicles?.length??0}`);
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});let page=null;
 try{
  const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',viewport:{width:1280,height:1000},locale:'en-US'});
  page=await context.newPage();page.setDefaultTimeout(30000);
  await page.goto(CONFIG.bookingUrl,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(5000);console.log(`Loaded URL: ${page.url()}`);
  await choosePlace(page,0);

  const inputs=page.locator('input:visible');
  console.log(`Visible inputs: ${await inputs.count()}`);
  const dateInputs=[];
  for(let i=0;i<await inputs.count();i++){const x=inputs.nth(i);const type=await x.getAttribute('type');const ph=await x.getAttribute('placeholder');if(type==='date'||/MM\/DD\/YYYY/i.test(ph||''))dateInputs.push(x);}
  if(dateInputs.length<2)throw new Error(`Expected two visible date inputs, found ${dateInputs.length}`);
  await fillInput(page,dateInputs[0],fmtDate(CONFIG.pickupDate),'pick-up date');
  await fillInput(page,dateInputs[1],fmtDate(CONFIG.dropoffDate),'drop-off date');

  const timeInputs=[];
  for(let i=0;i<await inputs.count();i++){const x=inputs.nth(i);const ph=await x.getAttribute('placeholder');const type=await x.getAttribute('type');if(/hh:mm/i.test(ph||'')||type==='time')timeInputs.push(x);}
  if(timeInputs.length>=2){await fillInput(page,timeInputs[0],CONFIG.pickupTime,'pick-up time');await fillInput(page,timeInputs[1],CONFIG.dropoffTime,'drop-off time');}
  else console.log('No native time inputs found; leaving site defaults for time controls.');

  const search=page.getByText('Search',{exact:true}).last();await search.click();console.log('Clicked Search');
  await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});await page.waitForTimeout(7000);console.log(`Results URL: ${page.url()}`);
  const body=norm(await page.locator('body').innerText().catch(()=>''));console.log(`Results page sample: ${body.slice(0,2200)}`);

  const vehicles=await page.evaluate(()=>[...document.querySelectorAll('.car-card,.vehicle-card,[class*="vehicle-card" i],[class*="vehicleCard" i],[data-vehicle],[data-vehicletype]')].map((card,i)=>{const text=card.textContent?.replace(/\s+/g,' ').trim()||'';const name=card.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]')?.textContent?.trim()||`Vehicle ${i+1}`;const price=card.querySelector('[class*="price" i],[class*="rate" i]')?.textContent?.trim()||'';const transmission=card.querySelector('[class*="transmission" i],[class*="gear" i]')?.textContent?.trim()||'';const id=card.getAttribute('data-vehicle-id')||card.getAttribute('data-vehicleid')||card.getAttribute('data-vehicletype')||`${name}|${transmission}`;return{id,name,price,transmission,text:text.slice(0,700)}}));
  console.log(`Vehicle cards found: ${vehicles.length}`);
  if(!vehicles.length){await page.screenshot({path:'hertz-debug.png',fullPage:true}).catch(()=>{});if(/no vehicles|no cars|no results|unavailable|sold out|não encontramos|no encontramos/i.test(body)){saveState([]);return;}throw new Error('No vehicle cards found and result page does not clearly report zero inventory.');}
  const current=vehicles.map(v=>`${v.id}|${norm(v.name)}|${norm(v.transmission)}|${norm(v.price)}`).sort();const previous=new Set(state.vehicles||[]);
  if(!state.initialized){console.log('First successful check: saving baseline without Bark notification.');saveState(current);return;}
  const added=current.filter(v=>!previous.has(v));console.log(`Current: ${current.length}; added: ${added.length}`);
  if(added.length)await bark('🚨 Hertz 新增库存',`El Calafate Airport\n2026-09-27 17:00 → 2026-10-04 17:00\n\n${added.slice(0,10).map(v=>`🚗 ${v}`).join('\n')}`);
  saveState(current);
 }catch(e){console.error(e?.stack||e);if(page){try{await diagnostics(page);await page.screenshot({path:'hertz-debug.png',fullPage:true});}catch(de){console.error(`Diagnostics also failed: ${de?.stack||de}`);}}process.exitCode=1;}finally{await browser.close();}
}
main();
