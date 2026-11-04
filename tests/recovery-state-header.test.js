const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {once}=require('node:events');
test('real content route delivers bounded task state with full and conditional responses',async t=>{
 const session={name:'reader',createdAt:'generation',stateEpoch:'epoch',activityRevision:1,activity:{available:true,phase:'working',busy:true}};
 const app=express();app.use('/api/sessions',require('../server/routes/sessions')({getSession:()=>session,mobile:async()=>({messages:[{text:'same content'}],completed:null,contentRevision:'same'})}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const url='http://127.0.0.1:'+server.address().port+'/api/sessions/reader/mobile';
 const first=await fetch(url);assert.equal(first.status,200);await first.json();
 session.activityRevision=2;session.activity={available:true,phase:'thinking',busy:true};
 const second=await fetch(url,{headers:{'If-None-Match':first.headers.get('etag'),'X-TTYD-Delta':'fields-v1'}});
 assert.equal(second.status,304);const state=JSON.parse(Buffer.from(second.headers.get('X-TTYD-State'),'base64url'));
 assert.equal(state.activityRevision,2);assert.equal(state.activity.phase,'thinking');assert.equal(state.createdAt,'generation');
 const mismatch=await fetch(url,{headers:{'X-TTYD-Generation':'wrong'}});assert.equal(mismatch.status,409);assert.equal(mismatch.headers.get('X-TTYD-State'),null);
});
