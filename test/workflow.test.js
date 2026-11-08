import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';

const day = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tehran' }).format(new Date());
const later = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const pass = 'test-password-123';
async function fixture(t, seed) {
  const dir = mkdtempSync(join(tmpdir(),'parsian-v2-test-')), dbPath = join(dir,'crm.sqlite');
  if(seed)seed(dbPath);
  let child, base;
  async function stop() { if(!child || child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited; }
  async function start() {
    child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1',DB_PATH:dbPath},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stderr.on('data',s=>err+=s);
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Server startup timed out: '+err)),10000);child.stdout.on('data',s=>{out+=s;const m=out.match(/listening on port (\d+)/);if(m){base='http://127.0.0.1:'+m[1];clearTimeout(timeout);resolve();}});child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited '+code+': '+err));});});
  }
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});await start();
  async function req(path,method='GET',body,cookie='') {
    const res=await fetch(base+'/api/'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  return {req,dir,dbPath,get base(){return base;},restart:async()=>{await stop();await start();}};
}
async function team(f) {
  const setup=await f.req('setup','POST',{name:'مدیر فروش',username:'manager',password:pass});assert.equal(setup.status,200);const manager={...setup.data.user,cookie:setup.cookie};
  const people={manager};
  for(const [key,role] of [['secretary','secretary'],['salesA','sales'],['salesB','sales'],['technical','technical'],['otherTech','technical']]) {
    const made=await f.req('users','POST',{name:key,username:key,role,password:pass},manager.cookie);assert.equal(made.status,200,JSON.stringify(made.data));
    const login=await f.req('login','POST',{username:key,password:pass});assert.equal(login.status,200);people[key]={...made.data.user,cookie:login.cookie};
  }
  return people;
}
const snapshot=async(f,u)=>(await f.req('data','GET',undefined,u.cookie)).data;
async function create(f,u,owner,phone='۰۹۱۲۱۲۳۴۵۶۷') {
  const r=await f.req('customers','POST',{name:'مشتری آزمایشی',phone,registrationNotes:'درخواست تماس',salesId:owner.id},u.cookie);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.customer;
}
const act=(f,u,id,b)=>f.req(`customers/${id}/actions`,'POST',b,u.cookie);
const devices=[{name:'دستگاه اول',tonnage:'۲۵۰ تن',technicalFeatures:'سروو و دو صفحه',quotedPrice:'۵ میلیارد تومان'},{name:'دستگاه دوم',tonnage:'۴۰۰ تن',technicalFeatures:'کنترل دیجیتال',quotedPrice:'۸ میلیارد تومان'}];
async function discover(f,u,id) {
  const task=(await snapshot(f,u)).tasks.find(t=>t.customer_id===id&&t.kind==='discovery'&&t.state==='open');
  const r=await act(f,u,id,{type:'complete',taskId:task.id,result:'success',actualDate:day,nextDate:later,note:'توضیحات واحد تماس اولیه',industry:'پلاستیک',product:'قطعات خودرو',source:'نمایشگاه',readiness:'hot',messengerNumber:'09120000000',messengerType:'واتساپ',address:'تهران',position:'مدیر تولید',devices});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.customer;
}

test('four roles, minimal registration, immutable assignment and server-side authorization',async t=>{
  const f=await fixture(t),p=await team(f);
  assert.equal(p.manager.role,'manager');assert.equal((await f.req('data')).status,401);
  assert.equal((await f.req('setup','POST',{name:'again',username:'again',password:pass})).status,409);
  for(const actor of [p.secretary,p.salesA,p.technical])assert.equal((await f.req('users','POST',{name:'bad',username:'bad',role:'manager',password:pass},actor.cookie)).status,403);
  assert.equal((await f.req('users','POST',{name:'bad',username:'bad',role:'admin',password:pass},p.manager.cookie)).status,400);
  assert.equal((await f.req('customers','POST',{name:'test',phone:'09121111111',salesId:p.salesA.id},p.technical.cookie)).status,403);
  const c=await create(f,p.secretary,p.salesA);
  assert.equal(c.code,'P-00001');assert.equal((await snapshot(f,p.secretary)).customers.length,0);assert.equal((await snapshot(f,p.secretary)).tasks.length,0);
  assert.ok((await snapshot(f,p.secretary)).users.every(u=>u.role==='sales'));
  let s=await snapshot(f,p.salesA);assert.equal(s.customers.length,1);assert.equal(s.customers[0].phone,'09121234567');assert.equal(s.customers[0].technicalId,null);assert.deepEqual(s.customers[0].devices,[]);assert.equal(s.customers[0].firstContact,day);
  assert.equal((await f.req('customers','POST',{name:'duplicate',phone:'09121234567',salesId:p.salesA.id},p.secretary.cookie)).status,409);
  for(const actor of [p.secretary,p.salesB,p.technical,p.otherTech]){
    assert.equal((await f.req(`customers/${c.id}/events`,'GET',undefined,actor.cookie)).status,403);
    assert.equal((await act(f,actor,c.id,{type:'note',note:'forbidden'})).status,403);
  }
  for(const actor of [p.manager,p.salesA]){
    assert.equal((await f.req(`customers/${c.id}`,'PUT',{salesId:p.salesB.id},actor.cookie)).status,409);
    assert.equal((await f.req(`customers/${c.id}`,'PUT',{name:'نام جدید'},actor.cookie)).status,200);
  }
  assert.equal((await snapshot(f,p.manager)).customers[0].salesId,p.salesA.id);
  const other=await create(f,p.salesA,p.salesB,'09121112222');assert.equal((await snapshot(f,p.salesA)).customers.some(c=>c.id===other.id),false);assert.equal((await snapshot(f,p.manager)).customers.length,2);
  assert.equal((await f.req('logout','POST',{},p.secretary.cookie)).status,200);assert.equal((await snapshot(f,p.secretary)).error,'ابتدا وارد حساب خود شوید.');
});

test('discovery stores separate device prices and one note; merged introduction and no-answer retry',async t=>{
  const f=await fixture(t),p=await team(f),c=await create(f,p.secretary,p.salesA);
  let s=await snapshot(f,p.salesA),task=s.tasks[0];
  assert.equal((await act(f,p.salesA,c.id,{type:'complete',taskId:task.id,result:'success',note:'ناقص',nextDate:later})).status,400);
  assert.equal((await snapshot(f,p.salesA)).tasks[0].state,'open');
  assert.equal((await act(f,p.salesA,c.id,{type:'complete',taskId:task.id,result:'noanswer',note:'پاسخ نداد',nextDate:later})).status,200);
  assert.equal((await snapshot(f,p.salesA)).customers[0].followupCount,0);
  const found=await discover(f,p.salesA,c.id);assert.deepEqual(found.devices,devices);assert.equal(found.discoveryNotes,'توضیحات واحد تماس اولیه');assert.equal(found.registrationNotes,'درخواست تماس');assert.equal(found.address,'تهران');
  s=await snapshot(f,p.salesA);assert.equal(s.tasks.filter(t=>t.state==='open').length,3);assert.equal(s.tasks.filter(t=>['catalog','film'].includes(t.kind)).length,0);
  assert.equal(s.tasks.find(t=>t.kind==='introduction').title,'ارسال کاتالوگ و فیلم معرفی کارخانه');
  const expected=new Date(day+'T12:00:00Z');expected.setUTCDate(expected.getUTCDate()+2);assert.equal(s.tasks.find(t=>t.kind==='trust').due,expected.toISOString().slice(0,10));
  for(const kind of ['introduction','trust']){task=s.tasks.find(t=>t.kind===kind);assert.equal((await act(f,p.salesA,c.id,{type:'complete',taskId:task.id,actualDate:day})).status,200);}
  assert.equal((await act(f,p.salesA,c.id,{type:'complete',taskId:task.id})).status,409);
  await f.restart();s=await snapshot(f,p.salesA);assert.deepEqual(s.customers[0].devices,devices);assert.equal(s.customers[0].salesId,p.salesA.id);
  assert.equal((await fetch(f.base+'/missing.woff2')).status,404);assert.equal((await fetch(f.base+'/')).status,200);
});

test('technical ticket is strictly assigned, redacted, returns to the same salesperson and resumes one task',async t=>{
  const f=await fixture(t),p=await team(f),c=await create(f,p.secretary,p.salesA);await discover(f,p.salesA,c.id);
  const before=(await snapshot(f,p.salesA)).tasks.find(t=>t.kind==='followup');
  assert.equal((await act(f,p.salesA,c.id,{type:'technical',technicalId:p.salesB.id,note:'سؤال'})).status,400);
  assert.equal((await act(f,p.salesA,c.id,{type:'technical',technicalId:p.technical.id,note:'بررسی قالب و تناژ'})).status,200);
  assert.equal((await act(f,p.salesA,c.id,{type:'technical',technicalId:p.technical.id,note:'تکراری'})).status,400);
  let s=await snapshot(f,p.technical);assert.equal(s.customers.length,1);assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].kind,'technical');assert.equal(s.customers[0].technicalRequest,'بررسی قالب و تناژ');
  assert.equal('registrationNotes' in s.customers[0],false);assert.equal('discoveryNotes' in s.customers[0],false);assert.equal('quotedPrice' in s.customers[0].devices[0],false);
  assert.equal((await snapshot(f,p.otherTech)).customers.length,0);
  const task=s.tasks[0];for(const type of ['note','close','visit','reschedule'])assert.equal((await act(f,p.technical,c.id,{type,taskId:task.id,note:'ممنوع',nextDate:later})).status,403);
  assert.equal((await act(f,p.otherTech,c.id,{type:'complete',taskId:task.id,note:'ممنوع'})).status,403);
  assert.equal((await act(f,p.salesA,c.id,{type:'complete',taskId:before.id,result:'success',note:'منتظر پاسخ',nextDate:later})).status,409);
  assert.equal((await act(f,p.technical,c.id,{type:'complete',taskId:task.id,note:'مشخصات فنی تأیید شد',actualDate:day})).status,200);
  s=await snapshot(f,p.technical);assert.equal(s.customers.length,0);assert.equal(s.tasks.length,0);
  s=await snapshot(f,p.salesA);assert.equal(s.customers[0].stage,'followup');assert.equal(s.customers[0].salesId,p.salesA.id);assert.equal(s.tasks.find(t=>t.id===before.id).state,'open');assert.equal(s.tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
});

