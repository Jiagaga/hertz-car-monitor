import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG={bookingUrl:'https://www.hertz.com.ar/en',pickupLocation:'El Calafate - Airport',pickupDate:'2026-09-27',pickupTime:'17:00',dropoffDate:'2026-10-04',dropoffTime:'17:00',stateFile:'state.json'};
const BARK_KEY=process.env.BARK_KEY;
const norm=s=>(s||'').replace(/\s+/g,' ').trim();
const fmtDate=iso=>{const[y,m,d]=iso.split('-');return `${m}/${d}/${y}`;};
function loadState(){try{return JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8'));}catch{return{initialized:false,vehicles:[]};}}
function saveState(v){fs.writeFileSync(CONFIG.stateFile,JSON.stringify({initialized:true,checked_at:new Date().toISOString(),vehicles:v},null,2));}
async function bark(title,body){if(!BARK_KEY)throw new Error('BARK_KEY GitHub secret is missing');const r=await fetch(`https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`);if(!r.ok)throw new Error(`Bark HTTP ${r.status}`);}

async function visibleTexts(page,pattern){const out=[];const loc=page.locator('body *');for(let i=0;i<Math.min(await loc.count(),1500);i++){const e=loc.nth(i);try{if(await e.isVisible()){const t=norm(await e.innerText());if(t&&pattern.test(t))out.push(t.slice(0,180));}}catch{}}return [...new Set(out)].slice(0,30);}

async function choosePlace(page,targetIndex){
 const controls=page.getByText('Select place',{exact:true});const visible=[];
 for(let i=0;i<await controls.count();i++){const e=controls.nth(i);try{if(await e.isVisible())visible.push(e);}catch{}}
 console.log(`Select place controls: ${await controls.count()}, visible: ${visible.length}`);if(visible.length<2)throw new Error('Expected two visible Hertz location controls');
 const control=visible[Math.min(targetIndex,visible.length-1)];await control.scrollIntoViewIfNeeded();await control.click();await page.waitForTimeout(500);
 const exact=page.getByText(/El Calafate\s*-\s*(Airport|Aeropuerto)/i);
 for(let i=0;i<await exact.count();i++){const e=exact.nth(i);try{if(await e.isVisible()){console.log(`Selecting existing location text: ${norm(await e.innerText())}`);await e.click();await page.waitForTimeout(300);return;}}catch{}}
 const ins=page.locator('input:visible');let typed=false,typedInput=null;const preferred=[];
 for(let i=0;i<await ins.count();i++){const x=ins.nth(i);try{const ph=await x.getAttribute('placeholder')||'',name=await x.getAttribute('name')||'',aria=await x.getAttribute('aria-label')||'',value=await x.inputValue().catch(()=>''),meta=`${ph} ${name} ${aria}`;if(/place|location|airport|search|pickup|dropoff/i.test(meta)&&!value)preferred.push(x);}catch{}}
 const candidates=[...preferred];for(let i=0;i<await ins.count();i++){const x=ins.nth(i);if(!candidates.includes(x))candidates.push(x);}
 for(const x of candidates){try{if(await x.inputValue().catch(()=>''))continue;await x.fill('El Calafate');typed=true;typedInput=x;console.log('Typed El Calafate into autocomplete input');break;}catch{}}
 await page.waitForTimeout(1500);
 const selectors=[page.getByText(/El Calafate\s*-\s*(Airport|Aeropuerto)/i),page.getByRole('option').filter({hasText:/El Calafate/i}),page.locator('[role="option"],li,button,[class*="option" i],[class*="suggest" i]').filter({hasText:/El Calafate/i})];
 for(const loc of selectors){for(let i=0;i<Math.min(await loc.count(),80);i++){const o=loc.nth(i);try{if(await o.isVisible()){const t=norm(await o.innerText());if(/el calafate/i.test(t)&&(/airport|aeropuerto|fte/i.test(t)||/el calafate\s*-\s*airport/i.test(t))){console.log(`Selecting autocomplete option: ${t}`);await o.click();await page.waitForTimeout(400);return;}}}catch{}}}
 if(typedInput){try{await typedInput.press('ArrowDown');await page.waitForTimeout(200);await typedInput.press('Enter');await page.waitForTimeout(500);console.log('Selected first autocomplete result with ArrowDown/Enter');return;}catch{}}
 const clues=await visibleTexts(page,/El Calafate|Aeropuerto|Airport|FTE/i);console.log(`Visible location clues: ${JSON.stringify(clues)}`);throw new Error('Could not select El Calafate Airport in Hertz Argentina location choices');
}

async function fillInput(locator,value,label){await locator.waitFor({state:'visible'});await locator.fill(value);await locator.press('Tab').catch(()=>{});console.log(`Filled ${label}: ${value}`);}
async function diagnostics(page){
 console.log('--- HERTZ ARGENTINA DIAGNOSTICS ---');console.log(`URL: ${page.url()}`);
 const fields=await page.locator('input,select,button,[role="combobox"],[role="textbox"]').evaluateAll(es=>{const clean=s=>(s||'').replace(/\s+/g,' ').trim();return es.slice(0,220).map((e,i)=>({i,tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',placeholder:e.getAttribute('placeholder')||'',aria:e.getAttribute('aria-label')||'',text:clean(e.innerText).slice(0,160),value:e.value||'',visible:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)}));});
 for(const f of fields)console.log(JSON.stringify(f));console.log(`BODY: ${norm(await page.locator('body').innerText().catch(()=>'' )).slice(0,5000)}`);
}
async function setDatesAndTimes(page){
 const inputs=page.locator('input:visible'),dateInputs=[];for(let i=0;i<await inputs.count();i++){const x=inputs.nth(i);const ph=await x.getAttribute('placeholder')||'',name=await x.getAttribute('name')||'',aria=await x.getAttribute('aria-label')||'';if(/MM\/DD\/YYYY|date|pickup|dropoff|start|end/i.test(`${ph} ${name} ${aria}`))dateInputs.push(x);}
 if(dateInputs.length<2){console.log(`Date candidates found: ${dateInputs.length}`);throw new Error(`Expected two visible date inputs, found ${dateInputs.length}`);}
 await fillInput(dateInputs[0],fmtDate(CONFIG.pickupDate),'pick-up date');await fillInput(dateInputs[1],fmtDate(CONFIG.dropoffDate),'drop-off date');
 const times=page.getByText('hh:mm',{exact:true});if(await times.count()>=2){for(let i=0;i<2;i++){await times.nth(i).click();await page.waitForTimeout(300);const targets=page.getByText(/^(17:00|5:00 PM)$/,{exact:true});let ok=false;for(let j=0;j<await targets.count();j++){const t=targets.nth(j);try{if(await t.isVisible()){await t.click();ok=true;break;}}catch{}}console.log(`Time ${i}: ${ok?'17:00 selected':'17:00 option not exposed'}`);}}else console.log('Time controls not detected; continuing.');
}
async function extractVehicles(page){
 const selector='.car-card,.vehicle-card,[class*="vehicle-card" i],[class*="vehicleCard" i],[data-vehicle],[data-vehicletype],[class*="car-card" i]';
 return await page.evaluate((selector)=>{const clean=s=>(s||'').replace(/\s+/g,' ').trim();return [...document.querySelectorAll(selector)].map((card,i)=>{const text=clean(card.textContent),name=clean(card.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]')?.textContent)||`Vehicle ${i+1}`,price=clean(card.querySelector('[class*="price" i],[class*="rate" i]')?.textContent),transmission=clean(card.querySelector('[class*="transmission" i],[class*="gear" i]')?.textContent),id=card.getAttribute('data-vehicle-id')||card.getAttribute('data-vehicleid')||card.getAttribute('data-vehicletype')||`${name}|${transmission}`;return{id,name,price,transmission,text:text.slice(0,700)};});},selector);
}
async function main(){
 console.log('========================================');console.log('HERTZ INVENTORY MONITOR');console.log('========================================');console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);
 const state=loadState();console.log(`Previously known vehicles: ${state.vehicles?.length??0}`);const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});let page=null;
 try{const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',viewport:{width:1280,height:1000},locale:'en-US'});page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(CONFIG.bookingUrl,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(5000);console.log(`Loaded URL: ${page.url()}`);
  await choosePlace(page,0);await choosePlace(page,1);await setDatesAndTimes(page);await page.getByRole('button',{name:'Search',exact:true}).click();console.log('Clicked Search');await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});await page.waitForTimeout(7000);console.log(`Results URL: ${page.url()}`);
  const body=norm(await page.locator('body').innerText().catch(()=>''));console.log(`Results page sample: ${body.slice(0,2500)}`);const vehicles=await extractVehicles(page);console.log(`Vehicle cards found: ${vehicles.length}`);
  if(!vehicles.length){await page.screenshot({path:'hertz-debug.png',fullPage:true}).catch(()=>{});if(/no vehicles|no cars|no results|unavailable|sold out|não encontramos|no encontramos/i.test(body)){saveState([]);return;}throw new Error('No vehicle cards found and result page does not clearly report zero inventory.');}
  const current=vehicles.map(v=>`${v.id}|${norm(v.name)}|${norm(v.transmission)}|${norm(v.price)}`).sort(),previous=new Set(state.vehicles||[]);if(!state.initialized){console.log('First successful check: saving baseline without Bark notification.');saveState(current);return;}const added=current.filter(v=>!previous.has(v));console.log(`Current: ${current.length}; added: ${added.length}`);if(added.length)await bark('🚨 Hertz 新增库存',`El Calafate Airport\n2026-09-27 17:00 → 2026-10-04 17:00\n\n${added.slice(0,10).map(v=>`🚗 ${v}`).join('\n')}`);saveState(current);
 }catch(e){console.error(e?.stack||e);if(page){try{await diagnostics(page);await page.screenshot({path:'hertz-debug.png',fullPage:true});}catch(de){console.error(`Diagnostics also failed: ${de?.stack||de}`);}}process.exitCode=1;}finally{await browser.close();}}
main();
