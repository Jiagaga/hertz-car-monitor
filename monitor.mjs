import { chromium } from 'playwright';
import fs from 'node:fs';

const CONFIG={bookingUrl:'https://www.hertz.com.ar/en',pickupLocation:'El Calafate - Airport',pickupDate:'2026-09-27',pickupTime:'17:00',dropoffDate:'2026-10-04',dropoffTime:'17:00',stateFile:'state.json'};
const BARK_KEY=process.env.BARK_KEY;
const norm=s=>(s||'').replace(/\s+/g,' ').trim();
const fmtDate=iso=>{const[y,m,d]=iso.split('-');return `${m}/${d}/${y}`;};
function loadState(){try{return JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8'));}catch{return{initialized:false,vehicles:[]};}}
function saveState(v){fs.writeFileSync(CONFIG.stateFile,JSON.stringify({initialized:true,checked_at:new Date().toISOString(),vehicles:v},null,2));}
async function bark(title,body){if(!BARK_KEY)throw new Error('BARK_KEY GitHub secret is missing');const r=await fetch(`https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=hertz-car-monitor&sound=alarm&level=timeSensitive`);if(!r.ok)throw new Error(`Bark HTTP ${r.status}`);}

async function choosePlace(page,targetIndex){
 const controls=page.getByText('Select place',{exact:true});const visible=[];
 for(let i=0;i<await controls.count();i++){const e=controls.nth(i);try{if(await e.isVisible())visible.push(e);}catch{}}
 console.log(`Select place controls: ${await controls.count()}, visible: ${visible.length}`);if(visible.length<2)throw new Error('Expected two visible Hertz location controls');
 const control=visible[Math.min(targetIndex,visible.length-1)];await control.scrollIntoViewIfNeeded();await control.click();await page.waitForTimeout(400);
 // Hertz Argentina renders the location picker as a visible text input after the control is opened.
 const ins=page.locator('input:visible');let typed=false;
 for(let i=0;i<await ins.count();i++){const x=ins.nth(i);const value=await x.inputValue().catch(()=>''),ph=await x.getAttribute('placeholder');if(!value&&(!ph||/place|location|search/i.test(ph))){await x.fill('El Calafate');typed=true;console.log(`Typed El Calafate into location input ${i}`);break;}}
 await page.waitForTimeout(1000);
 const candidates=page.getByText(/El Calafate\s*-\s*Airport|El Calafate Airport/i);for(let i=0;i<await candidates.count();i++){const c=candidates.nth(i);try{if(await c.isVisible()){console.log(`Selecting location option: ${norm(await c.innerText())}`);await c.click();return;}}catch{}}
 const opts=page.locator('[role="option"],li,button').filter({hasText:/El Calafate/i});for(let i=0;i<Math.min(await opts.count(),50);i++){const o=opts.nth(i);try{if(await o.isVisible()&&/airport|FTE/i.test(await o.innerText())){console.log(`Selecting generic option: ${norm(await o.innerText())}`);await o.click();return;}}catch{}}
 if(!typed)console.log('No blank location input found after opening control.');
 throw new Error('Could not find El Calafate Airport in Hertz Argentina location choices');
}
async function fillInput(locator,value,label){await locator.waitFor({state:'visible'});await locator.fill(value);await locator.press('Tab').catch(()=>{});console.log(`Filled ${label}: ${value}`);}
async function diagnostics(page){console.log('--- HERTZ ARGENTINA DIAGNOSTICS ---');console.log(`URL: ${page.url()}`);const fields=await page.locator('input,select,button,[role="combobox"],[role="textbox"]').evaluateAll(es=>es.slice(0,180).map((e,i)=>({i,tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',placeholder:e.getAttribute('placeholder')||'',text:norm(e.innerText).slice(0,120),value:e.value||'',visible:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)})));for(const f of fields)console.log(JSON.stringify(f));console.log(`BODY: ${norm(await page.locator('body').innerText().catch(()=>'' )).slice(0,3500)}`);}

async function main(){
 console.log('========================================');console.log('HERTZ INVENTORY MONITOR');console.log('========================================');console.log(`${CONFIG.pickupDate} ${CONFIG.pickupTime} -> ${CONFIG.dropoffDate} ${CONFIG.dropoffTime}`);
 const state=loadState();console.log(`Previously known vehicles: ${state.vehicles?.length??0}`);const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});let page=null;
 try{
  const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',viewport:{width:1280,height:1000},locale:'en-US'});page=await context.newPage();page.setDefaultTimeout(15000);
  await page.goto(CONFIG.bookingUrl,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(5000);console.log(`Loaded URL: ${page.url()}`);await choosePlace(page,0);await choosePlace(page,1);
  const inputs=page.locator('input:visible'),dateInputs=[];for(let i=0;i<await inputs.count();i++){const x=inputs.nth(i),ph=await x.getAttribute('placeholder');if(/MM\/DD\/YYYY|Start date|End date/i.test(ph||''))dateInputs.push(x);}if(dateInputs.length<2)throw new Error(`Expected two visible date inputs, found ${dateInputs.length}`);
  await fillInput(dateInputs[0],fmtDate(CONFIG.pickupDate),'pick-up date');await fillInput(dateInputs[1],fmtDate(CONFIG.dropoffDate),'drop-off date');
  const times=page.getByText('hh:mm',{exact:true});if(await times.count()>=2){for(let i=0;i<2;i++){await times.nth(i).click();await page.waitForTimeout(300);const targets=page.getByText(/^(17:00|5:00 PM)$/,{exact:true});let ok=false;for(let j=0;j<await targets.count();j++){const t=targets.nth(j);try{if(await t.isVisible()){await t.click();ok=true;break;}}catch{}}console.log(`Time ${i}: ${ok?'17:00 selected':'17:00 option not exposed'}`);}}else console.log('Time controls not detected; continuing.');
  await page.getByRole('button',{name:'Search',exact:true}).click();console.log('Clicked Search');await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});await page.waitForTimeout(7000);console.log(`Results URL: ${page.url()}`);const body=norm(await page.locator('body').innerText().catch(()=>''));console.log(`Results page sample: ${body.slice(0,2200)}`);
  const vehicles=await page.evaluate(()=>[...document.querySelectorAll('.car-card,.vehicle-card,[class*="vehicle-card" i],[class*="vehicleCard" i],[data-vehicle],[data-vehicletype]')].map((card,i)=>{const text=card.textContent?.replace(/\s+/g,' ').trim()||'',name=card.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]')?.textContent?.trim()||`Vehicle ${i+1}`,price=card.querySelector('[class*="price" i],[class*="rate" i]')?.textContent?.trim()||'',transmission=card.querySelector('[class*="transmission" i],[class*="gear" i]')?.textContent?.trim()||'',id=card.getAttribute('data-vehicle-id')||card.getAttribute('data-vehicleid')||card.getAttribute('data-vehicletype')||`${name}|${transmission}`;return{id,name,price,transmission,text:text.slice(0,700)}}));
  console.log(`Vehicle cards found: ${vehicles.length}`);if(!vehicles.length){await page.screenshot({path:'hertz-debug.png',fullPage:true}).catch(()=>{});if(/no vehicles|no cars|no results|unavailable|sold out|não encontramos|no encontramos/i.test(body)){saveState([]);return;}throw new Error('No vehicle cards found and result page does not clearly report zero inventory.');}
  const current=vehicles.map(v=>`${v.id}|${norm(v.name)}|${norm(v.transmission)}|${norm(v.price)}`).sort(),previous=new Set(state.vehicles||[]);if(!state.initialized){console.log('First successful check: saving baseline without Bark notification.');saveState(current);return;}const added=current.filter(v=>!previous.has(v));console.log(`Current: ${current.length}; added: ${added.length}`);if(added.length)await bark('🚨 Hertz 新增库存',`El Calafate Airport\n2026-09-27 17:00 → 2026-10-04 17:00\n\n${added.slice(0,10).map(v=>`🚗 ${v}`).join('\n')}`);saveState(current);
 }catch(e){console.error(e?.stack||e);if(page){try{await diagnostics(page);await page.screenshot({path:'hertz-debug.png',fullPage:true});}catch(de){console.error(`Diagnostics also failed: ${de?.stack||de}`);}}process.exitCode=1;}finally{await browser.close();}}
main();
