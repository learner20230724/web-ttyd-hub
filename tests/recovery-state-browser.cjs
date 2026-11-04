const { chromium } = require('playwright');
const express = require('express');
const { EventEmitter, once } = require('events');
const assert = require('node:assert/strict');
const setup = require('../server/ws');
(async () => {
  let revision = 1, failList = false, writes = 0;
  const session = () => ({ name:'recovery', displayName:'状态自动恢复', createdAt:'2026-11-05T00:00:00Z', shell:'codex', status:'running', stateEpoch:'test-epoch', activityRevision:revision,
    activity:{ available:true, detected:true, busy:revision===1, phase:revision===1?'working':'completed', completed:revision===1?null:'done', contentRevision:'r'+revision } });
  const app = express();
  app.use((req,res,next)=>req.method==='GET'?next():(writes++,res.sendStatus(405)));
  app.get('/api/sessions',(_q,r)=>failList?r.sendStatus(503):r.json({stateEpoch:'test-epoch',sessions:[session()]}));
  app.get('/api/sessions/shells',(_q,r)=>r.json({platform:'linux',shells:[]}));
  app.get('/api/sessions/:id/questions',(_q,r)=>r.json({supported:false,requests:[]}));
  app.get('/api/sessions/:id/mobile',(_q,r)=>{const s=session();r.set('X-TTYD-State',Buffer.from(JSON.stringify(s)).toString('base64url'));r.json({messages:[{id:'reply'+revision,role:'assistant',text:revision===1?'正在整理项目进展。':'任务已完成。重新打开后，回答与任务状态自动同步。',phase:'final_answer'}],completed:s.activity.completed,contentRevision:s.activity.contentRevision});});
  app.use(express.static(require('path').join(__dirname,'../server/public')));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const manager=new EventEmitter();manager.list=()=>[session()];const ws=setup(server,manager);
  const browser=await chromium.launch({args:['--no-sandbox']});
  try {
    const context=await browser.newContext({viewport:{width:412,height:915},isMobile:true});
    await context.addInitScript(()=>{localStorage.setItem('web-ttyd-hub.last-session.v1',JSON.stringify({name:'recovery',createdAt:'2026-11-05T00:00:00Z'}));Object.defineProperty(document,'hasFocus',{value:()=>false});});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByText('正在整理项目进展。',{exact:true}).waitFor();
    failList=true;revision=2;
    await page.getByText('任务已完成。重新打开后，回答与任务状态自动同步。',{exact:true}).waitFor();
    await page.locator('.mobile-session-header .activity-badge.unread').waitFor();
    assert.equal(await page.locator('.mobile-reading').getAttribute('data-content-revision'),'r2');
    // Late metadata must not undo the independently confirmed content state.
    const stale=session();stale.activityRevision=1;stale.activity={available:true,busy:true,phase:'working'};
    manager.emit('session:activity',stale);await page.waitForTimeout(100);
    assert.equal(await page.locator('.mobile-session-header').getAttribute('data-activity-state'),'unread');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('hub:visibility',{detail:{visible:false}})));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.locator('.mobile-session-header .activity-badge.unread').waitFor();
    await page.screenshot({path:require('path').join(require('os').tmpdir(),'ttyd-recovery-preview.png')});
    assert.deepEqual(errors,[]);assert.equal(writes,0);
    console.log('PASS final content confirms state without list or activity event; old revisions rejected; foreground recovers; zero writes');
  } finally {await browser.close();for(const client of ws.clients)client.terminate();ws.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
