import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DEFAULT_CONFIG, availableSlots, addDays, kyivNow, validDate, validateConfig } from '../lib/studio.mjs';

test('availability respects overlap, exact boundaries, cancellation, holidays and Kyiv lead time',()=>{
  const date='2026-10-23',now={date:'2026-10-22',minute:1000};
  const booking={date,barber:'maks',start:660,duration:60,status:'confirmed'};
  const slots=availableSlots(DEFAULT_CONFIG,date,'maks',60,[booking],now);
  assert(slots.includes(600));assert(!slots.includes(615));assert(!slots.includes(660));assert(slots.includes(720));
  assert(availableSlots(DEFAULT_CONFIG,date,'artem',60,[booking],now).includes(660));
  assert(availableSlots(DEFAULT_CONFIG,date,'maks',60,[{...booking,status:'cancelled'}],now).includes(660));
  assert(!availableSlots(DEFAULT_CONFIG,date,'maks',90,[],now).includes(1125));
  assert.deepEqual(availableSlots({...DEFAULT_CONFIG,weekdays:[]},date,'maks',60,[],now),[]);
  assert(!availableSlots(DEFAULT_CONFIG,now.date,'maks',60,[],{...now,minute:605}).includes(615));
  assert(validDate('2026-10-23',now.date));assert(!validDate('2026-02-30','2026-02-01'));assert(!validDate('2026-10-21',now.date));assert(!validDate('2026-12-01',now.date));
  assert.equal(kyivNow(new Date('2026-10-22T22:30:00Z')).date,'2026-10-23');
  assert(validateConfig(DEFAULT_CONFIG));assert(!validateConfig({...DEFAULT_CONFIG,close:DEFAULT_CONFIG.open}));
  assert(!validateConfig({...DEFAULT_CONFIG,services:DEFAULT_CONFIG.services.map(s=>({...s,duration:17}))}));
});

