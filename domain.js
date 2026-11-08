export const ROLES = ['secretary', 'sales', 'manager', 'technical'];
export const INTRO_TITLE = 'ارسال کاتالوگ و فیلم معرفی کارخانه';
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
export const now = () => new Date().toISOString();
export const text = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export function date(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '') || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail('تاریخ معتبر وارد کنید.');
  return v;
}
const plus = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const phone = value => text(value).replace(/[۰-۹٠-٩]/g, n => '۰۱۲۳۴۵۶۷۸۹'.includes(n) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(n) : '٠١٢٣٤٥٦٧٨٩'.indexOf(n)).replace(/[\s()-]/g, '');

export function createWorkflow(db) {
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const users = () => db.prepare('SELECT id,name,username,role FROM users ORDER BY id').all();
  function customer(id) {
    const row = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    if (!row) fail('مشتری پیدا نشد.', 404);
    return { ...JSON.parse(row.data), id: row.id, code: `P-${String(row.id).padStart(5, '0')}`, created: row.created, updated: row.updated };
  }
  function save(c) {
    const { id, code, created, updated, ...data } = c;
    db.prepare('UPDATE customers SET data=?,updated=? WHERE id=?').run(JSON.stringify(data), now(), id);
  }
  function event(id, uid, type, note = '') { db.prepare('INSERT INTO events(customer_id,user_id,type,note,created) VALUES(?,?,?,?,?)').run(id, uid, type, text(note, 10000), now()); }
  const activeTask = (id, kind) => db.prepare("SELECT * FROM tasks WHERE customer_id=? AND kind=? AND state IN ('open','paused') ORDER BY due,id LIMIT 1").get(id, kind);
  function task(id, owner, kind, title, due, round = 0) {
    date(due);
    // All automatic returns reuse an existing sales follow-up, including a paused one.
    if (kind === 'followup') { const existing = activeTask(id, kind); if (existing) return existing.id; }
    return Number(db.prepare('INSERT INTO tasks(customer_id,owner_id,kind,title,due,round,created) VALUES(?,?,?,?,?,?,?)').run(id, owner, kind, title, due, round, now()).lastInsertRowid);
  }
  function ensureSalesWork(c, due = today()) {
    const current = db.prepare("SELECT id FROM tasks WHERE customer_id=? AND kind IN ('discovery','followup','visit','contract') AND state IN ('open','paused') LIMIT 1").get(c.id);
    if (!current) task(c.id, c.salesId, 'followup', c.followupCount >= 4 ? 'پیگیری بلندمدت' : `تماس پیگیری ${c.followupCount + 1} از ۴`, due, c.followupCount + 1);
  }
  function canAccess(u, c) {
    if (u.role === 'manager') return true;
    if (u.role === 'sales') return c.salesId === u.id;
    if (u.role === 'technical') return c.stage === 'technical' && Boolean(db.prepare("SELECT id FROM tasks WHERE customer_id=? AND owner_id=? AND kind='technical' AND state='open'").get(c.id, u.id));
    return false;
  }
  function access(u, c) { if (!canAccess(u, c)) fail('به این پرونده دسترسی ندارید.', 403); }
  function salesAccess(u, c) { if (!(u.role === 'manager' || u.role === 'sales' && u.id === c.salesId)) fail('این اقدام با کارشناس فروش مسئول یا مدیر فروش است.', 403); }
  function publicCustomer(u, c) {
    if (u.role !== 'technical') return c;
    const { id, code, name, phone, messengerNumber, messengerType, address, position, industry, product, salesId, technicalId, stage, technicalRequest } = c;
    return { id, code, name, phone, messengerNumber, messengerType, address, position, industry, product, salesId, technicalId, stage, technicalRequest,
      devices: (c.devices || []).map(({ name, tonnage, technicalFeatures }) => ({ name, tonnage, technicalFeatures })) };
  }
  function dataFor(u) {
    const customers = db.prepare('SELECT id FROM customers ORDER BY id DESC').all().map(r => customer(r.id)).filter(c => canAccess(u, c));
    const ids = new Set(customers.map(c => c.id));
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY due,id').all().filter(t => ids.has(t.customer_id) && (u.role !== 'technical' || t.kind === 'technical' && t.owner_id === u.id && t.state === 'open'));
    const directory = users().filter(member => u.role === 'secretary' ? member.role === 'sales' : u.role === 'technical' ? member.id === u.id || customers.some(c => c.salesId === member.id) : true);
    return { user: u, users: directory, customers: customers.map(c => publicCustomer(u, c)), tasks, today: today() };
  }
  function registration(b, old = {}) {
    const c = { ...old, name: text(b.name ?? old.name, 150), phone: phone(b.phone ?? old.phone), registrationNotes: text(b.registrationNotes ?? old.registrationNotes, 10000) };
    if (!c.name || !/^\+?\d{7,15}$/.test(c.phone)) fail('نام و شماره تماس معتبر الزامی است.');
    if (old.id) {
      if (b.salesId !== undefined && Number(b.salesId) !== old.salesId) fail('کارشناس فروش مشتری پس از ثبت قابل تغییر نیست.', 409);
    } else {
      c.salesId = Number(b.salesId);
      if (!users().some(u => u.id === c.salesId && u.role === 'sales')) fail('یک کارشناس فروش انتخاب کنید.');
    }
    if (db.prepare('SELECT id,data FROM customers').all().some(r => r.id !== old.id && phone(JSON.parse(r.data).phone) === c.phone)) fail('این شماره تماس قبلاً ثبت شده است.', 409);
    return c;
  }
  function createCustomer(u, b) {
    if (!['secretary','sales','manager'].includes(u.role)) fail('اجازه ثبت مشتری ندارید.', 403);
    return transaction(() => {
      const c = { ...registration(b), firstContact: today(), stage: 'new', followupCount: 0, readiness: 'cold', technicalId: null, devices: [] };
      const id = Number(db.prepare('INSERT INTO customers(data,created,updated) VALUES(?,?,?)').run(JSON.stringify(c), now(), now()).lastInsertRowid);
      event(id, u.id, 'ثبت مشتری', `پرونده ایجاد شد؛ مسئول فروش: ${users().find(member => member.id === c.salesId).name}\n${c.registrationNotes}`);
      task(id, c.salesId, 'discovery', 'تماس اولیه و نیازسنجی', c.firstContact);
      const created = customer(id);
      return { customer: canAccess(u, created) ? created : { id, code: created.code, name: created.name, salesId: created.salesId } };
    });
  }
  function editCustomer(u, id, b) {
    return transaction(() => { const c = customer(id); salesAccess(u, c); const next = registration(b, c); save(next); event(id, u.id, 'ویرایش اطلاعات', 'اطلاعات ثبت اولیه به‌روز شد؛ مسئول فروش ثابت ماند.'); return { customer: customer(id) }; });
  }
  function discovery(c, b) {
    for (const key of ['messengerNumber','messengerType','address','position','industry','product','source','purchaseDate','readiness']) if (b[key] !== undefined) c[key] = text(b[key]);
    if (!c.industry || !c.product || !c.source || !['cold','warm','hot'].includes(c.readiness)) fail('اطلاعات نیازسنجی را کامل کنید.');
    if (c.purchaseDate) date(c.purchaseDate);
    if (!Array.isArray(b.devices) || !b.devices.length || b.devices.length > 30) fail('بین یک تا ۳۰ دستگاه ثبت کنید.');
    c.devices = b.devices.map(device => {
      if (!device || typeof device !== 'object' || Array.isArray(device)) fail('اطلاعات دستگاه نامعتبر است.');
      const row = Object.fromEntries(['name','tonnage','technicalFeatures','quotedPrice'].map(k => [k, text(device[k])]));
      if (!row.name || !row.tonnage || !row.technicalFeatures || !row.quotedPrice) fail('نام، تناژ، ویژگی فنی و قیمت اعلامی هر دستگاه را کامل کنید.');
      return row;
    });
    c.discoveryNotes = text(b.note, 10000);
  }
  function perform(u, id, b) {
    return transaction(() => {
      const c = customer(id); access(u, c);
      const type = b.type, note = text(b.note, 10000);
      const t = b.taskId ? db.prepare("SELECT * FROM tasks WHERE id=? AND customer_id=? AND state='open'").get(Number(b.taskId), id) : null;
      if (b.taskId && !t) fail('این کار قبلاً انجام شده یا باز نیست.', 409);
      if (u.role === 'technical') {
        if (type !== 'complete' || t?.kind !== 'technical' || t.owner_id !== u.id) fail('فقط اجازه پاسخ‌دادن به تیکت فنی تخصیص‌یافته را دارید.', 403);
      } else salesAccess(u, c);
      if (t && t.owner_id !== u.id && u.role !== 'manager') fail('این کار به شما تخصیص نیافته است.', 403);
      if (['won','lost'].includes(c.stage) && !['note','reopen'].includes(type)) fail('پرونده بسته است؛ ابتدا آن را بازگشایی کنید.');
      if (c.stage === 'technical' && u.role !== 'technical' && !(type === 'complete' && t?.kind === 'technical') && !['note','close'].includes(type)) fail('پرونده در انتظار پاسخ فنی است.');
      const due = () => date(b.nextDate);
      const scheduledDate = () => date(b.scheduledDate);
      if (type === 'note') { if (!note) fail('توضیحات را وارد کنید.'); event(id, u.id, 'یادداشت', note); }
      else if (type === 'reschedule') {
        if (!t || !note) fail('کار و علت تغییر موعد لازم است.');
        db.prepare('UPDATE tasks SET due=? WHERE id=?').run(due(), t.id); event(id, u.id, 'تغییر موعد', `${t.title} ← ${b.nextDate}\n${note}`);
      } else if (type === 'technical') {
        if (activeTask(id, 'technical')) fail('یک درخواست فنی باز وجود دارد.');
        const techId = Number(b.technicalId);
        if (!users().some(member => member.id === techId && member.role === 'technical')) fail('کارشناس فنی را انتخاب کنید.');
        if (!note) fail('موضوع مشاوره را بنویسید.');
        c.technicalId = techId; c.technicalRequest = note; c.technicalReturnStage = c.stage; c.stage = 'technical';
        db.prepare("UPDATE tasks SET state='paused' WHERE customer_id=? AND state='open' AND kind!='technical'").run(id);
        task(id, techId, 'technical', 'مشاوره تخصصی فنی', today()); event(id, u.id, 'درخواست مشاوره فنی', note);
      } else if (type === 'close') {
        if (!note || !['won','lost'].includes(b.outcome)) fail('نتیجه و علت بستن پرونده لازم است.');
        c.stage = b.outcome; c.closeReason = note;
        db.prepare("UPDATE tasks SET state='cancelled' WHERE customer_id=? AND state IN ('open','paused')").run(id);
        event(id, u.id, b.outcome === 'won' ? 'قرارداد منعقد شد' : 'عدم خرید و بستن پرونده', note);
      } else if (type === 'reopen') {
        if (!['won','lost'].includes(c.stage)) fail('پرونده بسته نیست.'); if (!note) fail('علت بازگشایی را وارد کنید.');
        c.stage = 'longterm'; task(id, c.salesId, 'followup', 'پیگیری بلندمدت', due(), c.followupCount + 1); event(id, u.id, 'بازگشایی پرونده', note);
      } else if (['visit','contract'].includes(type)) {
        if (activeTask(id, type)) fail('یک جلسه باز از این نوع وجود دارد.'); if (!note) fail('توضیحات جلسه را وارد کنید.');
        const day = scheduledDate(); if (b.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.time)) fail('ساعت جلسه معتبر نیست.');
        db.prepare("UPDATE tasks SET state='cancelled' WHERE customer_id=? AND kind='followup' AND state IN ('open','paused')").run(id);
        task(id, c.salesId, type, type === 'visit' ? 'بازدید کارخانه' : 'جلسه عقد قرارداد', day); c.stage = type;
        event(id, u.id, type === 'visit' ? 'برنامه‌ریزی بازدید' : 'برنامه‌ریزی قرارداد', `${day}${b.time ? ' — ' + b.time : ''}\n${note}`);
      } else if (type === 'quote') {
        const labels = { pending:'نیازمند تهیه', ready:'آماده ارسال', sent:'ارسال‌شده', unneeded:'فعلاً لازم نیست' };
        if (!Object.hasOwn(labels, b.quoteStatus) || !note) fail('وضعیت و جزئیات پیش‌فاکتور را وارد کنید.');
        c.quoteStatus = b.quoteStatus; c.quoteNumber = text(b.quoteNumber, 100); c.quoteDate = b.quoteStatus === 'sent' ? date(b.sentDate || today()) : ''; c.stage = 'quote';
        event(id, u.id, 'به‌روزرسانی پیش‌فاکتور', `${labels[c.quoteStatus]} ${c.quoteNumber}\n${note}`); ensureSalesWork(c);
      } else if (type === 'complete') {
        if (!t) fail('کار را انتخاب کنید.');
        if (!note && !['introduction','trust'].includes(t.kind)) fail('توضیحات و نتیجه را وارد کنید.');
        const actual = date(b.actualDate || today()); if (actual > today()) fail('تاریخ انجام نمی‌تواند در آینده باشد.');
        if (['discovery','followup'].includes(t.kind)) {
          if (!['success','noanswer','later','invalid'].includes(b.result)) fail('نتیجه تماس را مشخص کنید.');
          const next = due(); if (next < actual) fail('موعد بعدی نمی‌تواند قبل از تماس باشد.');
          if (b.result !== 'success') {
            db.prepare('UPDATE tasks SET due=? WHERE id=?').run(next, t.id);
            event(id, u.id, 'تلاش تماس', `${t.title} — ${{ noanswer:'پاسخ نداد', later:'درخواست تماس در زمان دیگر', invalid:'شماره نامعتبر' }[b.result]} — ${actual}\n${note}`);
            save(c); return { customer: publicCustomer(u, customer(id)) };
          }
        }
        // Complete before scheduling the successor, so the unique follow-up rule also covers retries.
        db.prepare("UPDATE tasks SET state='done' WHERE id=?").run(t.id);
        if (t.kind === 'discovery') {
          discovery(c, b); c.stage = 'followup';
          task(id, c.salesId, 'introduction', INTRO_TITLE, actual);
          task(id, c.salesId, 'trust', 'ارسال محتوای اعتمادسازی', plus(actual, 2));
          task(id, c.salesId, 'followup', 'تماس پیگیری ۱ از ۴', due(), 1);
        } else if (t.kind === 'followup') {
          c.followupCount += 1;
          if (b.readiness !== undefined) { if (!['cold','warm','hot'].includes(b.readiness)) fail('آمادگی خرید معتبر نیست.'); c.readiness = b.readiness; }
          if (b.purchaseDate) c.purchaseDate = date(b.purchaseDate);
          c.stage = c.followupCount >= 4 ? 'longterm' : 'followup';
          task(id, c.salesId, 'followup', c.followupCount >= 4 ? 'پیگیری بلندمدت' : `تماس پیگیری ${c.followupCount + 1} از ۴`, due(), c.followupCount + 1);
        } else if (t.kind === 'technical') {
          c.stage = c.technicalReturnStage || (c.followupCount >= 4 ? 'longterm' : 'followup'); delete c.technicalReturnStage;
          db.prepare("UPDATE tasks SET state='open' WHERE customer_id=? AND state='paused' AND kind!='technical'").run(id);
          ensureSalesWork(c, actual);
        } else if (['visit','contract'].includes(t.kind)) {
          if (b.meetingResult !== undefined && !['held','cancelled','noShow'].includes(b.meetingResult)) fail('نتیجه جلسه معتبر نیست.');
          if (['cancelled','noShow'].includes(b.meetingResult)) db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(t.id);
          c.stage = c.followupCount >= 4 ? 'longterm' : 'followup'; ensureSalesWork(c, actual);
        }
        event(id, u.id, t.kind === 'technical' ? 'پاسخ مشاوره فنی و بازگشت به فروش' : t.title,
          `تاریخ انجام: ${actual}\n${b.meetingResult ? { held:'جلسه برگزار شد', cancelled:'جلسه لغو شد', noShow:'مشتری حاضر نشد' }[b.meetingResult] + '\n' : ''}${note || 'ارسال انجام شد'}`);
      } else fail('اقدام معتبر نیست.');
      save(c); return { customer: canAccess(u, c) ? publicCustomer(u, customer(id)) : null };
    });
  }

  // Upgrade legacy data once, retaining historical rows and the original salesperson IDs.
  transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version < 2) {
      db.prepare("UPDATE users SET role='manager' WHERE role='admin'").run();
      for (const row of db.prepare('SELECT id FROM customers').all()) {
        const c = customer(row.id);
        c.registrationNotes ??= '';
        c.discoveryNotes ??= c.generalNotes || '';
        c.devices ??= c.tonnage ? [{ name:'دستگاه ثبت‌شده قبلی', tonnage:c.tonnage, technicalFeatures:c.technicalFeatures || '', quotedPrice:c.quotedPrice || '' }] : [];
        const media = db.prepare("SELECT * FROM tasks WHERE customer_id=? AND kind IN ('catalog','film') AND state IN ('open','paused') ORDER BY due,id").all(c.id);
        if (media.length) {
          db.prepare('UPDATE tasks SET kind=?,title=? WHERE id=?').run('introduction', INTRO_TITLE, media[0].id);
          for (const extra of media.slice(1)) db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(extra.id);
        }
        const followups = db.prepare("SELECT id FROM tasks WHERE customer_id=? AND kind='followup' AND state IN ('open','paused') ORDER BY due,id").all(c.id);
        for (const extra of followups.slice(1)) db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(extra.id);
        if (c.stage === 'technical') {
          c.technicalRequest ??= db.prepare("SELECT note FROM events WHERE customer_id=? AND type='درخواست مشاوره فنی' ORDER BY id DESC LIMIT 1").get(c.id)?.note || '';
          db.prepare("UPDATE tasks SET state='paused' WHERE customer_id=? AND kind!='technical' AND state='open'").run(c.id);
        }
        const { id, code, created, updated, ...stored } = c;
        db.prepare('UPDATE customers SET data=? WHERE id=?').run(JSON.stringify(stored), id);
      }
      db.exec('PRAGMA user_version=2');
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_active_followup ON tasks(customer_id) WHERE kind='followup' AND state IN ('open','paused')");
  });
  return { users, customer, transaction, canAccess, access, publicCustomer, dataFor, createCustomer, editCustomer, perform };
}
