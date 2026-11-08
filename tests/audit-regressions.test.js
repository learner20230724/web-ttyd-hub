const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const SessionSync = require('../server/services/session-sync');
const { CodexActivity, consumeRollout } = require('../server/services/codex-activity');
const { matchesThread } = require('../server/services/session-identity');
const createdAt = '2026-11-01T00:00:00Z';

test('replayed moves cannot undo another device, including after state restoration', () => {
  const manager = new EventEmitter();
  manager.sessions = new Map(['a','b','c'].map(name => [name, { name, createdAt, status:'running' }]));
  manager.list = () => [...manager.sessions.values()];
  const sync = new SessionSync(manager);
  sync.apply({ type:'initialize', layout:{order:['a','b','c'],pinned:[]} });
  const move = target => ({ type:'move', name:'a', createdAt, target, targetCreatedAt:createdAt, after:true, opId:randomUUID(), issuedAt:Date.now() });
  const first = move('b'); sync.apply(first); sync.apply(move('c'));
  assert.deepEqual(sync.snapshot().layout.order, ['b','c','a']);
  const restored = new SessionSync(manager); restored.restore(structuredClone(sync.durable()));
  restored.apply(first);
  assert.deepEqual(restored.snapshot().layout.order, ['b','c','a']);
  assert.equal(restored.snapshot().operations, undefined);
  assert.throws(() => restored.apply({...first, target:'c'}), /冲突/);
});

test('current thread replaces original resume alias and partitions cached answer/full views', async () => {
  const s = { name:'same', createdAt, resumeThreadId:'A', codexThreadId:'B' };
  assert.equal(matchesThread(s,'A'),false); assert.equal(matchesThread(s,'B'),true);
  const { contentKey } = await import('../frontend/src/utils/session-content.mjs');
  for (const view of ['answer','full','terminal']) assert.notEqual(contentKey(s,view),contentKey({...s,codexThreadId:'A'},view));
});

test('a missing baseline never acknowledges an old identical input, and receipts bind to thread and server time', async () => {
  const { reconcileInputs } = await import('../frontend/src/utils/input-receipts.mjs');
  const pending = {id:'p',text:'继续',before:[],threadId:'B',sentAt:1,receivedAfter:'2026-11-08T00:00:02Z'};
  const row = {id:'old',role:'user',text:'继续',timestamp:'2026-11-08T00:00:01Z'};
  assert.equal(reconcileInputs([{...pending,before:[]}],{threadId:'B',messages:[row]}).length,1);
  const fresh={...row,id:'new',timestamp:'2026-11-08T00:00:03Z'};
  assert.equal(reconcileInputs([{...pending,before:[]}],{threadId:'A',messages:[fresh]}).length,1);
  assert.equal(reconcileInputs([{...pending,before:[]}],{threadId:'B',messages:[fresh]}).length,0);
  assert.equal(reconcileInputs([{text:'继续',before:[]}],{messages:[row]}).length,1);
});

test('history pages retain order without duplicates beyond the 300-message live window', async t => {
  const dir = await fs.mkdtemp('/tmp/hub-history-page-'); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename = dir+'/rollout.jsonl';
  await fs.writeFile(filename, Array.from({length:650},(_,i)=>JSON.stringify({type:'response_item',timestamp:new Date(1700000000000+i).toISOString(),payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'message '+i}]}})).join('\n'));
  const stat=await fs.stat(filename), session={name:'history',createdAt,status:'running',codexThreadId:'thread'};
  const manager={sessions:new Map([[session.name,session]]),getSession:()=>session,serialize:x=>x,emit(){}};
  const activity=new CodexActivity(manager,{interval:60000}); t.after(()=>activity.close());
  const state={path:filename,generation:createdAt,identity:`${stat.dev}:${stat.ino}`,offset:0,messages:[],sequence:0};
  await consumeRollout(state,stat.size); activity.states.set(session.name,state); activity.publish(session,{available:true,phase:'completed'});
  const live=activity.contentSnapshot(session.name); assert.equal(live.messages.length,300); assert.equal(live.hasEarlier,true);
  const older=await activity.earlier(session.name,live.messages[0].id); assert.equal(older.messages.length,300); assert.equal(older.hasEarlier,true);
  const oldest=await activity.earlier(session.name,older.messages[0].id); assert.equal(oldest.messages.length,50); assert.equal(oldest.hasEarlier,false);
  assert.deepEqual([...oldest.messages,...older.messages,...live.messages].map(m=>m.text),Array.from({length:650},(_,i)=>'message '+i));
  await assert.rejects(activity.earlier(session.name,'invalid'),/变化/);
});

test('every lifecycle mutation rejects missing and replaced generations before touching the manager', async t => {
  const express=require('express'), {once}=require('node:events'); let writes=0;
  const session={name:'same',createdAt,codexThreadId:'B',archivedAt:createdAt};
  const manager={getSession:()=>session,list:()=>[session]};
  for(const method of ['rename','stop','restart','restoreArchived','remove','archive']) manager[method]=()=>{writes++;return {ok:true}};
  const app=express();app.use(express.json());app.use('/api/sessions',require('../server/routes/sessions')(manager));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
  for(const [method,suffix] of [['PATCH',''],['POST','/stop'],['POST','/restart'],['POST','/restore'],['DELETE','/permanent'],['DELETE','']]) {
    const url=`http://127.0.0.1:${server.address().port}/api/sessions/same${suffix}`;
    for(const headers of [{},{'X-TTYD-Generation':'old'},{'X-TTYD-Generation':createdAt,'X-TTYD-Thread':'A'}]) assert.equal((await fetch(url,{method,headers})).status,409);
    assert.equal((await fetch(url,{method,headers:{'Content-Type':'application/json','X-TTYD-Generation':createdAt,'X-TTYD-Thread':'B'},body:JSON.stringify({name:'new'})})).status,200);
  }
  assert.equal(writes,6);
});
