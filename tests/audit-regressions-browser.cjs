const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
(async () => {
 const createdAt='2026-11-01T00:00:00Z'; let mode='structured', reads=0;
 const reader={name:'reader',displayName:'当前对话',shell:'codex',createdAt,codexThreadId:'thread-A',status:'running',activity:{available:true,phase:'completed',completed:'t1',contentRevision:'r1'}};
 const idle={name:'idle',displayName:'已读任务',shell:'codex',createdAt,status:'running',activity:{available:true,phase:'completed',completed:'t1'}};
 const busy={name:'busy',displayName:'工作中的任务',shell:'codex',createdAt,status:'running',activity:{available:true,detected:true,busy:true,phase:'working',completed:null}};
 const shared={revision:1,layout:{order:['reader','idle','busy'],pinned:[]},read:{idle:{createdAt,completed:'t1'},reader:{createdAt,completed:'t1',contentRevision:'r1'}}};const sessions=[reader,idle,busy];
 const m=new EventEmitter();m.list=()=>sessions;m.sync={snapshot:()=>shared};
 const app=express();app.use((q,r,n)=>q.method==='GET'?n():r.sendStatus(405));
 app.get('/api/sessions',(q,r)=>r.json({sessions,shared}));app.get('/api/sessions/shells',(q,r)=>r.json({platform:'linux',shells:[]}));app.get('/api/sessions/:name/questions',(q,r)=>r.json({supported:false,requests:[]}));
 app.get('/api/sessions/:name/mobile',(q,r)=>{reads++;if(q.query.view==='full'||mode==='fallback')return r.json({text:'真实终端输出（合成测试）'});if(mode==='empty')return r.json({messages:[],sourceState:'unavailable',threadId:reader.codexThreadId});r.json({messages:[{id:'a1',role:'assistant',text:'线程 A 的旧回答',phase:'final_answer'}],completed:'t1',contentRevision:'r1',threadId:'thread-A'})});
 app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname,'../server/public')));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const ws=require('../server/ws')(server,m);const b=await chromium.launch({args:['--no-sandbox']});
 try {
  for (const width of [360,1280]) {
   mode='structured';reader.codexThreadId='thread-A';reader.activity={available:true,phase:'completed',completed:'t1',contentRevision:'r1'};busy.activity={available:true,detected:true,busy:true,phase:'working'};
   const ctx=await b.newContext({viewport:{width,height:800},isMobile:width<768,hasTouch:width<768});
   await ctx.addInitScript(({createdAt})=>{document.hasFocus=()=>false;localStorage.setItem('web-ttyd-hub.shared-migrated.v1','1');localStorage.setItem('web-ttyd-hub.last-session.v1',JSON.stringify({name:'reader',createdAt}))},{createdAt});
   const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:'+server.address().port);
   await p.getByText('线程 A 的旧回答',{exact:true}).waitFor();
   const order=()=>p.locator('.session-list [data-session-id]').evaluateAll(es=>es.map(e=>e.dataset.sessionId));const before=await order();
   busy.activity={available:false,detected:true,busy:false,phase:'unknown'};m.emit('session:activity',busy);await p.waitForTimeout(200);
   assert.deepEqual(await order(),before);if(width<768){assert.equal(await p.locator('.working-badge').innerText(),'1');assert.equal(await p.locator('.activity-counters.stale').count(),1);}
   await p.locator('.composer textarea').fill('尚未发送的草稿');await p.reload();
   await p.getByText('线程 A 的旧回答',{exact:true}).waitFor();assert.equal(await p.locator('.composer textarea').inputValue(),'尚未发送的草稿');
   if (width >= 768) {
     const history = Array.from({length:625}, (_, i) => ({id:'row-'+i, role:'assistant', text:'历史消息 '+i}));
     await p.route('**/sessions/reader/mobile*', route => {
       const before = new URL(route.request().url()).searchParams.get('before');
       const end = before ? history.findIndex(message => message.id === before) : history.length;
       const start = Math.max(0, end-300);
       return route.fulfill({json:{messages:history.slice(start,end),hasEarlier:start>0,threadId:'thread-A',completed:'t1',contentRevision:'r1'}});
     });
     await p.reload();
     const pane = p.locator('[data-view="answer"]');
     await pane.locator('[data-message-id="row-624"]').waitFor();
     for (const [first, next] of [[325,25],[25,0]]) {
       const anchor = pane.locator('[data-message-id="row-'+first+'"]');
       await pane.evaluate(el => { el.scrollTop=20; });
       await pane.locator('[data-message-id="row-'+next+'"]').waitFor();
       assert(await anchor.evaluate(el=>Math.abs(el.getBoundingClientRect().top-el.parentElement.getBoundingClientRect().top)<160));
     }
     assert.equal(await pane.locator('article.message').count(),625);
     await p.getByRole('button',{name:'全文',exact:true}).click();
     await p.locator('.terminal-host').waitFor();
     await p.getByRole('button',{name:'回答',exact:true}).click();
     await pane.locator('[data-message-id="row-0"]').waitFor();
     assert.equal(await pane.locator('article.message').count(),625);
     await p.unroute('**/sessions/reader/mobile*');
   }
   reader.codexThreadId='thread-B';reader.activity={available:false,detected:true,busy:false,phase:'unknown'};mode='empty';m.emit('session:activity',reader);await p.waitForTimeout(300);
   assert.equal(await p.getByText('线程 A 的旧回答',{exact:true}).count(),0);assert.equal(await p.locator('.composer textarea').inputValue(),'');
   mode='fallback';await p.getByRole('button',{name:width>=768?'回答':'隐藏执行过程',exact:true}).click();await p.waitForTimeout(200);assert.equal(await p.locator('.mobile-output').count(),0);
   await p.getByRole('button',{name:width>=768?'全文':'显示执行过程',exact:true}).click();
   if (width >= 768) await p.locator('.terminal-host .xterm-screen').waitFor();
   else await p.getByText('真实终端输出（合成测试）',{exact:true}).waitFor();
   await p.getByRole('button',{name:width>=768?'回答':'隐藏执行过程',exact:true}).click();await p.locator('.answer-placeholder').waitFor();
   if(width<768) await p.getByRole('button',{name:'会话列表',exact:true}).click();
   await p.clock.install();await p.evaluate(()=>{const original=window.fetch.bind(window);window.fetch=(url,opts)=>{if(opts?.method==='PATCH'){window.__patchSignal=Boolean(opts.signal);return new Promise(()=>{})}return original(url,opts)}});
   await p.locator('[data-session-id="reader"] .session-menu-btn').click();await p.getByRole('button',{name:'修改名称',exact:true}).click();await p.getByRole('textbox',{name:'会话名称 / Session name',exact:true}).fill('新名称');await p.getByRole('button',{name:'保存 / Save',exact:true}).click();await p.clock.fastForward(30000);
   await p.getByText('操作确认超时，请刷新确认结果',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.__patchSignal),true);assert.deepEqual(errors,[]);
   await ctx.close(); console.log('PASS identity, stale order/count, draft persistence, distinct views and mutation deadline:',width);
  }
 } catch (error) { console.error(error); process.exitCode=1; } finally {await b.close();for(const c of ws.clients)c.terminate();ws.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
