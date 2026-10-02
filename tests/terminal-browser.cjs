// Run against an isolated build: HUB_PUBLIC_DIR=/tmp/hub-build node tests/terminal-browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { fixture, until, pause } = require('./terminal-fixture.cjs');
const state = () => {
  const t = document.querySelector('.terminal-host').terminal, b = t.buffer.active;
  return { type: b.type, base: b.baseY, viewport: b.viewportY, cols: t.cols, rows: t.rows,
    text: Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n'), cursorX:b.cursorX, cursorY:b.cursorY };
};
(async () => {
  const f = await fixture();
  let browser;
  const failures = [];
  try {
    f.output('\x1b[2J\x1b[H' + Array.from({length:600},(_,i)=>`ROW_${String(i).padStart(4,'0')} 中文输出 \x1b[31mRED\x1b[0m\r\n`).join('') + '\x1b[?2004h');
    await until(()=>Number(f.tm('display-message','-p','-t',f.target,'#{history_size}'))>550);
    browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
    async function page() {
      const p = await browser.newPage({viewport:{width:1200,height:800}});
      p.on('pageerror', error => failures.push(error.message));
      await p.goto(f.base);
      await p.locator('.session-card').click();
      await p.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
      return p;
    }
    const a=await page(), b=await page();
    await a.waitForFunction(()=>document.querySelector('.terminal-host').terminal.buffer.active.baseY>500);
    const initial=await a.evaluate(state);
    assert.equal(initial.type,'normal');
    assert(initial.text.includes('ROW_0000')&&initial.text.includes('ROW_0599'));
    assert.equal(await a.locator('.history-toggle,.history-panel,iframe').count(),0);
    const red=await a.evaluate(()=>{
      const t=document.querySelector('.terminal-host').terminal,buf=t.buffer.active;
      for(let i=0;i<buf.length;i++) { const line=buf.getLine(i); for(let c=0;c<t.cols;c++) {
        const cell=line.getCell(c);if(cell.getChars()==='R'&&cell.getFgColor()===1)return true;
      }}return false;
    });
    assert(red,'ANSI foreground color restored');
    const second=await b.evaluate(state);
    await a.bringToFront();await a.locator('.xterm-screen').hover();await a.mouse.wheel(0,-750);await a.waitForTimeout(250);
    const scrolled=await a.evaluate(state);
    assert(scrolled.viewport<initial.viewport, JSON.stringify({initial:{base:initial.base,viewport:initial.viewport},scrolled:{base:scrolled.base,viewport:scrolled.viewport}}));
    assert.equal((await b.evaluate(state)).viewport,second.viewport);
    assert.equal(f.input().length,0,'Wheel must not inject Up/Down or enter copy mode');
    assert.equal(f.tm('display-message','-p','-t',f.target,'#{pane_in_mode}'),'0');
    f.output('LIVE_AFTER_SCROLL\r\n');
    await a.waitForFunction(()=>{
      const b=document.querySelector('.terminal-host').terminal.buffer.active;
      return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n').includes('LIVE_AFTER_SCROLL');
    });
    assert.equal((await a.evaluate(state)).viewport,scrolled.viewport,'Live output must not jump a reader to the bottom');
    await a.bringToFront();await a.locator('.xterm-helper-textarea').focus();
    await a.keyboard.type('xyz');await until(()=>f.input().toString()==='xyz');
    await a.waitForTimeout(150);
    assert.equal((await a.evaluate(state)).viewport,(await a.evaluate(state)).base);
    await a.evaluate(()=>document.querySelector('.terminal-host').terminal.scrollToTop());
    const cdp=await a.context().newCDPSession(a);
    await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});
    await cdp.send('Input.insertText',{text:'中文输入'});
    await until(()=>f.input().toString()==='xyz中文输入');
    const pasted='粘贴第一行\nsecond line';
    await a.locator('.terminal-host').evaluate((el,text)=>{
      const data=new DataTransfer();data.setData('text/plain',text);
      el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    },pasted);
    const expected='xyz中文输入\x1b[200~'+pasted.replaceAll('\n','\r')+'\x1b[201~';
    await until(()=>f.input().toString()===expected);
    await a.evaluate(()=>{const t=document.querySelector('.terminal-host').terminal;t.scrollToTop();t.select(0,0,8)});
    await a.keyboard.press('Control+c');await pause(100);
    assert.equal(f.input().toString(),expected,'Copy must not send Ctrl+C');
    assert((await a.evaluate(state)).viewport < (await a.evaluate(state)).base);
    // tmux already handles terminal queries; no duplicate reply may reach the PTY.
    f.output('\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\');
    await pause(200);
    const queryInput=f.input();
    const cursorReports=queryInput.toString().match(/\x1b\[\d+;\d+R/g)||[];
    assert.equal(cursorReports.length,1,'Only tmux may answer the cursor-position query');
    await b.reload();await b.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
    const restored=await b.evaluate(state);
    assert(restored.text.includes('ROW_0000')&&restored.text.includes('LIVE_AFTER_SCROLL'));
    // Output around the snapshot/live hand-off is neither dropped nor duplicated.
    const producer=(async()=>{
      for(let i=0;i<1000;i+=20) {
        f.output(Array.from({length:20},(_,j)=>`CONTINUOUS_${String(i+j).padStart(4,'0')}\r\n`).join(''));
        await pause(8);
      }
    })();
    await b.reload();await b.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
    await producer;
    await b.waitForFunction(()=>{
      const b=document.querySelector('.terminal-host').terminal.buffer.active;
      return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n').includes('CONTINUOUS_0999');
    });
    const continuous=(await b.evaluate(state)).text;
    for(let i=0;i<1000;i++) assert.equal(continuous.split(`CONTINUOUS_${String(i).padStart(4,'0')}`).length-1,1);
    // Simulate losing the observer connection while the PTY keeps running.
    const clients=f.tm('list-clients','-F','#{client_name}').split('\n').filter(Boolean);
    for(const client of clients) f.tm('detach-client','-t',client);
    await b.locator('.connection-status').waitFor();
    await b.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
    assert((await b.evaluate(state)).text.includes('CONTINUOUS_0999'));
    // A full-screen app and its saved normal history survive reconnect/exit.
    f.output('\x1b[?1049h\x1b[2J\x1b[HEDITOR_SCREEN\x1b[3;8H');
    await b.waitForFunction(()=>document.querySelector('.terminal-host').terminal.buffer.active.type==='alternate');
    await b.reload();await b.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
    let alt=await b.evaluate(state);
    assert.equal(alt.type,'alternate');assert(alt.text.includes('EDITOR_SCREEN'));assert.equal(alt.cursorX,7);assert.equal(alt.cursorY,2);
    f.output('\x1b[?1049l');
    await b.waitForFunction(()=>document.querySelector('.terminal-host').terminal.buffer.active.type==='normal');
    assert((await b.evaluate(state)).text.includes('LIVE_AFTER_SCROLL'));
    assert.equal(f.tm('display-message','-p','-t',f.target,'#{pane_pid}'),f.pid);
    // Mobile keeps its existing independent reader and never attaches this desktop stream.
    const phone=await browser.newPage({viewport:{width:412,height:915},isMobile:true,hasTouch:true});
    await phone.goto(f.base);await phone.locator('.session-card').click();
    assert.equal(await phone.locator('.terminal-host').count(),0);
    await phone.getByRole('button',{name:'显示执行过程'}).waitFor();
    await phone.close();
    const cols=Number(f.tm('display-message','-p','-t',f.target,'#{pane_width}'));
    f.output('\x1b[2J\x1b[H\x1b[31m'+'X'.repeat(cols-2)+'中'+'\x1b[0m');
    await until(()=>Number(f.tm('display-message','-p','-t',f.target,'#{cursor_x}'))===cols);
    await b.reload();await b.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
    f.output('Y');
    await b.waitForFunction(()=>document.querySelector('.terminal-host').terminal.buffer.active.cursorY===1);
    const wrapped=await b.evaluate(()=>{
      const t=document.querySelector('.terminal-host').terminal,buf=t.buffer.active;
      return { first:buf.getLine(buf.baseY).translateToString(true), second:buf.getLine(buf.baseY+1).translateToString(true), color:buf.getLine(buf.baseY).getCell(t.cols-2).getFgColor() };
    });
    assert.equal(wrapped.first,'X'.repeat(cols-2)+'中');assert.equal(wrapped.second,'Y');assert.equal(wrapped.color,1);
    // Synthetic, non-private terminal content for the public project preview.
    if(process.env.HUB_TERMINAL_SCREENSHOT) {
      f.output('\r\n\x1b[1;32mWeb TTYd Hub — 浏览器独立滚动\x1b[0m\r\n\r\n  ✓ 在终端中直接上下滚动，保留颜色与代码格式\r\n  ✓ 多窗口各自阅读，任务继续运行\r\n  ✓ 中文输入、复制、多行粘贴与断线重连\r\n');
      await b.evaluate(()=>document.querySelector('.terminal-host').terminal.scrollToBottom());
      await pause(200);await b.screenshot({path:process.env.HUB_TERMINAL_SCREENSHOT});
    }
    assert.deepEqual(failures,[]);
    console.log('PASS: native scroll, independent viewers, live output, color, IME, paste, copy, reconnect, terminal queries, alternate screen, mobile reader and process survival');
  } finally { await browser?.close();await f.cleanup(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
