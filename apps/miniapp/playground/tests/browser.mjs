import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
await mkdir('previews',{recursive:true});
try{
 await testInlineAnalysis(browser,errors);
 assert.deepEqual(errors,[]);
}finally{await browser.close()}
async function testInlineAnalysis(browser,errors){
 const context=await browser.newContext({viewport:{width:1440,height:1100},hasTouch:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 async function openChoices(){
  const reading=await page.getByLabel('体验场景').inputValue()==='4';
  assert.equal(await page.locator('.choice-entry,.choice-popover').count(),0);
  assert.equal(await page.locator('.answer-sheet').count(),reading?1:0);
  if(reading){
   const launcher=page.getByRole('button',{name:'打开选项卡，已答 0/3',exact:true});
   await launcher.waitFor();
   assert.equal(await page.locator('.answer-sheet:visible').count(),0);
   assert.equal(await page.getByRole('button',{name:'展开或收起选项'}).count(),0);
   const circle=await launcher.boundingBox();
   assert.equal(circle.width,circle.height);
   assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'0');
   await page.locator('.content-scroll').evaluate(el=>el.scrollTop=50);
   const scroll=await page.locator('.content-scroll').evaluate(el=>el.scrollTop);
   await launcher.click();
   assert.equal(await page.locator('.reading-launcher').count(),0);
   const sheet=page.locator('.answer-sheet');assert(await sheet.isVisible());
   assert.equal(await page.locator('.reading-question-nav').count(),0);
   const initialHeight=(await sheet.boundingBox()).height;
   const workspaceHeight=(await page.locator('.workspace').boundingBox()).height;
   assert(Math.abs(initialHeight-workspaceHeight*.65)<2);
   const handle=page.getByRole('button',{name:'调整选项浮层高度'});
   const grip=await handle.boundingBox();
   await page.mouse.move(grip.x+grip.width/2,grip.y+24);await page.mouse.down();
   await page.mouse.move(grip.x+grip.width/2,grip.y-36,{steps:8});await page.mouse.up();
   assert(Math.abs((await sheet.boundingBox()).height-initialHeight-60)<2,'drag changes height without triggering tap');
   const raisedGrip=await handle.boundingBox();
   await page.mouse.move(raisedGrip.x+48,raisedGrip.y+24);await page.mouse.down();
   await page.mouse.move(raisedGrip.x+48,raisedGrip.y+84,{steps:8});await page.mouse.up();
   assert(Math.abs((await sheet.boundingBox()).height-initialHeight)<2,'drag down restores height');
   await page.locator('.answer-content').evaluate(el=>el.scrollTop=100);
   assert.equal((await sheet.boundingBox()).height,initialHeight,'content scrolling preserves panel height');
   await page.locator('.answer-content').evaluate(el=>el.scrollTop=0);
   const close=page.getByRole('button',{name:'关闭选项卡',exact:true});
   const closeBox=await close.boundingBox(),sheetBox=await sheet.boundingBox();
   assert(closeBox.x>sheetBox.x+sheetBox.width*.7&&closeBox.y<sheetBox.y+45);
   await close.click();
   assert.equal(await page.locator('.content-scroll').evaluate(el=>el.scrollTop),scroll);
   await launcher.click();
  }else{
   const stem=await page.locator('.content-scroll .module-stem').boundingBox();
   const response=await page.locator('.content-scroll .module-response').boundingBox();
   assert(response.y>=stem.y+stem.height,'options follow the stem in normal flow');
   const region=page.locator('.content-scroll');
   await region.evaluate(el=>el.scrollTop=el.scrollHeight);
   await page.locator('.content-scroll .option').last().scrollIntoViewIfNeeded();
   assert.equal(await page.locator('.content-scroll .option').count(),4);
  }
 }
 await page.goto('http://127.0.0.1:5186/#b');
 assert.equal(await page.locator('.studio.theme-a').count(),1);
 assert.equal(await page.locator('.versions,.notes,.intro,.eyebrow,.preview-caption').count(),0);
 assert.equal(await page.getByRole('heading',{name:'界面配置'}).count(),1);
 assert.equal(await page.getByRole('button',{name:'反转解析位置'}).count(),0);
 await page.getByRole('button',{name:'切换布局模式'}).click();
 assert(!(await page.getByRole('slider').isDisabled()));
 await page.getByRole('button',{name:'切换布局模式'}).click();
 await page.screenshot({path:'previews/a-editor.png'});
 await page.getByRole('button',{name:'预览答题界面'}).click();
 assert.equal(await page.locator('.rail-group').count(),0);
 assert.equal(await page.getByRole('button',{name:'查看解析',exact:true}).count(),0);
 for(const size of ['standard','small','large']){
  await page.getByLabel('屏幕尺寸').selectOption(size);
  await page.locator('.font-buttons button').filter({hasText:size==='standard'?'18':'24'}).click();
  for(const scene of ['0','1','2','3','4']){
   await page.getByLabel('体验场景').selectOption(scene);
   assert.equal(await page.locator('.analysis-handle').count(),0);
   assert.equal(await page.locator('.inline-explanation:visible').count(),0);
   await openChoices();
   if(scene==='3'){
    const confirm=page.getByRole('button',{name:'确认答案',exact:true});
    assert(await confirm.isDisabled());
    assert.equal(await page.locator('.options .confirm').count(),0);
    assert.equal(await page.locator('.app-footer').getByRole('button',{name:'确认答案',exact:true}).count(),1);
   }
   const bounds=()=>page.locator('.pinned-meta,.pinned-tools,.app-footer').evaluateAll(els=>els.map(el=>({y:el.getBoundingClientRect().y,height:el.getBoundingClientRect().height})));
   const before=await bounds();
   const container=page.locator(scene==='4'?'.answer-sheet':'.content-scroll');
   await container.locator('.option').nth(scene==='0'?0:1).click();
   if(scene==='3'){
    assert.equal(await page.locator('.inline-explanation:visible').count(),0);
    await page.getByRole('button',{name:'确认答案',exact:true}).click();
    assert.equal(await page.getByLabel('体验场景').inputValue(),'3');
    assert.equal(await page.locator('.app-footer').getByRole('button',{name:'下一题',exact:true}).count(),1);
   }
   const explanation=container.getByRole('region',{name:'试题详解'});
   await explanation.waitFor();
   assert.equal(await page.locator('.phone .option:visible').count(),4);
   assert.equal(await page.getByRole('button',{name:/^(查看解析|收起解析)$/}).count(),0);
   const last=await container.locator('.option').last().boundingBox();
   const detail=await explanation.boundingBox();
   assert(detail.y>=last.y+last.height,'explanation follows the options');
   assert.match(await explanation.innerText(),/正确答案/);
   if(scene==='0'){
    assert.equal(await explanation.locator('.answer-correct').innerText(),'B');
    assert.equal(await explanation.locator('.answer-wrong').innerText(),'A');
   }
   await explanation.locator('p').scrollIntoViewIfNeeded();
   assert.deepEqual(await bounds(),before,'meta, toolbar and navigation stay fixed');
   assert.equal(await page.locator('.content-scroll .module-stem:visible').count(),1);
   assert.equal(await page.locator('.phone').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);

  }
 }
 await page.getByRole('button',{name:'关闭选项卡',exact:true}).click();
 assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'1');
 for(const [index,answer] of [[1,2],[2,1]]){
  await page.getByRole('button',{name:`打开选项卡，已答 ${index}/3`,exact:true}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.locator('.answer-sheet .option').nth(answer).click();
  await page.getByRole('button',{name:'关闭选项卡',exact:true}).click();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),String(index+1));
 }
 await page.screenshot({path:'previews/a-reading-progress.png'});
 await page.getByRole('button',{name:'打开选项卡，已答 3/3',exact:true}).click();
 await page.getByRole('button',{name:'上一题',exact:true}).click();
 assert.equal(await page.locator('.answer-sheet .option.chosen').innerText().then(t=>t.startsWith('C')),true);
 await page.getByLabel('反馈方式').selectOption('AFTER_FINISH');
 for(const scene of ['0','1','2','3','4']){
  await page.getByLabel('体验场景').selectOption(scene);
  await openChoices();
   await page.locator('.phone .option:visible').nth(1).click();
  if(scene==='3')await page.getByRole('button',{name:'确认答案',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'查看解析',exact:true}).count(),0);
  assert.equal(await page.locator('.inline-explanation,.analysis-handle').count(),0);
  assert.equal(await page.locator('.phone .option.correct:visible,.phone .option.wrong:visible').count(),0);
 }
 await page.getByLabel('反馈方式').selectOption('IMMEDIATE');
 await page.getByLabel('屏幕尺寸').selectOption('standard');
 await page.locator('.font-buttons button').filter({hasText:'18'}).click();
 await page.getByLabel('体验场景').selectOption('0');
 await openChoices();
   await page.locator('.phone .option:visible').nth(1).click();
 await page.getByRole('region',{name:'试题详解'}).waitFor();
 await page.locator('.content-scroll').evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:'previews/a-practice.png'});
 await page.getByRole('button',{name:'下一题',exact:true}).click();
 assert.equal(await page.locator('.inline-explanation').count(),0);
 assert.equal(await page.getByRole('button',{name:'查看解析',exact:true}).count(),0);
 await page.getByLabel('体验场景').selectOption('1');
 await page.locator('.content-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);
 await page.screenshot({path:'previews/a-long-question.png'});
 await page.getByLabel('体验场景').selectOption('4');
 await page.getByRole('button',{name:'打开选项卡，已答 0/3',exact:true}).click();
 await page.locator('.answer-sheet .option').nth(1).click();
 await page.locator('.answer-content').evaluate(el=>el.scrollTop=250);
 await page.screenshot({path:'previews/a-reading-panel.png'});
 await context.close();
 console.log('a: inline explanation, disclosure gating, stable chrome, reading progress, 15 layout scenarios, 5 deferred-feedback scenarios passed');
}
