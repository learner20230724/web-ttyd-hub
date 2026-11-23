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
    await page.getByRole('button',{name:'终端',exact:true}).click();
    const fits = () => {
      const host = document.querySelector('.terminal-host'), term = host?.terminal;
      if (!term || term.options.disableStdin || term.cols >= 300) return false;
      const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
      return screen.right <= host.getBoundingClientRect().right && host.scrollWidth <= host.clientWidth &&
        document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight;
    };
    await page.waitForFunction(fits);
    const columns = () => page.locator('.terminal-host').evaluate(host => host.terminal.cols);
    const original = await columns();
    async function checkLastColumn() {
      const cols = Number(f.tm('display-message', '-p', '-t', f.target, '#{pane_width}'));
      assert.equal(cols, await columns());
      f.output(`\x1b[2J\x1b[H\x1b[1;${cols-3}H末列`);
      await page.waitForFunction(() => {
        const t = document.querySelector('.terminal-host').terminal;
        return t.buffer.active.getLine(0).translateToString(true).endsWith('末列') &&
          t.buffer.active.getLine(0).getCell(t.cols - 2).getChars() === '列';
      });
      assert(await page.evaluate(fits));
    }
    await checkLastColumn();
    await page.setViewportSize({width:1500,height:900});
    await page.waitForFunction(old=>document.querySelector('.terminal-host').terminal.cols>old,original);
    await checkLastColumn();
    const beforeSidebar = await columns();
    await page.getByRole('button',{name:'会话列表',exact:true}).click();
    await page.waitForFunction(old=>document.querySelector('.terminal-host').terminal.cols>old,beforeSidebar);
    await checkLastColumn();
    const wideCols = await columns();
    const narrow = await browser.newPage({viewport:{width:900,height:760}});
    await narrow.goto(f.base); await narrow.locator('.session-card').click();
    await narrow.waitForFunction(fits);
    await page.waitForFunction(old=>document.querySelector('.terminal-host').terminal.cols<old,wideCols);
    await checkLastColumn(); assert(await narrow.evaluate(fits));
    await narrow.close();
    await page.waitForFunction(cols=>document.querySelector('.terminal-host').terminal.cols===cols,wideCols);
    await checkLastColumn();
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
    await page.setViewportSize({width:1200,height:800});
    await page.waitForFunction(()=>document.querySelector('.terminal-host').terminal.cols<200);
    await pause(300);
    const fitted=await page.locator('.terminal-host').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,right:el.querySelector('.xterm-screen').getBoundingClientRect().right,hostRight:el.getBoundingClientRect().right}));
    assert(fitted.scrollWidth<=fitted.width+1, 'A pane that follows the browser fits without clipping or unnecessary horizontal overflow: '+JSON.stringify(fitted));
    assert(fitted.right<=fitted.hostRight);
    assert.deepEqual(errors,[]);
    console.log('PASS oversized real tmux pane: last Chinese character visible without scrolling across two viewer sizes, resize/sidebar; clipboard image attaches once without click or Enter; failure is not retried');
  } finally {await browser?.close();await f.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