test('manager can complete all sales stages; no nextDate for visit, technical, quote or contract; unique long-term followup',async t=>{
  const f=await fixture(t),p=await team(f),c=await create(f,p.manager,p.salesA);await discover(f,p.manager,c.id);
  for(const kind of ['introduction','trust']){const task=(await snapshot(f,p.manager)).tasks.find(t=>t.kind===kind);assert.equal((await act(f,p.manager,c.id,{type:'complete',taskId:task.id})).status,200);}
  for(let i=1;i<=4;i++){
    const task=(await snapshot(f,p.manager)).tasks.find(t=>t.kind==='followup'&&t.state==='open');
    assert.equal((await act(f,p.manager,c.id,{type:'complete',taskId:task.id,result:'success',note:'پیگیری '+i,actualDate:day,nextDate:later})).status,200);
    assert.equal((await snapshot(f,p.manager)).tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
  }
  let s=await snapshot(f,p.manager);assert.equal(s.customers[0].stage,'longterm');
  const current=s.tasks.find(t=>t.kind==='followup'&&t.state==='open');
  const simultaneous=await Promise.all([1,2].map(()=>act(f,p.manager,c.id,{type:'complete',taskId:current.id,result:'success',note:'پیگیری هم‌زمان',actualDate:day,nextDate:later})));assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
  s=await snapshot(f,p.manager);assert.equal(s.customers[0].followupCount,5);assert.equal(s.tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
  assert.equal((await act(f,p.manager,c.id,{type:'quote',quoteStatus:'sent',quoteNumber:'Q-100',sentDate:day,note:'پیش‌فاکتور'})).status,200);
  assert.equal((await act(f,p.manager,c.id,{type:'quote',quoteStatus:'sent',quoteNumber:'Q-101',sentDate:day,note:'اصلاح پیش‌فاکتور'})).status,200);
  assert.equal((await snapshot(f,p.manager)).tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
  for(const kind of ['visit','contract']){
    assert.equal((await act(f,p.manager,c.id,{type:kind,scheduledDate:later,time:'10:30',note:'جلسه'})).status,200);
    const task=(await snapshot(f,p.manager)).tasks.find(t=>t.kind===kind&&t.state==='open');
    assert.equal((await act(f,p.manager,c.id,{type:'complete',taskId:task.id,meetingResult:'held',actualDate:day,note:'برگزار شد'})).status,200);
    s=await snapshot(f,p.manager);assert.equal(s.tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);assert.equal(s.customers[0].stage,'longterm');
  }
  assert.equal((await act(f,p.manager,c.id,{type:'technical',technicalId:p.technical.id,note:'بررسی نهایی'})).status,200);
  const tech=(await snapshot(f,p.manager)).tasks.find(t=>t.kind==='technical'&&t.state==='open');assert.equal((await act(f,p.technical,c.id,{type:'complete',taskId:tech.id,note:'تأیید'})).status,200);
  s=await snapshot(f,p.manager);assert.equal(s.customers[0].stage,'longterm');assert.equal(s.tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
  const follow=s.tasks.find(t=>t.kind==='followup'&&t.state==='open');
  assert.equal((await act(f,p.manager,c.id,{type:'reschedule',taskId:follow.id,note:'تغییر موعد',nextDate:later})).status,200);
  assert.equal((await act(f,p.manager,c.id,{type:'close',outcome:'won',note:'قرارداد امضا شد'})).status,200);
  s=await snapshot(f,p.manager);assert.equal(s.customers[0].salesId,p.salesA.id);assert.equal(s.tasks.filter(t=>['open','paused'].includes(t.state)).length,0);
  assert.equal((await act(f,p.manager,c.id,{type:'reopen',note:'خرید مجدد',nextDate:later})).status,200);assert.equal((await act(f,p.manager,c.id,{type:'reopen',note:'تکرار',nextDate:later})).status,400);
  assert.equal((await snapshot(f,p.manager)).tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);
});

function legacyDatabase(path) {
  const db=new DatabaseSync(path);db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,username TEXT UNIQUE,password TEXT,role TEXT); CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT,created TEXT,updated TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY,customer_id INTEGER,owner_id INTEGER,kind TEXT,title TEXT,due TEXT,state TEXT DEFAULT 'open',round INTEGER DEFAULT 0,created TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,customer_id INTEGER,user_id INTEGER,type TEXT,note TEXT,created TEXT);`);
  const password='salt:'+scryptSync(pass,'salt',64).toString('hex');
  for(const [id,name,role] of [[1,'manager','admin'],[2,'salesA','sales'],[3,'technical','technical']])db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,name,name,password,role);
  const c={name:'مشتری قدیمی',phone:'09120000000',salesId:2,technicalId:3,stage:'longterm',followupCount:4,firstContact:day,readiness:'hot',generalNotes:'یادداشت قدیمی',tonnage:'۲۵۰'};
  db.prepare('INSERT INTO customers VALUES(?,?,?,?)').run(1,JSON.stringify(c),day,day);
  for(const [id,kind,state] of [[1,'catalog','done'],[2,'film','open'],[3,'followup','open'],[4,'followup','open']])db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run(id,1,2,kind,'کار قبلی',later,state,5,day);
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(1,1,2,'تماس قبلی','تاریخچه محفوظ',day);db.close();
}
test('legacy upgrade backs up data, keeps history and assignment, merges media and repairs duplicate followups once',async t=>{
  const f=await fixture(t,legacyDatabase);
  const login=await f.req('login','POST',{username:'manager',password:pass});assert.equal(login.status,200);assert.equal(login.data.user.role,'manager');
  const actor={cookie:login.cookie};let s=await snapshot(f,actor);const c=s.customers[0];
  assert.equal(c.salesId,2);assert.equal(c.discoveryNotes,'یادداشت قدیمی');assert.equal(c.devices[0].tonnage,'۲۵۰');assert.equal(s.tasks.filter(t=>t.kind==='followup'&&t.state==='open').length,1);assert.equal(s.tasks.filter(t=>t.kind==='introduction'&&t.state==='open').length,1);
  assert.equal((await f.req('customers/1/events','GET',undefined,actor.cookie)).data.events[0].note,'تاریخچه محفوظ');
  const backups=readdirSync(f.dir).filter(n=>n.includes('.before-v2-')&&n.endsWith('.bak'));assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.dir,backups[0]),{readOnly:true});assert.equal(backup.prepare('SELECT role FROM users WHERE id=1').get().role,'admin');assert.equal(backup.prepare("SELECT count(*) AS n FROM tasks WHERE kind='followup' AND state='open'").get().n,2);backup.close();
  const db=new DatabaseSync(f.dbPath);assert.throws(()=>db.prepare('INSERT INTO tasks(customer_id,owner_id,kind,title,due,state,round,created) VALUES(?,?,?,?,?,?,?,?)').run(1,2,'followup','تکراری',later,'open',5,day),/UNIQUE/);db.close();
  await f.restart();assert.equal(readdirSync(f.dir).filter(n=>n.includes('.before-v2-')&&n.endsWith('.bak')).length,1);s=await snapshot(f,actor);assert.equal(s.customers[0].salesId,2);assert.equal(s.tasks.length,4);
});
