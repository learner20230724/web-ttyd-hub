const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {once}=require('node:events');
const State=require('../server/services/session-state');
test('Atomic private metadata snapshots, backup and corrupt-state protection',()=>{
 const dir=fs.mkdtempSync('/tmp/hub-state-');try {
  const file=path.join(dir,'sessions.json'),state=new State(file);
  const session={name:'abc',displayName:'中文名字',shell:'bash',status:'running',createdAt:new Date().toISOString(),pid:999,process:'not persisted',codexThreadId:'thread'};
  state.save([session]);assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(state.read()[0].displayName,'中文名字');assert.equal(state.read()[0].pid,undefined);
  state.save([{...session,displayName:'重命名'}]);assert.equal(JSON.parse(fs.readFileSync(file+'.bak')).sessions[0].displayName,'中文名字');
  fs.writeFileSync(file,'broken');assert.throws(()=>state.read());assert.equal(fs.readFileSync(file,'utf8'),'broken');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('Real Hub restart restores stable IDs, Unicode names and stopped status without restarting tmux pane', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync('/tmp/hub-restore-');
 const env={...process.env,TMUX_TMPDIR:dir,HUB_STATE_FILE:path.join(dir,'sessions.json'),PORT:'19571',HOST:'127.0.0.1',TTYD_PORT_RANGE_START:'19572',TTYD_PORT_RANGE_END:'19580'};delete env.TMUX;
 let child;
 const api=async(suffix='',body,method)=>{const r=await fetch('http://127.0.0.1:19571/api/sessions'+suffix,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,JSON.stringify(data));return data};
 const start=async()=>{child=spawn(process.execPath,['server/index.js'],{cwd:path.join(__dirname,'..'),env,stdio:'ignore'});for(let i=0;i<100;i++){try{await api();return}catch{}await new Promise(r=>setTimeout(r,80))}throw Error('server not ready')};
 const stop=async()=>{const exit=once(child,'exit');child.kill('SIGTERM');await exit;child=null};
 try {
  await start();const s=await api('',{name:'原名称',shell:'bash'});
  await api('/'+s.name,{name:'持久名称 📌'},'PATCH');await api('/'+s.name+'/mobile');
  const pane=()=>execFileSync('tmux',['display-message','-p','-t','='+s.name+':','#{pane_id}:#{pane_pid}'],{env}).toString();
  const before=pane();const stopped=await api('',{name:'stopped-one',shell:'bash'});await api('/'+stopped.name+'/stop',{});
  await api('/'+s.name,undefined,'DELETE');
  assert.equal(pane(),before);
  const expiry=(await api()).sessions.find(x=>x.name===s.name).expiresAt;
  await stop();await start();let list=(await api()).sessions;
  assert.equal(list.find(x=>x.name===s.name).displayName,'持久名称 📌');assert.equal(list.find(x=>x.name===s.name).createdAt,s.createdAt);
  assert.equal(list.find(x=>x.name===stopped.name).status,'stopped');assert.equal(pane(),before);
  assert.equal(list.find(x=>x.name===s.name).expiresAt,expiry);
  await api('/'+s.name+'/restore',{});assert.equal(pane(),before);assert.equal((await api()).sessions.find(x=>x.name===s.name).archivedAt,null);
  await api('/'+stopped.name,undefined,'DELETE');await api('/'+stopped.name+'/permanent',undefined,'DELETE');await stop();await start();assert.equal((await api()).sessions.length,1);
  await api('/'+s.name,undefined,'DELETE');assert.equal(pane(),before);
  await api('/'+s.name+'/permanent',undefined,'DELETE');assert.equal((await api()).sessions.length,0);
  assert.throws(()=>execFileSync('tmux',['has-session','-t','='+s.name],{env,stdio:'ignore'}));
 }finally{if(child)await stop();try{execFileSync('tmux',['kill-server'],{env,stdio:'ignore'})}catch{}fs.rmSync(dir,{recursive:true,force:true})}
});

test('Archive is idempotent, exact 30 minute expiry and restore cancels scheduled cleanup', async()=>{
 const Manager=require('../server/services/session-manager');const m=new Manager(19680,19690);
 try {
  m.sessions.set('sample',{name:'sample',displayName:'Sample',status:'stopped',createdAt:new Date().toISOString(),shell:null});
  const first=m.archive('sample');const expiry=first.expiresAt;
  assert.equal(Date.parse(expiry)-Date.parse(first.archivedAt),1800000);
  assert.equal(m.archive('sample').expiresAt,expiry);
  const removed=[];m.remove=async name=>{removed.push(name);m.sessions.delete(name)};
  await m.purgeExpired(Date.parse(expiry)-1);assert.deepEqual(removed,[]);
  m.restoreArchived('sample');await m.purgeExpired(Date.parse(expiry)+1);assert.deepEqual(removed,[]);
  const next=m.archive('sample');await m.purgeExpired(Date.parse(next.expiresAt));assert.deepEqual(removed,['sample']);
 }finally{m.cleanup()}
});
