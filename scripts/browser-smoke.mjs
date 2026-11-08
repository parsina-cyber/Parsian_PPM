import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=mkdtempSync(join(tmpdir(),'parsian-browser-v2-'));
const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1',DB_PATH:join(dir,'browser.sqlite')},stdio:['ignore','pipe','pipe']});
let browser;
try{
  let out='',stderr='';server.stderr.on('data',d=>stderr+=d);
  const base=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Startup timeout: '+stderr)),10000);server.stdout.on('data',d=>{out+=d;const m=out.match(/port (\d+)/);if(m){clearTimeout(timeout);resolve('http://127.0.0.1:'+m[1]);}});server.once('error',e=>{clearTimeout(timeout);reject(e);});server.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exit '+code+': '+stderr));});});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const post=async(path,b)=>{const r=await context.request.post(base+'/api/'+path,{data:b});assert.equal(r.status(),200,await r.text());return r.json();};
  const state=async()=>(await context.request.get(base+'/api/data')).json();
  const screenshotDir=process.env.CRM_SCREENSHOT_DIR;if(screenshotDir)mkdirSync(screenshotDir,{recursive:true});
  const shot=async name=>{if(screenshotDir){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(screenshotDir,name+'.png'),fullPage:true});}};
  const pass='browser-test-password';
  await page.goto(base);await page.locator('#auth-form [name=name]').fill('مدیر فروش');await page.locator('[name=username]').fill('manager');await page.locator('[name=password]').fill(pass);await page.locator('#auth-form .primary').click();await page.locator('.page-heading h1').waitFor();
  await page.getByRole('button',{name:'اعضای تیم',exact:true}).click();await page.getByRole('button',{name:'افزودن همکار'}).click();
  assert.deepEqual(await page.locator('#user-form [name=role] option').evaluateAll(els=>els.map(e=>e.value)),['secretary','sales','manager','technical']);
  await page.locator('#user-form [name=name]').fill('منشی تیم');await page.locator('#user-form [name=username]').fill('secretary');await page.locator('#user-form [name=password]').fill(pass);await page.locator('#user-form [name=role]').selectOption('secretary');await page.locator('#user-form [type=submit]').click();await page.locator('#modal').waitFor({state:'hidden'});
  const sales=(await post('users',{name:'سارا احمدی',username:'sales',password:pass,role:'sales'})).user;
  const second=(await post('users',{name:'فروش دوم',username:'second',password:pass,role:'sales'})).user;
  const tech=(await post('users',{name:'علی رضایی',username:'technical',password:pass,role:'technical'})).user;
  async function signIn(username){await post('logout',{});await page.goto(base);await page.locator('#auth-form [name=username]').fill(username);await page.locator('#auth-form [name=password]').fill(pass);await page.locator('#auth-form .primary').click();await page.locator('nav').waitFor();}
  await signIn('secretary');
  assert.equal(await page.locator('nav button').count(),1);assert.equal(await page.locator('nav button').innerText(),'ثبت مشتری جدید');
  assert.deepEqual(await page.locator('#customer-form [name]').evaluateAll(els=>els.map(e=>e.name)),['name','phone','salesId','registrationNotes']);
  await page.locator('#customer-form [name=name]').fill('محمد کریمی');await page.locator('#customer-form [name=phone]').fill('۰۹۱۲۱۲۳۴۵۶۷');await page.locator('#customer-form [name=salesId]').selectOption(String(sales.id));await page.locator('[name=registrationNotes]').fill('درخواست مشاوره برای خرید دستگاه');await shot('secretary');await page.locator('#customer-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('P-00001'));
  assert.equal(await page.locator('#modal').isVisible(),false);assert.equal((await state()).customers.length,0);
  await signIn('sales');await page.locator('.customer-link').first().click();await page.locator('.customer-profile h2').waitFor();
  await page.getByRole('button',{name:'ویرایش ثبت اولیه'}).click();assert.equal(await page.locator('#customer-form select[name=salesId]').count(),0);assert.equal(await page.locator('#customer-form input[readonly]').inputValue(),'سارا احمدی');await page.getByRole('button',{name:'بستن',exact:true}).click();
  await page.locator('.customer-link').first().click();await page.locator('.customer-profile h2').waitFor();await page.locator('#modal .task-check').first().click();
  assert.equal(await page.locator('#action-form textarea').count(),1);
  for(const field of ['messengerNumber','address','position'])assert.equal(await page.locator(`#action-form [name=${field}]`).count(),1);
  await page.locator('[name=result]').selectOption('noanswer');assert.equal(await page.locator('#discovery-fields').evaluate(el=>el.disabled),true);assert.equal(await page.locator('[name=industry]').isDisabled(),true);await page.locator('[name=result]').selectOption('success');
  await page.locator('[name=industry]').fill('صنایع پلاستیک');await page.locator('[name=product]').fill('قطعات خودرو');await page.locator('[name=source]').fill('نمایشگاه صنعت');await page.locator('[name=messengerNumber]').fill('09120000000');await page.locator('[name=address]').fill('تهران');await page.locator('[name=position]').fill('مدیر تولید');
  await page.getByRole('button',{name:'افزودن دستگاه'}).click();assert.equal(await page.locator('.device-row').count(),2);
  for(let i=0;i<2;i++){const row=page.locator('.device-row').nth(i);await row.locator('[name=deviceName]').fill(i?'دستگاه دوم':'دستگاه اول');await row.locator('[name=deviceTonnage]').fill(i?'۴۰۰':'۲۵۰');await row.locator('[name=deviceFeatures]').fill(i?'کنترل دیجیتال':'سروو');await row.locator('[name=devicePrice]').fill(i?'۸ میلیارد تومان':'۵ میلیارد تومان');}
  await page.locator('[name=note]').fill('توضیحات واحد نیازسنجی');await page.locator('[name=readiness]').selectOption('hot');
  await page.locator('[name=nextDate]').locator('..').getByRole('button').click();await page.locator('#calendar').waitFor();await page.locator('#calendar [data-action=cal-pick]').last().click();
  await shot('discovery-devices');await page.locator('#action-form [type=submit]').click();await page.locator('.customer-profile h2').waitFor();
  assert.equal(await page.locator('.device-summary').count(),2);let data=await state();assert.equal(data.customers[0].devices[1].quotedPrice,'۸ میلیارد تومان');assert.equal(data.tasks.filter(t=>t.state==='open'&&t.kind==='introduction').length,1);
  const id=data.customers[0].id;
  for(const type of ['visit','quote','contract']){await page.locator(`[data-action=action-form][data-type=${type}]`).click();assert.equal(await page.locator('#action-form [name=nextDate]').count(),0);await page.getByRole('button',{name:'بستن',exact:true}).click();await page.locator('.customer-link').first().click();await page.locator('.customer-profile h2').waitFor();}
  await page.locator('[data-action=action-form][data-type=technical]').click();assert.equal(await page.locator('#action-form [name=nextDate]').count(),0);await page.locator('[name=technicalId]').selectOption(String(tech.id));await page.locator('[name=note]').fill('بررسی قالب و تناژ مناسب');await page.locator('#action-form [type=submit]').click();await page.locator('.customer-profile h2').waitFor();await page.getByRole('button',{name:'بستن',exact:true}).click();
  await signIn('technical');assert.equal(await page.locator('nav button').count(),1);await page.locator('.task-check').first().click();assert.equal(await page.locator('#action-form [name=nextDate]').count(),0);assert.equal(await page.locator('#action-form textarea').count(),1);assert.equal(await page.locator('#modal').innerText().then(t=>t.includes('۵ میلیارد')),false);await page.locator('[name=note]').fill('مشخصات فنی تأیید شد');await shot('technical-ticket');await page.locator('#action-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('پرونده به کارشناس فروش برگشت'));assert.equal(await page.locator('.task-row').count(),0);
  await signIn('second');assert.equal((await state()).customers.length,0);assert.equal(await page.locator('.customer-link').count(),0);
  await signIn('manager');assert.equal((await state()).customers.length,1);await page.locator('.customer-link').first().click();await page.locator('.customer-profile h2').waitFor();assert.ok((await page.locator('.detail-aside').innerText()).includes('سارا احمدی'));await page.getByRole('button',{name:'بستن',exact:true}).click();
  await page.getByRole('button',{name:'مشتریان',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'خروجی CSV'}).click();await download;
  await shot('manager-dashboard');await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'مشتری جدید'}).click();assert.deepEqual(await page.locator('#customer-form [name]').evaluateAll(els=>els.map(e=>e.name)),['name','phone','salesId','registrationNotes']);await shot('mobile-registration');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);console.log('PASS: all four role interfaces, four-field registration, immutable ownership, two device prices, single discovery note, merged content, technical handoff, no next-action fields, Jalali calendar, CSV and mobile.');
}finally{
  await browser?.close();if(server.exitCode===null){const done=new Promise(resolve=>server.once('exit',resolve));server.kill();await done;}rmSync(dir,{recursive:true,force:true});
}
