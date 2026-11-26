// Actual installed Codex, private tmux, synthetic local model: no user sessions or credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { workbookTurn, checkFileDrafts } = require('./fixtures/file-turn.cjs');
const express = require('express');
const { chromium } = require('playwright');
const { CodexRpc } = require('../server/services/codex-rpc');
const filesOnly = process.argv.includes('--files');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for(let i=0;i<400;i++){const v=await check();if(v)return v;await pause(100);}throw Error('Image integration timed out'); }
let root, model, initial, rpc, tm, manager, server, wss, streams, browser;
(async()=>{
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-image-codex-'));
  const home=path.join(root,'codex'), project=path.join(root,'project');
  await fs.mkdir(home);await fs.mkdir(project);
  let requests=0, sawImage=false, submittedImages=[], lastUserInput=[];
  const viewed=path.join(project,'截图.png');
  model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url!='/v1/responses'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
    const body=JSON.parse(Buffer.concat(chunks).toString()); requests++;
    lastUserInput = (body.input || []).filter(item => item.role === 'user').at(-1)?.content || [];
    if (requests === 2) submittedImages = (body.input || []).filter(m => m.role === 'user')
      .flatMap(m => m.content || []).filter(c => c.type === 'input_image').map(c => c.image_url);
    sawImage ||= (body.input || []).some(item=>item.role==='user' && item.content?.some(c=>c.type==='input_image' && c.image_url?.startsWith('data:image/')));
    const item=workbookTurn(body, lastUserInput, root) || (requests===2 ? {type:'function_call',name:'view_image',call_id:'actual-view',id:'view-item',arguments:JSON.stringify({path:viewed})} : {type:'message',role:'assistant',id:`reply-${requests}`,content:[{type:'output_text',text:sawImage?'图片已作为视觉输入收到。红色方块在左，蓝色方块在右。':filesOnly ? '请选择示例报价表。' : '图片测试准备完成。\n'+Array.from({length:160},(_,i)=>`SCROLL_CONTEXT_${String(i).padStart(3, '0')} 合成上下文`).join('\n'),annotations:[]}]});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:`r-${requests}`,status:'in_progress',output:[]}}, {type:'response.output_item.added',output_index:0,item}, {type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response:{id:`r-${requests}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }).listen(0,'127.0.0.1');await once(model,'listening');
  await fs.writeFile(path.join(home,'config.toml'),`model = "fixture-model"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\nin_app_updates = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const env={...process.env,CODEX_HOME:home,TMUX_TMPDIR:root,XDG_RUNTIME_DIR:root,HUB_IMAGE_DIR:path.join(root,'images')};
  for(const key of ['TMUX','TMUX_PANE','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[key];
  const socket=path.join(root,'initial.sock');
  initial=spawn('codex',['app-server','--listen',`unix://${socket}`],{env,stdio:'ignore'});
  await until(()=>fs.stat(socket).then(s=>s.isSocket(),()=>false));
  rpc=new CodexRpc();const events=[];rpc.on('message',m=>events.push(m));await rpc.connect(socket);
  const {thread}=await rpc.call('thread/start',{cwd:project,model:'fixture-model',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only',environments:[]});
  await rpc.call('thread/name/set',{threadId:thread.id,name:filesOnly ? '文件对话示例' : '图片链路验证'});
  await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text:filesOnly ? '我想核对报价表。' : '准备图片测试',text_elements:[]}]});
  await until(()=>events.some(m=>m.method==='turn/completed'));rpc.close();initial.kill();await once(initial,'exit');
  Object.assign(process.env,env);delete process.env.TMUX;delete process.env.TMUX_PANE;
  tm=(...args)=>execFileSync('tmux',args,{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trimEnd();
  tm('new-session','-d','-s','image-test','-x','120','-y','40','-c',project,'codex','resume',thread.id,'--yolo');
  const SessionManager=require('../server/services/session-manager');
  manager=new SessionManager(19000,19001);
  const session={name:'image-test',displayName:filesOnly ? '文件对话示例' : '图片链路验证',createdAt:new Date().toISOString(),shell:'codex',cwd:project,status:'running'};
  manager.sessions.set(session.name,session);
  await until(()=>session.activity?.available);
  const app=express();app.use(express.json());app.use('/api/sessions',require('../server/routes/sessions')(manager));app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname,'../server/public')));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');wss=require('../server/ws')(server,manager);streams=require('../server/services/terminal-stream').setupTerminalStreams(server,manager);
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:412,height:915},isMobile:true,hasTouch:true}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('.session-card').click();await page.locator('.message').first().waitFor();
  if (filesOnly) {
    const desktop = await browser.newPage({ viewport: { width: 1150, height: 720 } });
    await desktop.goto(base);
    await desktop.locator('.session-card').click();
    const fullTab = desktop.getByRole('button', { name: '全文', exact: true });
    await checkFileDrafts({ page, desktop, fullTab, requests: () => requests });
    console.log('PASS file choice, removal, restored draft, real Codex tool reads XLSX B2, desktop terminal file choice');
    return;
  }
  const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const x=c.getContext('2d');x.fillStyle='#f35d60';x.fillRect(0,0,160,160);x.fillStyle='#38a9ed';x.fillRect(160,0,160,160);return c.toDataURL('image/png').split(',')[1];}),'base64');
  await fs.writeFile(viewed,png);
  const discarded = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  const addDiscarded = () => page.locator('.image-file-input').setInputFiles({ name:'删除这张.png', mimeType:'image/png', buffer:discarded });
  const removeDiscarded = page.getByRole('button',{name:'移除图片 删除这张.png'});
  await addDiscarded();
  await removeDiscarded.waitFor();
  // Upgrade a cached draft from the previous release, which only knew the
  // input order. Opening it again must expose a working remove button.
  await page.addInitScript(() => {
    const key = Object.keys(localStorage).find(k => k.includes('web-ttyd-hub.drafts.v1'));
    if (!key) return;
    const drafts = JSON.parse(localStorage.getItem(key));
    for (const [, draft] of drafts) for (const image of draft.images) {
      delete image.slot; delete image.count; delete image.handle;
    }
    localStorage.setItem(key, JSON.stringify(drafts));
  });
  await page.reload();
  await removeDiscarded.click();
  await removeDiscarded.waitFor({state:'detached'});
  assert(!tm('capture-pane','-p','-t','=image-test:').includes('[Image #1]'), 'Single attachment is removed from live composer');
  await addDiscarded();
  await removeDiscarded.waitFor();
  // Android document providers can return a real image with a generic MIME.
  // Hold the HTTP transfer to check the visible draft before any server reply.
  let releaseTransfer;
  const transfer = new Promise(resolve => { releaseTransfer = resolve; });
  await page.route('**/image-test/images', async route => { await transfer; await route.continue(); });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加图片' }).click();
  await (await chooser).setFiles({name:'相册图片',mimeType:'application/octet-stream',buffer:png});
  try {
    await page.waitForFunction(() => document.querySelector('.mobile-image-drafts img[src^="blob:"]')?.naturalWidth > 0);
    assert(await page.locator('button.send').isDisabled());
    assert.equal(requests, 1, 'Picking alone must not send a message');
  } finally { releaseTransfer(); }
  await page.waitForFunction(() => document.querySelector('.mobile-image-drafts img[src*="/images/"]')?.naturalWidth > 0);
  await until(() => tm('capture-pane','-p','-t','=image-test:').includes('[Image #1]'));
  assert.equal(requests, 1, 'Mobile selection inserts into Codex without sending Enter');
  assert.equal(await page.getByRole('button', { name:'发送', exact:true }).count(), 0);
  await until(() => tm('capture-pane','-p','-t','=image-test:').includes('[Image #2]'));
  await page.getByRole('textbox',{name:'消息输入'}).fill('手机草稿保留');
  tm('send-keys', '-t', '=image-test:', '-l', 'KEEP');
  await until(() => tm('capture-pane','-p','-t','=image-test:').includes('KEEP'));
  await removeDiscarded.click();
  await removeDiscarded.waitFor({state:'detached'});
  const afterRemoval = tm('capture-pane','-p','-t','=image-test:');
  assert(afterRemoval.includes('[Image #1]') && !afterRemoval.includes('[Image #2]') && afterRemoval.includes('KEEP'));
  assert.equal(await page.getByRole('textbox',{name:'消息输入'}).inputValue(), '手机草稿保留');
  assert.equal(requests, 1);
  tm('send-keys', '-t', '=image-test:', 'End', 'C-w');
  await until(() => !tm('capture-pane','-p','-t','=image-test:').split('\n').some(line => line.startsWith('›') && /K/.test(line)));
  // A keyboard clipboard may expose a File only via its items list.
  const pastedImage = page.waitForResponse(r => r.url().endsWith('/image-test/images') && r.request().method() === 'POST');
  await page.locator('textarea').evaluate((el, bytes) => {
    const event = new Event('paste', { bubbles:true, cancelable:true });
    const file = new File([new Uint8Array(bytes)], '粘贴图片', {type:''});
    Object.defineProperty(event, 'clipboardData', {value:{files:[],items:[{getAsFile:()=>file}]}});
    el.dispatchEvent(event);
  }, [...png]);
  assert.equal((await pastedImage).status(), 200);
  await page.waitForFunction(() => !document.querySelector('button.send').disabled);
  assert.equal(await page.locator('.mobile-image-drafts .attachment').count(), 1, 'Pasting the same bytes deduplicates the attachment');
  assert.equal(await page.locator('.composer .image-pick').count(),0);
  const pick=await page.locator('.mobile-session-header .image-pick').boundingBox(), title=await page.locator('.mobile-title-row').boundingBox();
  assert(pick && pick.y >= title.y && pick.y + pick.height <= title.y + title.height + 1, 'Image picker belongs in title row');
  assert(!tm('capture-pane','-p','-t','=image-test:').includes('[Image #2]'));
  const submit = page.waitForRequest(r => r.url().endsWith('/image-test/input') && r.postDataJSON().key === 'Enter');
  await page.getByRole('textbox',{name:'消息输入'}).fill('请分析这张截图');await page.getByRole('button',{name:'发送',exact:true}).click();
  assert.equal((await submit).postDataJSON().images, undefined, 'Submitting text does not insert an attached image twice');
  await until(()=>sawImage);
  assert.equal(submittedImages.length, 1);
  assert(await page.evaluate(async url => {
    const img = new Image(); img.src = url; await img.decode();
    return img.naturalWidth > 1 && img.naturalWidth === img.naturalHeight * 2;
  }, submittedImages[0]), 'Only the selected 320×160 image remains in the actual model request');
  await page.locator('.message.assistant').filter({hasText:'图片已作为视觉输入收到'}).waitFor({timeout:20000});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.user .image-preview img')).some(i=>i.complete&&i.naturalWidth>0));
  assert.equal(await page.locator('.attachment').count(),0);
  assert.equal(await page.locator('.pending-message').count(),0, 'Accepted image prompt clears the pending receipt');
  // Persisted tool events use the same image formats as Codex 0.166; no extra model request.
  const state=manager.activity.states.get(session.name);assert(state.path);
  
  const desktop=await browser.newPage({viewport:{width:1100,height:760}});
  desktop.on('pageerror',e=>errors.push(e.message));
  await desktop.goto(base); await desktop.locator('.session-card').click();
  const answerTab = desktop.getByRole('button',{name:'回答',exact:true});
  const fullTab = desktop.getByRole('button',{name:'全文',exact:true});
  assert.equal(await desktop.getByRole('button',{name:'方向键与回车'}).count(),0);
  const replyImages = desktop.locator('.mobile-reading[data-view="answer"] .message.assistant .image-preview img');
  await replyImages.first().waitFor({timeout:6000});
  assert.equal(await answerTab.getAttribute('aria-pressed'),'true');
  assert.equal(await desktop.locator('.terminal-host').count(),0);
  await until(() => replyImages.first().evaluate(img=>img.naturalWidth===320));
  // A distinct generated result must appear live in its own conversation row.
  const generated = await page.evaluate(() => {
    const c=document.createElement('canvas'); c.width=73; c.height=41;
    const ctx=c.getContext('2d');ctx.fillStyle='#23a95d';ctx.fillRect(0,0,73,41);
    return c.toDataURL('image/png').split(',')[1];
  });
  await fs.appendFile(state.path,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'image_generation_end',call_id:'fixture-generate',status:'completed',result:generated}})+'\n');
  await until(()=>manager.activity.messages(session.name).filter(m=>m.phase==='image').length===2);
  await page.waitForFunction(()=>document.querySelectorAll('.message .image-preview img').length===3);
  await page.reload();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message .image-preview img')).filter(i=>i.complete&&i.naturalWidth>0).length===3);
  const photo=page.locator('.message .image-preview img').last();
  const source=await photo.getAttribute('src');
  const checkLatest = async () => {
    await until(()=>replyImages.count().then(n=>n===2));
    await until(()=>replyImages.last().evaluate(img=>img.complete && img.naturalWidth===73 && img.naturalHeight===41));
    assert.equal(await replyImages.last().getAttribute('src'),source);
  };
  await checkLatest();
  const wrongGeneration = new URL(source,base); wrongGeneration.searchParams.set('generation','replaced');
  const miss = await desktop.request.get(wrongGeneration.href);
  assert.equal(miss.status(),404); assert.equal(miss.headers()['cache-control'],'no-store');
  // A failed inline transfer can be retried without sending a message.
  await desktop.route(new URL(source,base).href,route=>route.abort(),{times:1});
  await desktop.reload(); await desktop.getByRole('button',{name:'重新加载图片'}).click();
  await until(()=>replyImages.last().evaluate(img=>img.naturalWidth===73));
  await desktop.reload(); await checkLatest();
  await replyImages.last().click();
  const enlarged=desktop.locator('.image-viewer[open] img');
  await enlarged.waitFor();
  assert.deepEqual(await enlarged.evaluate(async img=>{
    await img.decode();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    ctx.drawImage(img,0,0);return [...ctx.getImageData(1,1,1,1).data];
  }),[35,169,93,255]);
  await desktop.keyboard.press('Escape');await enlarged.waitFor({state:'detached'});
  await photo.click();await page.locator('.image-viewer[open] img').waitFor();await page.getByRole('button',{name:'关闭图片 ×'}).last().click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const reader = desktop.locator('.mobile-reading');
  const input = desktop.getByRole('textbox',{name:'消息输入'});
  // Pasting with focus still on the conversation (outside the textarea)
  // attaches once, and removing it must leave the next model request untouched.
  await desktop.evaluate(bytes=>{
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)],'桌面粘贴.png',{type:'image/png'}));
    document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },[...png]);
  const remove = desktop.getByRole('button',{name:'移除图片 桌面粘贴.png'});
  await remove.click(); await remove.waitFor({state:'detached'});

  await desktop.context().grantPermissions(['clipboard-read','clipboard-write']);
  await input.fill('前替换后');
  await input.evaluate(el => el.setSelectionRange(1,3));
  await reader.click({position:{x:6,y:6}});
  await desktop.evaluate(() => navigator.clipboard.writeText('粘贴中文\nsecond line'));
  await desktop.keyboard.press('Control+v');
  assert.equal(await input.inputValue(),'前粘贴中文\nsecond line后');
  assert(await input.evaluate(el => document.activeElement === el));
  await reader.click({button:'right',position:{x:24,y:12}});
  const nativePaste = desktop.getByRole('textbox',{name:'粘贴到消息输入框'});
  assert(await nativePaste.evaluate(el => el === document.activeElement));
  await desktop.keyboard.press('Escape');
  await input.fill('保留桌面草稿');
  await input.press('Shift+Enter');
  assert.equal(await input.inputValue(),'保留桌面草稿\n');
  await reader.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await reader.hover(); await desktop.mouse.wheel(0,-120);
  await desktop.getByRole('button',{name:'↓ 回到最新'}).waitFor();
  const top = await reader.evaluate(el=>el.scrollTop);
  await fullTab.click();
  await desktop.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
  assert.equal(await fullTab.getAttribute('aria-pressed'),'true');
  assert.equal(await replyImages.count(),0);
  await answerTab.click();
  await checkLatest();
  assert.equal(await input.inputValue(),'保留桌面草稿\n');
  await until(()=>reader.evaluate((el,top)=>Math.abs(el.scrollTop-top)<2,top));
  await desktop.getByRole('button',{name:'↓ 回到最新'}).click();
  if(process.env.HUB_IMAGES_SCREENSHOT)await desktop.screenshot({path:process.env.HUB_IMAGES_SCREENSHOT});
  await fullTab.click();
  await desktop.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
  assert.equal(await desktop.locator('.terminal-images .image-preview').count(),0);
  await desktop.locator('.xterm-helper-textarea').focus();
  await desktop.keyboard.type('KEEP_DRAFT');
  await until(()=>tm('capture-pane','-p','-t','=image-test:').includes('KEEP_DRAFT'));
  await answerTab.click();
  assert.equal(await input.inputValue(),'保留桌面草稿\n');
  await input.fill('');
  await fullTab.click();
  await desktop.waitForFunction(()=>{
    const t=document.querySelector('.terminal-host')?.terminal, b=t?.buffer.active;
    return t?.options.disableStdin===false && Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)).some(row=>row?.includes('KEEP_DRAFT'));
  });
  await desktop.locator('.xterm-helper-textarea').focus();
  await desktop.keyboard.press('Control+u');
  const screenText = () => desktop.evaluate(() => { const t=document.querySelector('.terminal-host').terminal,b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n'); });
  const paragraph = '自动换行验证开始' + '桌面终端应根据窗口宽度显示整段中文。'.repeat(5) + '验证结束';
  await desktop.locator('.xterm-helper-textarea').focus();
  await desktop.keyboard.insertText(paragraph);
  for (const width of [1100, 930, 1330]) {
    await desktop.setViewportSize({width,height:760});
    await until(async () => {
      const visible = await desktop.locator('.terminal-host').evaluate(host => {
        const term=host.terminal, buffer=term.buffer.active;
        return {
          rows:Array.from({length:term.rows}, (_,i)=>buffer.getLine(buffer.viewportY+i)?.translateToString(true) || ''),
          fits:host.querySelector('.xterm-screen').getBoundingClientRect().right <= host.getBoundingClientRect().right
        };
      });
      const text=visible.rows.join('').replace(/\s/g,'');
      return visible.fits && text.includes(paragraph) && !visible.rows.some(row=>row.includes(paragraph));
    });
  }
  await desktop.keyboard.press('Control+u');
  await desktop.setViewportSize({width:1100,height:760});
  await desktop.locator('.xterm-helper-textarea').focus();await desktop.keyboard.type('UNSENT_WHEEL_DRAFT');
  await until(async () => (await screenText()).includes('UNSENT_WHEEL_DRAFT'));
  const firstVisibleRow = async () => Number((await screenText()).match(/SCROLL_CONTEXT_(\d+)/)?.[1]);
  const bottomRow = await firstVisibleRow();
  const smallDiagonal = deltaY => desktop.locator('.xterm-screen').evaluate((el, deltaY) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { deltaX:6, deltaY, clientX:box.left+40, clientY:box.top+40, bubbles:true, cancelable:true }));
  }, deltaY);
  await smallDiagonal(-4);
  await until(async () => (await firstVisibleRow()) < bottomRow);
  await smallDiagonal(4);
  await until(async () => (await firstVisibleRow()) === bottomRow);
  const beforeWheel=await screenText();
  await desktop.locator('.xterm-screen').hover();await desktop.mouse.wheel(0,-720);await pause(600);
  const afterWheel=await screenText();
  assert.notEqual(afterWheel,beforeWheel,'Fullscreen Codex must scroll its actual transcript when tmux mouse is off');
  assert((await firstVisibleRow()) < bottomRow,'Wheel exposes earlier conversation');
  assert(afterWheel.includes('UNSENT_WHEEL_DRAFT'),'Wheel preserves the unsent prompt');
  // Small fractional deltas, typical of a Mac trackpad, accumulate into wheel reports.
  await desktop.locator('.xterm-screen').evaluate(el=>{const r=el.getBoundingClientRect();for(let i=0;i<80;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:-2.5,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));});
  await pause(500);assert.notEqual(await screenText(),afterWheel,'Trackpad-sized deltas scroll too');
  for (let attempt=0; attempt<8 && (await firstVisibleRow())!==0; attempt++) {
    await desktop.mouse.wheel(0,-2400);
    await pause(120);
  }
  assert.equal(await firstVisibleRow(),0,'The first of 160 context lines is reachable from the most recent screen');
  for (let attempt=0; attempt<8 && (await firstVisibleRow())!==bottomRow; attempt++) {
    await desktop.mouse.wheel(0,2400);
    await pause(120);
  }
  assert.equal(await firstVisibleRow(),bottomRow);
  await desktop.keyboard.press('Control+u');
  await desktop.context().grantPermissions(['clipboard-read','clipboard-write']);
  await desktop.evaluate(async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]),[...png]);
  const attached = desktop.waitForResponse(r=>r.url().endsWith('/image-test/input') && r.request().method()==='POST');
  await desktop.locator('.xterm-helper-textarea').focus();await desktop.keyboard.press('Control+v');
  const attachmentResponse = await attached;
  assert.equal(attachmentResponse.status(),200);
  assert.equal(attachmentResponse.request().postDataJSON().key,null);
  assert.equal(await desktop.getByRole('button',{name:'加入终端输入区',exact:true}).count(),0);
  await desktop.locator('.attachment').waitFor({state:'detached'});
  assert(!tm('capture-pane','-p','-t','=image-test:').includes('Failed to paste image'),'Ctrl+V must not invoke the server clipboard');
  assert(tm('capture-pane','-p','-t','=image-test:').includes('[Image #1]'),'Desktop paste attaches an image to the actual Codex composer without Enter');
  assert.deepEqual(errors,[]);assert.equal(requests,3,'One image prompt and one tool-result continuation; no extra model calls');
  // Inspect the painted transcript after submitting, as well as the editable draft.
  const submitted = process.env.HUB_WRAP_SAMPLE || paragraph;
  await desktop.keyboard.insertText(submitted);
  // Codex can absorb Enter into a still-buffered input burst. Submit after
  // the PTY has actually echoed the complete draft back to the browser.
  await until(async () => (await screenText()).replace(/\s/g, '').includes(submitted.replace(/\s/g, '')));
  await desktop.keyboard.press('Enter');
  await until(()=>requests>3);
  for (const width of [1100, 930, 1330]) {
    await desktop.setViewportSize({width,height:760});
    await pause(350);
    await until(()=>desktop.locator('.terminal-host').evaluate((host, sample)=>{
      const rows = Array.from(host.querySelectorAll('.xterm-rows > div'));
      const bounds = host.querySelector('.xterm-screen').getBoundingClientRect();
      const text = rows.map(row => row.textContent).join('').replace(/\s/g, '');
      if (!text.includes(sample.replace(/\s/g, ''))) return false;
      for (const row of rows) {
        const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
        for(let node; (node=walker.nextNode());) {
          const end=node.textContent.trimEnd().length;
          if(!end) continue;
          const glyph=document.createRange();
          glyph.setStart(node,end-1); glyph.setEnd(node,end);
          if(glyph.getBoundingClientRect().right > bounds.right+1) return false;
        }
      }
      return bounds.right <= host.getBoundingClientRect().right && host.scrollLeft === 0;
    },submitted));
  }
  // A screenshot and an immediate Enter must reach Codex as one image turn,
  // even with the clipboard focus on the toolbar and the upload held in flight.
  for (const tab of [answerTab, fullTab]) {
    await tab.click();
    if (tab === answerTab) await input.fill('');
    else await desktop.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    await desktop.locator('.toolbar-title').click();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await desktop.route('**/image-test/images', async route => { await held; await route.continue(); }, {times:1});
    const before = requests;
    const upload = desktop.waitForRequest(r => r.url().endsWith('/image-test/images') && r.method() === 'POST');
    try {
      await desktop.keyboard.press('Control+v');
      await upload;
      await desktop.keyboard.press('Enter');
      assert.equal(requests, before);
    } finally { release(); }
    await until(() => requests > before);
    assert.equal(requests, before + 1);
    assert.equal(lastUserInput.filter(item => item.type === 'input_image').length, 1);
  }
  console.log('PASS actual Codex receives one image turn after page-level paste and immediate Enter in Answer and Full');
  for (const tab of [answerTab, fullTab]) {
    const text = tab === answerTab ? '回答页粘贴第一行\n保留第二行' : '全文页粘贴第一行\n保留第二行';
    await tab.click();
    if (tab === answerTab) await input.waitFor();
    else await desktop.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    await desktop.locator('.toolbar-title').click();
    await desktop.evaluate(value => navigator.clipboard.writeText(value), text);
    const before = requests;
    await desktop.keyboard.press('Control+v');
    await desktop.keyboard.press('Enter');
    await until(() => requests > before);
    assert(lastUserInput.some(item => item.type === 'input_text' && item.text === text));
    assert.equal(requests, before + 1);
  }
  console.log('PASS mobile removal: restored legacy and single attachments, first of two, phone and terminal text retained, only the intended image delivered');
  console.log('PASS submitted CJK transcript: complete rendered text and visible rightmost glyphs at three viewport widths');
  console.log('PASS fullscreen wheel + fractional trackpad deltas preserve drafts without model input');
  console.log('PASS desktop Answer and Full: inline reply pixels match phone, reload and retry, chronological messages, draft and scroll restoration, interactive terminal');
  console.log('PASS actual Codex: PNG upload -> image attachment -> model input_image; real view_image and generated-event previews; reload and desktop/mobile image rendering.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  await browser?.close();streams?.close();wss?.clients.forEach(c=>c.terminate());wss?.close();manager?.cleanup();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rpc?.close();initial?.kill();if(tm)try{tm('kill-server');}catch{}
  if(model){model.closeAllConnections();await new Promise(r=>model.close(r));}
  if(root)for(const pid of await fs.readdir('/proc')) {
    if(!/^\d+$/.test(pid))continue;
    try { const exe=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0')[0]; if(exe.startsWith(root+path.sep)&&exe.endsWith('/bin/codex'))process.kill(Number(pid),'SIGTERM'); } catch {}
  }
  await pause(300);if(root)await fs.rm(root,{recursive:true,force:true});
});
