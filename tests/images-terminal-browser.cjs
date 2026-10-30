const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, pause } = require('./terminal-fixture.cjs');
(async()=>{
 const f=await fixture();let browser;
 try {
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base);await page.locator('.session-card').click();
  await page.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
  // Real bytes travel through the private PTY, tmux control mode and production WS.
  f.output('\x1b[?1049h\x1b[2J\x1b[H\x1bP0;1q"1;1;96;48#0;2;100;0;0#1;2;0;0;100'+('#0!48~#1!48~-'.repeat(8))+'\x1b\\');
  await page.waitForFunction(()=>document.querySelector('.terminal-host').imageAddon.storageUsage>0);
  const pixels=await page.evaluate(()=>{
   const host=document.querySelector('.terminal-host'), b=host.terminal.buffer.active;
   for(let y=0;y<b.length;y++)for(let x=0;x<host.terminal.cols;x++){
    const c=host.imageAddon.getImageAtBufferCell(x,y);if(c){const g=c.getContext('2d');return {width:c.width,height:c.height,red:[...g.getImageData(10,10,1,1).data],blue:[...g.getImageData(70,10,1,1).data]};}
   }
  });
  assert.deepEqual(pixels,{width:96,height:48,red:[255,0,0,255],blue:[0,0,255,255]});
  // Canvas must actually paint, not only decode into addon memory.
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.xterm canvas')).some(c=>{const ctx=c.getContext('2d');if(!ctx)return false;const p=ctx.getImageData(0,0,c.width,c.height).data;for(let i=0;i<p.length;i+=4)if(p[i]===255&&p[i+1]===0&&p[i+2]===0&&p[i+3]===255)return true;return false;}));
  f.output('\x1b[?1049l');await pause(100);assert.deepEqual(errors,[]);
  assert.equal(f.input().length,0,'Rendering images must not inject terminal queries or user input');
  console.log('PASS Sixel: actual tmux stream renders red/blue pixels on xterm canvas; no duplicate replies.');
 }finally{await browser?.close();await f.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
