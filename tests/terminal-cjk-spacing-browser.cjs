// The fixture font only supplies synthetic punctuation with the OpenType halt
// feature (1000-unit full advance, 500-unit half advance). This makes the
// repeated-punctuation measurement differ from prose even without Mac fonts.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { fixture } = require('./terminal-fixture.cjs');

const excerpt = '  我用截图里的原话重新发送，在三种浏览器宽度下逐字核对了显示结果，包括“不过可以根据我的浏览器”这一处。线上也验证了窗口从 1707 像素收窄到 1200 像素时，终端从';

async function verify(engine) {
  const f = await fixture();
  let browser;
  try {
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 1707, height: 985 }, deviceScaleFactor: 1.5 });
    await page.goto(f.base);
    await page.locator('.session-card').click();
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    const font = process.env.HUB_CJK_TEST_FONT || path.join(__dirname, 'fixtures/cjk-spacing.ttf');
    await page.route('**/fixture-font', route => route.fulfill({ path: font, contentType: 'application/octet-stream' }));
    await page.addStyleTag({ content: "@font-face {font-family: FixtureCJK; src: url('/fixture-font')}" });
    const metrics = await page.locator('.terminal-host').evaluate(async host => {
      const fonts = await document.fonts.load('15px FixtureCJK', '，。');
      if (!fonts.length) throw Error('Test font failed to load');
      host.terminal.options.fontFamily = '"Liberation Mono", FixtureCJK, monospace';
      const width = host.querySelector('.xterm-screen').getBoundingClientRect().width;
      return { cols: host.terminal.cols, cell: width / host.terminal.cols };
    });

    for (const cols of [157, 101]) {
      await page.setViewportSize({ width: Math.round(1707 + (cols - metrics.cols) * metrics.cell), height: 985 });
      await page.waitForFunction(n => document.querySelector('.terminal-host').terminal.cols === n, cols);
      const line = cols === 157 ? excerpt : '  ' + '窗口，宽度。'.repeat(8) + '从';
      f.output('\x1b[?1049h\x1b[2J\x1b[H' + line.slice(0, -1) + '\x1b[92m从\x1b[0m\r\n157 列调整为');
      const row = page.locator('.xterm-rows > div').first();
      await page.waitForFunction(s => document.querySelector('.xterm-rows > div')?.textContent === s, line);
      const edge = await row.evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el.lastElementChild);
        return { glyph: range.toString(), remaining: el.getBoundingClientRect().right - range.getBoundingClientRect().right,
          pageFits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight };
      });
      assert.equal(edge.glyph, '从');
      assert(edge.remaining >= -0.5, engine.name() + ': end glyph clipped by ' + (-edge.remaining) + ' CSS px at ' + cols + ' columns');
      assert(edge.pageFits);

      // Compare the painted glyph with the same glyph on an otherwise empty
      // reference row. DOM text alone still contains a clipped character.
      f.output('\x1b[3;5H\x1b[92m从\x1b[0m\x1b[4;1H');
      await page.waitForFunction(() => document.querySelectorAll('.xterm-rows > div')[2]?.textContent.includes('从'));
      const rows = page.locator('.xterm-rows > div');
      async function greenPixels(index) {
        const png = await rows.nth(index).screenshot({ scale: 'css' });
        return page.evaluate(async encoded => {
          const image = new Image(); image.src = 'data:image/png;base64,' + encoded;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i+1] > pixels[i]+32 && pixels[i+1] > pixels[i+2]+32) count++;
          }
          return count;
        }, png.toString('base64'));
      }
      const painted = await greenPixels(0), reference = await greenPixels(2);
      assert(reference > 8 && painted >= reference * 0.85, JSON.stringify({ painted, reference, cols }));
      console.log(engine.name(), cols, 'columns, trailing glyph margin', edge.remaining.toFixed(2), 'CSS px, painted pixels', painted, '/', reference);
    }
  } finally { await browser?.close(); await f.cleanup(); }
}

(async () => {
  for (const engine of [chromium, webkit]) await verify(engine);
})().catch(error => { console.error(error); process.exitCode = 1; });
