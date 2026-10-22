import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARBERS, DEFAULT_CONFIG, kyivNow, validDate, availableSlots, validateConfig } from './lib/studio.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || resolve(root, 'data/studio.sqlite');
const demo = process.env.DEMO_MODE !== 'false';
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('SESSION_SECRET of at least 32 characters is required in production');
if (!demo && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16 || !process.env.SESSION_SECRET)) throw new Error('Live mode requires SESSION_SECRET and ADMIN_PASSWORD (at least 16 characters)');
const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS settings (workspace TEXT PRIMARY KEY, config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, client TEXT NOT NULL, date TEXT NOT NULL, barber TEXT NOT NULL, service TEXT NOT NULL, start INTEGER NOT NULL, duration INTEGER NOT NULL, price INTEGER NOT NULL, customer TEXT NOT NULL, phone TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS booking_workspace_date ON bookings(workspace,date);
CREATE TABLE IF NOT EXISTS slots (workspace TEXT NOT NULL, barber TEXT NOT NULL, date TEXT NOT NULL, minute INTEGER NOT NULL, booking TEXT NOT NULL REFERENCES bookings(id), PRIMARY KEY(workspace,barber,date,minute));
PRAGMA user_version=1;`);
const readConfig = workspace => { const row = db.prepare('SELECT config FROM settings WHERE workspace=?').get(workspace); return row ? JSON.parse(row.config) : structuredClone(DEFAULT_CONFIG); };
const readBookings = workspace => db.prepare('SELECT * FROM bookings WHERE workspace=? ORDER BY date,start').all(workspace);
const publicBooking = ({ workspace, client, ...b }) => b;
const rate = new Map();
function allowed(key, limit) { const now = Date.now(); let bucket = rate.get(key); if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + 60000 }; rate.set(key, bucket); } return ++bucket.count <= limit; }
function sign(value) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function equal(a,b) { const x=Buffer.from(a),y=Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }
function session(req,res) {
  const raw = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('blade_session='))?.slice(14);
  if (raw && raw.length < 2000) { const [payload, signature] = raw.split('.'); if (signature && equal(sign(payload),signature)) { try { const s = JSON.parse(Buffer.from(payload,'base64url')); if (typeof s.id === 'string' && s.expires > Date.now()) return s; } catch {} } }
  const value = { id: randomUUID(), admin: false, expires: Date.now() + 7 * 86400000 }; setSession(req,res,value); return value;
}
function setSession(req,res,value) { const payload=Buffer.from(JSON.stringify(value)).toString('base64url'); const secure=req.headers['x-forwarded-proto']==='https'; res.setHeader('Set-Cookie',`blade_session=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure?'; Secure':''}`); }
function json(res,body,status=200) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
async function body(req) { let raw=''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw)>16000) throw Object.assign(new Error('Завеликий запит.'),{status:413}); } try { const v=JSON.parse(raw); if (!v || typeof v!=='object' || Array.isArray(v)) throw new Error(); return v; } catch { throw Object.assign(new Error('Некоректний запит.'),{status:400}); } }
function transact(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health') return json(res,{ok:true,mode:demo?'demo':'live'});
    const s=session(req,res), workspace=demo?s.id:'live', isAdmin=demo||s.admin===true;
    if(req.method==='GET' && url.pathname==='/api/studio') {
      const admin=url.searchParams.get('admin')==='1';
      if(admin&&!isAdmin) return json(res,{error:'Увійдіть у кабінет адміністратора.'},401);
      const bookings=readBookings(workspace).filter(b=>admin||demo||b.client===s.id).map(publicBooking);
      return json(res,{config:readConfig(workspace),barbers:BARBERS,bookings,now:kyivNow(),demo,admin:isAdmin});
    }
    if(req.method==='GET' && url.pathname==='/api/availability') {
      const config=readConfig(workspace),service=config.services.find(x=>x.id===url.searchParams.get('service'));
      const date=url.searchParams.get('date'), barber=url.searchParams.get('barber');
      if(!service||!BARBERS.some(x=>x.id===barber)||!validDate(date,kyivNow().date)) return json(res,{error:'Некоректна дата, послуга або майстер.'},400);
      let duration=service.duration;
      const except=url.searchParams.get('except');
      let bookings=readBookings(workspace);
      if(except) { const old=bookings.find(x=>x.id===except&&(isAdmin||x.client===s.id)); if(!old||old.status!=='confirmed') return json(res,{error:'Запис недоступний.'},404); duration=old.duration; bookings=bookings.filter(x=>x.id!==except); }
      return json(res,{slots:availableSlots(config,date,barber,duration,bookings)});
    }
    if(req.method==='POST' && url.pathname==='/api/studio') {
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) return json(res,{error:'Запит з іншого сайту відхилено.'},403);
      const ip=req.socket.remoteAddress||'local';
      if(!allowed(`write:${s.id}`,60)) return json(res,{error:'Забагато запитів. Спробуйте за хвилину.'},429);
      const b=await body(req);
      if(b.action==='login') { if(!allowed(`login:${ip}`,5)) return json(res,{error:'Забагато спроб. Зачекайте хвилину.'},429); if(!demo&&!equal(String(b.password||''),process.env.ADMIN_PASSWORD||'')) return json(res,{error:'Неправильний пароль.'},401); s.admin=true; setSession(req,res,s); return json(res,{ok:true}); }
      if(b.action==='logout') { s.admin=false; setSession(req,res,s); return json(res,{ok:true}); }
      if(b.action==='book'||b.action==='reschedule') {
        const config=readConfig(workspace);
        const old=b.action==='reschedule'?db.prepare('SELECT * FROM bookings WHERE id=? AND workspace=?').get(String(b.id),workspace):null;
        if(b.action==='reschedule'&&(!old||(!isAdmin&&old.client!==s.id)||old.status!=='confirmed')) return json(res,{error:'Цей запис уже не можна перенести.'},409);
        const service=config.services.find(x=>x.id===(old?.service??b.service));
        const date=b.date,barber=b.barber,start=b.start,customer=old?.customer??String(b.customer??'').trim(),phone=old?.phone??String(b.phone??'').trim(),note=old?.note??String(b.note??'').trim();
        if(!service||!BARBERS.some(x=>x.id===barber)||!validDate(date,kyivNow().date)||!Number.isInteger(start)||customer.length<2||customer.length>80||!/^\+?[\d\s()-]{9,24}$/.test(phone)||phone.replace(/\D/g,'').length<9||note.length>500) return json(res,{error:'Перевірте ім’я, телефон, дату та час запису.'},400);
        const duration=old?.duration??service.duration,id=old?.id??randomUUID();
        try { transact(()=>{
          const existing=readBookings(workspace).filter(x=>x.id!==old?.id);
          if(!availableSlots(config,date,barber,duration,existing).includes(start)) throw Object.assign(new Error('Цей час уже зайнятий або недоступний. Оберіть інший.'),{status:409});
          if(old) { db.prepare('DELETE FROM slots WHERE booking=?').run(id); db.prepare('UPDATE bookings SET date=?,barber=?,start=? WHERE id=?').run(date,barber,start,id); }
          else db.prepare('INSERT INTO bookings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,workspace,s.id,date,barber,service.id,start,duration,service.price,customer,phone,note,'confirmed',new Date().toISOString());
          const insert=db.prepare('INSERT INTO slots VALUES (?,?,?,?,?)');
          for(let minute=start;minute<start+duration;minute+=15) insert.run(workspace,barber,date,minute,id);
        }); } catch(e) { if(/UNIQUE constraint/.test(e.message)) return json(res,{error:'Цей час щойно зайняли. Оберіть інший.'},409); throw e; }
        return json(res,{id,booking:publicBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(id))});
      }
      if(b.action==='status') {
        if(!['cancelled','completed'].includes(b.status)||(!isAdmin&&b.status==='completed')) return json(res,{error:'Недоступна дія.'},403);
        const found=db.prepare('SELECT * FROM bookings WHERE id=? AND workspace=?').get(String(b.id),workspace);
        if(!found||(!isAdmin&&found.client!==s.id)||found.status!=='confirmed') return json(res,{error:'Запис недоступний або статус уже змінено.'},409);
        transact(()=>{ db.prepare('UPDATE bookings SET status=? WHERE id=?').run(b.status,found.id); if(b.status==='cancelled') db.prepare('DELETE FROM slots WHERE booking=?').run(found.id); });
        return json(res,{ok:true});
      }
      if(b.action==='settings') {
        if(!isAdmin) return json(res,{error:'Потрібен вхід адміністратора.'},403);
        if(!validateConfig(b.config)) return json(res,{error:'Перевірте години роботи, дні, ціни та тривалість послуг.'},400);
        const c=b.config;
        const config={open:c.open,close:c.close,weekdays:[...new Set(c.weekdays)],services:c.services.map(({id,name,description,duration,price})=>({id,name:name.trim(),description,duration,price}))};
        db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(workspace) DO UPDATE SET config=excluded.config').run(workspace,JSON.stringify(config));
        return json(res,{config});
      }
      return json(res,{error:'Невідома дія.'},400);
    }
    if(url.pathname.startsWith('/api/')) return json(res,{error:'Не знайдено.'},404);
    if(!['GET','HEAD'].includes(req.method)) return json(res,{error:'Метод недоступний.'},405);
    const files={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg','/studio.mjs':'../lib/studio.mjs'};
    const file=files[url.pathname];
    if(!file) return json(res,{error:'Сторінку не знайдено.'},404);
    const path=resolve(root,'public',file);
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[extname(path)],'Cache-Control':file==='index.html'?'no-cache':'public, max-age=300'});
    res.end(req.method==='HEAD'?undefined:readFileSync(path));
  } catch(e) { if(!e.status) console.error('Request failed:',e.message); if(!res.headersSent) json(res,{error:e.status?e.message:'Не вдалося виконати запит. Спробуйте ще раз.'},e.status||500); else res.end(); }
});
server.requestTimeout=15000;
server.headersTimeout=10000;
const cleanup=setInterval(()=>{ const now=Date.now(); for(const [key,value] of rate) if(value.until<now) rate.delete(key); if(demo) { const cutoff=new Date(now-7*86400000).toISOString(); transact(()=>{db.prepare('DELETE FROM slots WHERE booking IN (SELECT id FROM bookings WHERE created < ?)').run(cutoff);db.prepare('DELETE FROM bookings WHERE created < ?').run(cutoff);}); } },3600000); cleanup.unref();
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`BLADE listening on http://${process.env.HOST||'127.0.0.1'}:${server.address().port} (${demo?'demo':'live'})`));
function shutdown() { clearInterval(cleanup); server.close(()=>{db.close();process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); }
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
