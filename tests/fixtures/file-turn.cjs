// Local model fixture. Ask the actual Codex tool runner to open the selected
// workbook. The final answer is extracted exclusively from its tool result.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

function workbookTurn(body, content, root) {
  const prompt = content.find(item => item.type === 'input_text' && item.text.includes('附件文件（本机路径）'))?.text;
  if (!prompt) return null;
  const result = body.input.findLast(item => item.type === 'function_call_output' && item.call_id === 'workbook-read');
  if (result) {
    const value = /B2=(\d+)/.exec(JSON.stringify(result.output))?.[1];
    return { type: 'message', role: 'assistant', id: 'file-answer', content: [{ type: 'output_text', text: '报价表 B2 为 ' + (value || '读取失败'), annotations: [] }] };
  }
  const file = prompt.split('\n').find(line => line.endsWith('.xlsx'));
  assert(file?.startsWith(root + path.sep));
  const script = 'import sys,zipfile,xml.etree.ElementTree as ET; doc=ET.fromstring(zipfile.ZipFile(sys.argv[1]).read("xl/worksheets/sheet1.xml")); print("B2="+doc.find(".//{*}c[@r=\'B2\']/{*}v").text)';
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const cmd = 'python3 -c ' + quote(script) + ' ' + quote(file);
  const available = body.tools.flatMap(t => t.tools || [t]).map(t => t.name);
  let name = 'exec_command', args = { cmd };
  if (!available.includes(name)) {
    name = available.includes('shell_command') ? 'shell_command' : 'shell';
    args = { command: name === 'shell_command' ? cmd : ['sh', '-c', cmd] };
  }
  assert(available.includes(name), 'Missing command tool in local Codex fixture: ' + available.join(','));
  return { type: 'function_call', name, call_id: 'workbook-read', id: 'read-item', arguments: JSON.stringify(args) };
}

async function paste(tab, entries, target = 'textarea[aria-label="消息输入"]') {
  await tab.locator(target).evaluate((element, items) => {
    const data = new DataTransfer();
    for (const item of items) {
      // Reuse one block for the large-file boundary without a large JS array.
      const parts = item.mib ? Array(item.mib).fill(new Blob([new Uint8Array(1024 * 1024)])) : [];
      parts.push(new Uint8Array(item.bytes || []));
      data.items.add(new File(parts, item.name, { type: item.type || '' }));
    }
    data.setData('text/plain', 'clipboard file names must not be inserted as text');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, entries);
}

async function checkFileDrafts({ page, desktop, fullTab, requests }) {
  const select = async (tab, files) => {
    const chooser = tab.waitForEvent('filechooser');
    await tab.getByRole('button', { name: '上传文件', exact: true }).click();
    await (await chooser).setFiles(files);
  };
  const sample = { name: '示例 报价.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await fs.readFile(path.join(__dirname, 'quote.xlsx')) };
  const extra = { name: '移除我.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') };
  const before = requests();
  await select(page, [extra]);
  await page.getByRole('button', { name: '移除文件 ' + extra.name }).waitFor();
  await paste(page, [{ name: sample.name, type: 'application/octet-stream', bytes: [...sample.buffer] }]);
  await page.getByRole('button', { name: '移除文件 ' + sample.name }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '消息输入' }).inputValue(), '');
  const remove = page.getByRole('button', { name: '移除文件 ' + extra.name });
  await remove.click();
  await page.reload();
  await page.getByRole('button', { name: '移除文件 ' + sample.name }).waitFor();
  assert.equal(await remove.count(), 0);
  assert.equal(requests(), before, 'file selection, removal and reload cannot submit a turn');
  const uploads = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/files')) uploads.push(req.url()); });
  await paste(page, [{ name: 'too-large.bin', mib: 100, bytes: [1] }]);
  await page.getByRole('alert').filter({ hasText: '单个文件最大 100 MB' }).waitFor();
  assert.equal(uploads.length, 0);
  const atLimit = page.waitForResponse(res => res.url().includes('name=limit.bin'));
  await paste(page, [{ name: 'limit.bin', mib: 100 }]);
  const stored = await atLimit;
  assert.equal(stored.status(), 201);
  await page.getByRole('button', { name: '移除文件 limit.bin' }).waitFor();
  const savedSize = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.includes('web-ttyd-hub.drafts.v1'));
    return JSON.parse(localStorage.getItem(key)).flatMap(([, draft]) => draft.files || []).find(f => f.name === 'limit.bin').size;
  });
  assert.equal(savedSize, 100 * 1024 * 1024);
  const notes = Array.from({ length: 18 }, (_, i) => ({ name: 'note-' + i + '.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }));
  await select(page, notes);
  await page.getByRole('button', { name: '移除文件 note-17.txt' }).waitFor();
  assert.equal(await page.locator('.draft-file').count(), 20);
  await paste(page, [{ name: 'extra-21.txt', type: 'text/plain', bytes: [65] }]);
  await page.getByRole('alert').filter({ hasText: '一次最多添加 20 个文件' }).waitFor();
  assert.equal(uploads.length, 19, 'Rejected files never start an upload');
  const sending = page.waitForRequest(req => req.url().endsWith('/input') && req.postDataJSON().key === 'Enter');
  await page.getByRole('textbox', { name: '消息输入' }).fill('请读取报价表的 B2 单元格。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  assert.equal((await sending).postDataJSON().files.length, 20);
  await page.locator('article.message.assistant').filter({ hasText: '报价表 B2 为 7319' }).waitFor();
  await page.locator('.pending-message').waitFor({ state: 'detached' });
  const user = await page.locator('article.message.user').last().innerText();
  assert(user.includes('附件：' + sample.name) && !user.includes(extra.name) && !user.includes('本机路径'));
  await fullTab.click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  await desktop.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
  await paste(desktop, [{ name: sample.name, type: sample.mimeType, bytes: [...sample.buffer] },
    { name: '预览图', bytes: [...png] }], '.terminal-host');
  await desktop.getByRole('button', { name: '移除文件 ' + sample.name }).waitFor();
  await desktop.getByRole('button', { name: '移除图片 预览图' }).waitFor();
  await desktop.getByRole('textbox', { name: '消息输入' }).fill('请核对这份报价表。');
  if (process.env.HUB_FILES_SCREENSHOT) await desktop.screenshot({ path: process.env.HUB_FILES_SCREENSHOT });
  await desktop.getByRole('button', { name: '移除文件 ' + sample.name }).click();
  assert.equal(requests(), before + 2, 'One workbook turn plus its tool result');
}
module.exports = { workbookTurn, checkFileDrafts };
