// Offline only: supply an installed Playwright module and a loopback static preview URL.
// node test/browser/model-picker-viewport.mjs /path/to/playwright/index.mjs http://127.0.0.1:38745/admin/
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
if (!process.argv[2]) throw new Error('Supply the path to an installed Playwright module.');
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const preview = new URL(process.argv[3] ?? 'http://127.0.0.1:38745/admin/');
if (preview.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(preview.hostname)) throw new Error('Browser QA requires a loopback static-only preview.');
const screenshots = await mkdtemp(join(tmpdir(),'model-picker-viewport-'));
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_QA_CHANNEL ? {channel:process.env.BROWSER_QA_CHANNEL} : {})});
const selection={schemaVersion:2,revision:1,enabledModels:['glm-5-3-flash-low','swe-2-medium'],roles:{default:{modelId:'glm-5-3-flash-low',effort:'low'},swe_worker:{modelId:'swe-2',effort:'medium'}},includeFutureModels:false};
const ids=['glm-5-3-flash-low','swe-2-max','swe-2-high','swe-2-medium',...Array.from({length:520},(_,i)=>`other-synthetic-${i}`)];
const models=ids.map(id=>{const reviewed=selection.enabledModels.includes(id);const effort=id==='glm-5-3-flash-low'?'low':id.split('-').at(-1);return {id,displayName:id,available:true,enabled:reviewed,contextWindow:id.startsWith('glm')?1000000:262000,maxOutputTokens:128000,supportsImages:true,upstreamThinking:true,metadataProvenance:{id:'synthetic'},...(id.startsWith('swe-2-')?{family:{id:'swe-2',displayName:'SWE-2',effort,provenance:'upstream_family_metadata',upstreamDefaultEffort:'high'}}:id.startsWith('glm')?{family:{id:'glm-5-3-flash-1m',displayName:'GLM-5.3 Flash 1M',effort:'low',provenance:'upstream_family_metadata',upstreamDefaultEffort:'max'}}:{}),codex:{status:reviewed?'validated':'unvalidated',exportEligible:reviewed,profile:reviewed?{modelId:id,defaultReasoningEffort:effort,supportedReasoningEfforts:[{effort,description:'Synthetic reviewed effort'}],multiAgentVersion:'v1',shellType:'shell_command'}:null}}});
const cases=[['desktop-900',1280,900],['desktop-800',1280,800],['desktop-768',1280,768],['desktop-110',1164,818],['desktop-125',1024,720],['short-desktop-125',1024,576],['mobile-100',390,844],['mobile-110',355,767],['mobile-125',312,675],['narrow-mobile',320,568]];
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.route('**/admin/api/**',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({status:200,contentType:'application/json',headers:{etag:'"model-selection-v2-1"'},body:JSON.stringify(route.request().url().endsWith('/models')?{source:'remote',selectionRevision:1,models}:selection)})});
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const [name,width,height] of cases){
  await page.setViewportSize({width,height});await page.goto(preview.href);await page.getByRole('heading',{name:'SWE-2',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
  const toggle=page.locator('.configuration-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'),height>850?'true':'false');
  for(const expanded of [true,false]){
   if(await toggle.getAttribute('aria-expanded')!==String(expanded))await toggle.click();
   const metrics=await page.evaluate(()=>{const selectors=['.picker-header','.configuration-toggle','.filters','.bulk-actions','.pagination','.picker-footer'];return {width:innerWidth,height:innerHeight,outerHeight:document.documentElement.scrollHeight,outerWidth:document.documentElement.scrollWidth,listHeight:document.querySelector('.model-list').clientHeight,listScrollHeight:document.querySelector('.model-list').scrollHeight,visible:Object.fromEntries(selectors.map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,r.top>=0&&r.bottom<=innerHeight]}))}});
   console.log(JSON.stringify({name,expanded,...metrics}));
   if(metrics.listHeight<100)console.log(await page.locator('.picker').evaluate(e=>[...e.querySelectorAll('.picker-header,.picker-body,.counts,.intro,.feedback,.edit-controls,.configuration-zone,.configuration-controls,.model-browser,.filters,.bulk-actions,.pagination,.picker-footer')].map(n=>({c:n.className,h:n.getBoundingClientRect().height,flex:getComputedStyle(n).flex}))));
   assert.ok(metrics.outerHeight<=height+1,`${name}: outer-page scrolling`);assert.ok(metrics.outerWidth<=width,`${name}: horizontal overflow`);assert.ok(metrics.listHeight>=(expanded?80:140),`${name}: insufficient list height`);assert.ok(Object.values(metrics.visible).every(Boolean),`${name}: hidden controls/pagination/footer`);assert.ok(metrics.listScrollHeight>metrics.listHeight);
   if(!expanded&&width>640)assert.ok(metrics.listHeight>await page.locator('.picker-body').evaluate(e=>e.clientHeight/2),`${name}: collapsed list must dominate available body height`);
   await page.screenshot({path:join(screenshots,`${name}-${expanded?'expanded':'collapsed'}.png`),fullPage:true});
  }
  assert.equal(await page.locator('.pagination').evaluate(e=>e.getBoundingClientRect().bottom<=document.querySelector('.picker-footer').getBoundingClientRect().top),true,`${name}: pagination overlaps footer`);
  await page.locator('.model-list').evaluate(e=>e.scrollTop=e.scrollHeight);assert.equal(await page.locator('.pagination').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight),true);
  await page.getByRole('button',{name:'Next',exact:true}).click();assert.match(await page.locator('.pagination').innerText(),/Page 2/);
  const summary=page.locator('.categories summary');await summary.click();assert.equal(await page.locator('.categories').evaluate(e=>e.open),true);
  assert.notEqual(await page.locator('.category-chevron').evaluate(e=>getComputedStyle(e).transform),'none');
  await page.locator('.category-menu input').nth(0).check();await page.locator('.category-menu input').nth(1).check();assert.equal(await page.locator('.categories').evaluate(e=>e.open),true);
  await page.getByRole('heading',{name:'Devin models',exact:true}).click();assert.equal(await page.locator('.categories').evaluate(e=>e.open),false);
  await summary.click();await page.keyboard.press('Escape');assert.equal(await page.locator('.categories').evaluate(e=>e.open),false);assert.equal(await summary.evaluate(e=>e===document.activeElement),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await toggle.click();assert.equal(await page.getByLabel('swe_worker thinking',{exact:true}).inputValue(),'medium');
  const worker=page.getByLabel('swe_worker model',{exact:true});await worker.selectOption('glm-5-3-flash-low');
  await toggle.click();assert.match(await toggle.innerText(),/Worker: GLM-5.3 Flash 1M \/ low/);
  await toggle.click();assert.equal(await worker.inputValue(),'glm-5-3-flash-low');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await toggle.click();
  assert.deepEqual(await page.locator('.model-family[aria-label="SWE-2 variants"] .model-row').evaluateAll(rows=>rows.map(e=>e.dataset.modelId)),['swe-2-medium','swe-2-high','swe-2-max']);
  await page.locator('.model-list').evaluate(e=>e.scrollTop=0);
  await page.screenshot({path:join(screenshots,`${name}.png`),fullPage:true});
 }
 assert.deepEqual(errors,[]);console.log('VIEWPORT_AND_INTERACTION_QA_PASS');console.log(`Screenshots: ${screenshots}`);
}finally{await browser.close()}