async function start({demo=true,db=join(mkdtempSync(join(tmpdir(),'blade-test-')),'db.sqlite')}={}){
  const child=spawn(process.execPath,['server.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:db,DEMO_MODE:String(demo),SESSION_SECRET:'test-secret-do-not-use-in-production',ADMIN_PASSWORD:'test-admin-password-long'}});
  let output='';
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start: '+output)),10000);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127.0.0.1:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});child.stderr.on('data',x=>output+=x);child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});});
  return {origin,db,async stop(){child.kill('SIGTERM');await once(child,'exit');}};
}
async function client(origin){
  const first=await fetch(origin+'/api/studio');const cookie=first.headers.get('set-cookie').split(';')[0];
  return {cookie,initial:await first.json(),async request(path='/api/studio',body,headers={}){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),headers:r.headers};}};
}
test('demo API: concurrent booking, isolation, ownership, reschedule, persistence and settings',async t=>{
  let app=await start();t.after(()=>app.stop());
  const a=await client(app.origin),b=await client(app.origin),date=addDays(kyivNow().date,1);
  const request={action:'book',service:'cut',barber:'maks',date,start:600,customer:'Тестовий клієнт',phone:'+380000000000',note:'<script>test</script>'};
  await t.test('simultaneous requests create exactly one appointment',async()=>{
    const results=await Promise.all(Array.from({length:8},()=>a.request('/api/studio',request)));
    assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(results.filter(x=>x.status===409).length,7);
  });
  const booked=(await a.request()).body.bookings[0];
  await t.test('other visitors cannot read, change, or occupy the same demo sandbox',async()=>{
    assert.equal((await b.request()).body.bookings.length,0);
    assert.equal((await b.request('/api/studio',{action:'status',id:booked.id,status:'cancelled'})).status,409);
    assert.equal((await b.request('/api/studio',request)).status,200);
  });
  await t.test('overlapping durations blocked; past dates, unknown services, malformed contacts rejected',async()=>{
    assert.equal((await a.request('/api/studio',{...request,start:615,service:'beard'})).status,409);
    for(const change of [{date:'2000-01-01'},{service:'unknown'},{start:607},{phone:'bad'},{customer:'A'}]) assert([400,409].includes((await a.request('/api/studio',{...request,...change})).status));
    assert.equal((await a.request('/api/studio',request,{Origin:'https://attacker.example'})).status,403);
  });
  await t.test('failed reschedule preserves old booking; successful reschedule releases old slot',async()=>{
    assert.equal((await a.request('/api/studio',{action:'reschedule',id:booked.id,date,barber:'maks',start:1190})).status,409);
    assert.equal((await a.request()).body.bookings[0].start,600);
    assert.equal((await a.request('/api/studio',{action:'reschedule',id:booked.id,date,barber:'artem',start:720})).status,200);
    assert.equal((await a.request('/api/studio',{...request})).status,200);
  });
  await t.test('settings affect future bookings; price and duration of existing booking stay unchanged',async()=>{
    const config=structuredClone(DEFAULT_CONFIG);config.services[0].price=900;config.services[0].duration=90;
    assert.equal((await a.request('/api/studio',{action:'settings',config})).status,200);
    const old=(await a.request()).body.bookings.find(x=>x.id===booked.id);assert.equal(old.price,650);assert.equal(old.duration,60);
    assert.equal((await a.request('/api/studio',{action:'settings',config:{...config,weekdays:[]}})).status,400);
  });
  await t.test('cancellation releases capacity; completed appointments keep their occupancy',async()=>{
    assert.equal((await a.request('/api/studio',{action:'status',id:booked.id,status:'cancelled'})).status,200);
    const q=new URLSearchParams({date,barber:'artem',service:'cut'});
    assert((await a.request('/api/availability?'+q)).body.slots.includes(720));
    const other=(await a.request()).body.bookings.find(x=>x.status==='confirmed');
    assert.equal((await a.request('/api/studio',{action:'status',id:other.id,status:'completed'})).status,200);
    assert.equal((await a.request('/api/studio',request)).status,409);
  });
  await t.test('records and session survive process restart',async()=>{
    const db=app.db;await app.stop();app=await start({db});
    const r=await fetch(app.origin+'/api/studio',{headers:{Cookie:a.cookie}});const body=await r.json();assert.equal(body.bookings.length,2);assert.equal(body.config.services[0].price,900);
  });
});
test('live mode: admin authentication and customer isolation',async t=>{
  const app=await start({demo:false});t.after(()=>app.stop());
  const a=await client(app.origin),b=await client(app.origin);
  assert.equal(a.initial.demo,false);assert.equal(a.initial.admin,false);
  assert.equal((await a.request('/api/studio?admin=1')).status,401);
  assert.equal((await a.request('/api/studio',{action:'settings',config:DEFAULT_CONFIG})).status,403);
  const date=addDays(kyivNow().date,1);
  const result=await a.request('/api/studio',{action:'book',service:'cut',barber:'maks',date,start:600,customer:'Тестовий клієнт',phone:'+380000000000'});
  assert.equal(result.status,200);assert.equal((await b.request()).body.bookings.length,0);
  assert.equal((await b.request('/api/studio',{action:'reschedule',id:result.body.id,date,barber:'maks',start:720})).status,409);
  assert.equal((await a.request('/api/studio',{action:'status',id:result.body.id,status:'completed'})).status,403);
  const slots=(await b.request('/api/availability?'+new URLSearchParams({date,barber:'maks',service:'cut'}))).body.slots;assert(!slots.includes(600));
  assert.equal((await b.request('/api/studio',{action:'login',password:'wrong'})).status,401);
  const login=await b.request('/api/studio',{action:'login',password:'test-admin-password-long'});assert.equal(login.status,200);
  const adminCookie=login.headers.get('set-cookie').split(';')[0];
  const all=await fetch(app.origin+'/api/studio?admin=1',{headers:{Cookie:adminCookie}});assert.equal((await all.json()).bookings.length,1);
  const unauth=await fetch(app.origin+'/api/studio?admin=1',{headers:{Cookie:'blade_session=forged.invalid'}});assert.equal(unauth.status,401);
});
