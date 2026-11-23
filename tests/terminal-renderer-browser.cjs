// Verify the accelerated and fallback renderers with a real PTY and WebGL2.
// CI has no physical GPU, so only the hardware eligibility probe is simulated.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture } = require('./terminal-fixture.cjs');

(async () => {
  const f = await fixture();
  let browser;
  try {
    browser = await chromium.launch({args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
    const page = await browser.newPage({ viewport:{ width:1200, height:760 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, options) {
        if (type !== 'webgl2' || !options?.failIfMajorPerformanceCaveat) return get.call(this, type, options);
        const gl = get.call(this, type, { ...options, failIfMajorPerformanceCaveat:false });
        if (!gl) throw Error('Test requires a WebGL2 implementation');
        const renderer = gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER;
        const parameter = gl.getParameter.bind(gl);
        gl.getParameter = key => key === renderer ? 'Test GPU' : parameter(key);
        return gl;
      };
    });
    await page.goto(f.base);
    await page.locator('.session-card').click();
    const host = page.locator('.terminal-host'), screen = host.locator('.xterm-screen');
    await page.waitForFunction(() => {
      const el = document.querySelector('.terminal-host');
      return el?.terminal?.options.disableStdin === false && !el.querySelector('.xterm-rows') &&
        [...el.querySelectorAll('canvas')].some(c => c.getContext('webgl2'));
    });
    async function paintedEdges() {
      const cols = await host.evaluate(el => el.terminal.cols);
      // The same green two-column glyph at each edge must paint completely.
      f.output(`\x1b[2J\x1b[H\x1b[38;2;0;255;0m图\x1b[1;${cols-1}H图\x1b[0m\x1b[2;1H`);
      await page.waitForFunction(cols => {
        const b = document.querySelector('.terminal-host').terminal.buffer.active;
        return b.getLine(b.viewportY)?.getCell(cols-2)?.getChars()==='图';
      }, cols);
      const image = (await screen.screenshot()).toString('base64');
      const counts = await page.evaluate(async ({image,cols}) => {
        const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,'+image)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap,0,0);
        const ink = x => {
          const pixels = ctx.getImageData(x,0,Math.ceil(2*canvas.width/cols),32).data;
          let count=0;
          for(let i=0;i<pixels.length;i+=4) if (pixels[i+1]>70 && pixels[i+1]>2*pixels[i]) count++;
          return count;
        };
        return [ink(0),ink(canvas.width-Math.ceil(2*canvas.width/cols))];
      }, {image,cols});
      assert(counts[0]>10 && Math.abs(counts[0]-counts[1])<counts[0]*0.2, JSON.stringify(counts));
    }
    await paintedEdges();
    const before = await host.evaluate(el=>el.terminal.cols);
    await page.setViewportSize({width:950,height:760});
    await page.waitForFunction(old=>document.querySelector('.terminal-host').terminal.cols<old,before);
    await paintedEdges();
    await screen.evaluate(el=>Array.from(el.querySelectorAll('canvas')).map(c=>c.getContext('webgl2')).find(Boolean).getExtension('WEBGL_lose_context').loseContext());
    await host.locator('.xterm-rows').waitFor();
    await paintedEdges();
    assert.deepEqual(errors,[]);
    console.log('PASS accelerated and DOM renderers paint the rightmost Chinese glyph across resize and GPU context loss');
  } finally { await browser?.close(); await f.cleanup(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
