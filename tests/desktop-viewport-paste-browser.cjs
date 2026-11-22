const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, pause } = require('./terminal-fixture.cjs');
(async () => {
  const f = await fixture(); let browser;
  try {
    // A fixed-width remote pane also reproduces another larger attached client.
    f.tm('set-option', '-w', '-t', f.target, 'window-size', 'manual');
    f.tm('resize-window', '-t', f.target, '-x', '300', '-y', '30');
    f.output('\x1b[?1049h\x1b[2J\x1b[HLEFT_EDGE\x1b[1;285HRIGHT_EDGE');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
    page.setDefaultTimeout(8000);
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    // The upload/attach API is a controlled test double; the terminal below is real tmux.
    const writes=[];let uploads=0, fail=false;
    await page.route('**/api/sessions', async route=>{
      const response=await route.fetch(); const data=await response.json();
      data.sessions=data.sessions.map(s=>({...s,shell:'codex',activity:{...s.activity,detected:true}}));
      await route.fulfill({response,json:data});
    });
    await page.route('**/api/sessions/*/images', async route=>{
      uploads++;
      assert.equal(route.request().headers()['content-type'],'image/png');
      assert(route.request().postDataBuffer().length>0);
      await route.fulfill({json:{id:'test-image-'+uploads}});
    });
    await page.route('**/api/sessions/*/images/*', route=>route.fulfill({status:204}));
    await page.route('**/api/sessions/*/input', route=>{
      writes.push(route.request().postDataJSON());
      return route.fulfill({status:fail?503:200,json:fail?{error:'Synthetic attachment failure'}:{ok:true}});
    });
    await page.goto(f.base); await page.locator('.session-card').click();
    await page.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.cols===300 && !document.querySelector('.terminal-host').terminal.options.disableStdin);
    const geometry=()=>page.locator('.terminal-host').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,left:el.scrollLeft,screen:el.querySelector('.xterm-screen').getBoundingClientRect().width}));
    const initial=await geometry(); assert(initial.scrollWidth>initial.width+500);
    await page.locator('.xterm-screen').hover({position:{x:100,y:60}});
    await page.mouse.wheel(900,0); await page.waitForFunction(()=>document.querySelector('.terminal-host').scrollLeft>100);
    await page.locator('.terminal-host').evaluate(el=>{el.scrollLeft=el.scrollWidth});
    const edge=await page.locator('.terminal-host').evaluate(el=>{
      const screen=el.querySelector('.xterm-screen').getBoundingClientRect(),host=el.getBoundingClientRect(),t=el.terminal;
      return {right:screen.right,hostRight:host.right,text:t.buffer.active.getLine(0).translateToString(true)};
    });
    assert(edge.right<=edge.hostRight);assert(edge.text.endsWith('RIGHT_EDGE'));
    await page.mouse.wheel(-900,0); await pause(200); assert((await geometry()).left<initial.scrollWidth-initial.width);
    assert.equal(f.input().length,0,'Horizontal gestures never become terminal input');
    await page.setViewportSize({width:1500,height:900});await pause(300);
    assert((await geometry()).width>initial.width);
    await page.getByRole('button',{name:'会话列表',exact:true}).click();await pause(300);
    assert((await geometry()).width>1100);
    const paste=()=>page.locator('.terminal-host').evaluate(el=>{
      const data=new DataTransfer();data.items.add(new File([new Uint8Array([137,80,78,71])],'paste.png',{type:'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await page.locator('.image-pick').waitFor(); await paste();
    await page.waitForFunction(()=>!document.querySelector('.terminal-images .attachment')&&!document.querySelector('.image-pick').disabled);
    await pause(100);assert.equal(writes.length,1);assert.deepEqual(writes[0],{images:['test-image-1'],key:null});
    assert.equal(await page.getByRole('button',{name:'加入终端输入区',exact:true}).count(),0);
    fail=true;await paste();await page.getByRole('alert').waitFor();await pause(1200);
    assert.equal(writes.length,2,'Failed attachment is not automatically resent');
    assert.equal(await page.getByRole('button',{name:'加入终端输入区',exact:true}).count(),1,'Failure retains explicit recovery');
    f.tm('set-option', '-w', '-t', f.target, 'window-size', 'latest');
    await page.setViewportSize({width:1200,height:800});
    await page.waitForFunction(()=>document.querySelector('.terminal-host').terminal.cols<200);
    await pause(300);
    const fitted=await page.locator('.terminal-host').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,right:el.querySelector('.xterm-screen').getBoundingClientRect().right,hostRight:el.getBoundingClientRect().right}));
    assert(fitted.scrollWidth<=fitted.width+1, 'A pane that follows the browser fits without clipping or unnecessary horizontal overflow: '+JSON.stringify(fitted));
    assert(fitted.right<=fitted.hostRight);
    assert.deepEqual(errors,[]);
    console.log('PASS oversized real tmux pane: right edge reachable with horizontal wheel, resize/sidebar; clipboard image attaches once without click or Enter; failure is not retried');
  } finally {await browser?.close();await f.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
