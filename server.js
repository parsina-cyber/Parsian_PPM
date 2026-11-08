import http from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflow, ROLES, fail, text } from './domain.js';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(root, 'data', 'crm.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), owner_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, due TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', round INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL);`);
// Preserve the pre-upgrade database on existing installations before migrating business data.
if (db.prepare('PRAGMA user_version').get().user_version < 2 && db.prepare('SELECT count(*) AS n FROM users').get().n) {
  const backupPath = dbPath + '.before-v2-' + Date.now() + '.bak';
  await backup(db, backupPath); chmodSync(backupPath, 0o600);
}
const workflow = createWorkflow(db);
const safeUser = u => ({ id:u.id, name:u.name, username:u.username, role:u.role });
function hash(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function verify(password, stored) { const [salt, value] = stored.split(':'); return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(hash(password, salt).split(':')[1], 'hex')); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 100000) fail('حجم درخواست بیش از حد مجاز است.', 413); }
  try { const data = JSON.parse(raw || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) fail('درخواست نامعتبر است.'); return data; } catch { fail('درخواست نامعتبر است.'); }
}
const attempts = new Map();
function rateLimit(req) {
  const key = req.socket.remoteAddress, record = attempts.get(key);
  if (record && record.until > Date.now() && record.count >= 15) fail('تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کنید.', 429);
  if (!record || record.until < Date.now()) attempts.set(key, { count:1, until:Date.now()+900000 }); else record.count++;
}
function session(req) { const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; return token && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token, Date.now()); }
function login(res, user) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, user.id, Date.now()+7*86400000);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  return { user:safeUser(user) };
}
function createUser(b) {
  const name=text(b.name,100), username=text(b.username,100), role=b.role;
  if (!name || !/^[a-zA-Z0-9_.-]{3,50}$/.test(username) || typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128 || !ROLES.includes(role)) fail('نام، نام کاربری انگلیسی، رمز حداقل ۸ حرف و نقش معتبر لازم است.');
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail('این نام کاربری قبلاً ثبت شده است.',409);
  const id=Number(db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run(name,username,hash(b.password),role).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
async function api(req,res,path) {
  const method=req.method;
  if (!['GET','HEAD'].includes(method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('مبدأ درخواست معتبر نیست.',403);
  if (path==='/api/session' && method==='GET') { const u=session(req); return {version:'2.0.0',user:u?safeUser(u):null,needsSetup:!db.prepare('SELECT id FROM users LIMIT 1').get()}; }
  if (path==='/api/setup' && method==='POST') {
    const b=await body(req); rateLimit(req);
    return workflow.transaction(()=>{if(workflow.users().length)fail('راه‌اندازی اولیه قبلاً انجام شده است.',409);return login(res,createUser({...b,role:'manager'}));});
  }
  if (path==='/api/login' && method==='POST') {
    rateLimit(req); const b=await body(req); const u=db.prepare('SELECT * FROM users WHERE username=?').get(text(b.username));
    if(!u || typeof b.password!=='string' || !verify(b.password,u.password))fail('نام کاربری یا رمز عبور نادرست است.',401);
    return login(res,u);
  }
  const user=session(req);if(!user)fail('ابتدا وارد حساب خود شوید.',401);
  if(path==='/api/logout' && method==='POST') {
    const token=/session=([a-f0-9]{64})/.exec(req.headers.cookie||'')?.[1];db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return {ok:true};
  }
  if(path==='/api/data' && method==='GET')return workflow.dataFor(safeUser(user));
  if(path==='/api/users' && method==='POST') {if(user.role!=='manager')fail('فقط مدیر فروش می‌تواند عضو اضافه کند.',403);return {user:safeUser(createUser(await body(req)))};}
  if(path==='/api/customers' && method==='POST')return workflow.createCustomer(user,await body(req));
  const match=/^\/api\/customers\/(\d+)(?:\/(events|actions))?$/.exec(path);
  if(match){
    const id=Number(match[1]);
    if(method==='GET' && match[2]==='events'){
      const c=workflow.customer(id);workflow.access(user,c);if(user.role==='technical')fail('دسترسی فنی فقط از طریق تیکت فعال است.',403);
      return {events:db.prepare('SELECT e.*,u.name AS author FROM events e JOIN users u ON u.id=e.user_id WHERE customer_id=? ORDER BY e.id DESC').all(id)};
    }
    if(method==='PUT' && !match[2])return workflow.editCustomer(user,id,await body(req));
    if(method==='POST' && match[2]==='actions')return workflow.perform(user,id,await body(req));
  }
  fail('مسیر پیدا نشد.',404);
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path.startsWith('/api/')){res.setHeader('Cache-Control','no-store');const data=await api(req,res,path);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
    else{if(!['GET','HEAD'].includes(req.method))fail('روش مجاز نیست.',405);const file=path==='/'?'index.html':path.slice(1);if(!['index.html','style.css','app.js','mark.svg','font.woff2','FONT-LICENSE.txt'].includes(file))fail('پیدا نشد.',404);const content=readFileSync(join(root,'public',file));res.writeHead(200,{'Content-Type':mime[extname(file)]});res.end(req.method==='HEAD'?undefined:content);}
  }catch(e){if(!e.status)console.error(e);res.writeHead(e.status||500,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:e.status?e.message:'خطای داخلی سرور؛ دوباره تلاش کنید.'}));}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`Parsian CRM listening on port ${server.address().port}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
