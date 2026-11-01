// Actual installed Codex, private tmux, synthetic local model: no user sessions or credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require('playwright');
const { CodexRpc } = require('../server/services/codex-rpc');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for(let i=0;i<400;i++){const v=await check();if(v)return v;await pause(100);}throw Error('Image integration timed out'); }
let root, model, initial, rpc, tm, manager, server, wss, streams, browser;
(async()=>{
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-image-codex-'));
  const home=path.join(root,'codex'), project=path.join(root,'project');
  await fs.mkdir(home);await fs.mkdir(project);
  let requests=0, sawImage=false;
  const viewed=path.join(project,'截图.png');
  model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url!='/v1/responses'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
    const body=JSON.parse(Buffer.concat(chunks).toString()); requests++;
    sawImage ||= (body.input || []).some(item=>item.role==='user' && item.content?.some(c=>c.type==='input_image' && c.image_url?.startsWith('data:image/')));
    const item=requests===2 ? {type:'function_call',name:'view_image',call_id:'actual-view',id:'view-item',arguments:JSON.stringify({path:viewed})} : {type:'message',role:'assistant',id:`reply-${requests}`,content:[{type:'output_text',text:sawImage?'图片已作为视觉输入收到。红色方块在左，蓝色方块在右。':'图片测试准备完成。\n'+Array.from({length:160},(_,i)=>`SCROLL_CONTEXT_${String(i).padStart(3, '0')} 合成上下文`).join('\n'),annotations:[]}]};
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
  await rpc.call('thread/name/set',{threadId:thread.id,name:'图片链路验证'});
  await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'准备图片测试',text_elements:[]}]});
  await until(()=>events.some(m=>m.method==='turn/completed'));rpc.close();initial.kill();await once(initial,'exit');
  Object.assign(process.env,env);delete process.env.TMUX;delete process.env.TMUX_PANE;
  tm=(...args)=>execFileSync('tmux',args,{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trimEnd();
  tm('new-session','-d','-s','image-test','-x','120','-y','40','-c',project,'codex','resume',thread.id,'--yolo');
  const SessionManager=require('../server/services/session-manager');
  manager=new SessionManager(19000,19001);
  const session={name:'image-test',displayName:'图片链路验证',createdAt:new Date().toISOString(),shell:'codex',cwd:project,status:'running'};
  manager.sessions.set(session.name,session);
  await until(()=>session.activity?.available);
  const app=express();app.use(express.json());app.use('/api/sessions',require('../server/routes/sessions')(manager));app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname,'../server/public')));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');wss=require('../server/ws')(server,manager);streams=require('../server/services/terminal-stream').setupTerminalStreams(server,manager);
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:412,height:915},isMobile:true,hasTouch:true}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('.session-card').click();await page.locator('.message').first().waitFor();
  const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const x=c.getContext('2d');x.fillStyle='#f35d60';x.fillRect(0,0,160,160);x.fillStyle='#38a9ed';x.fillRect(160,0,160,160);return c.toDataURL('image/png').split(',')[1];}),'base64');
  await fs.writeFile(viewed,png);
  await page.locator('input[type=file]').setInputFiles({name:'截图.png',mimeType:'image/png',buffer:png});
  await page.locator('.attachment img').waitFor();
  assert.equal(await page.locator('.composer .image-pick').count(),0);
  const pick=await page.locator('.mobile-session-header .image-pick').boundingBox(), title=await page.locator('.mobile-title-row').boundingBox();
  assert(pick && pick.y >= title.y && pick.y + pick.height <= title.y + title.height + 1, 'Image picker belongs in title row');
  await page.getByRole('textbox',{name:'消息输入'}).fill('请分析这张截图');await page.getByRole('button',{name:'发送',exact:true}).click();
  await until(()=>sawImage);await page.locator('.message.assistant').filter({hasText:'图片已作为视觉输入收到'}).waitFor({timeout:20000});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.user .image-preview img')).some(i=>i.complete&&i.naturalWidth>0));
  assert.equal(await page.locator('.attachment').count(),0);
  assert.equal(await page.locator('.pending-message').count(),0, 'Accepted image prompt clears the pending receipt');
  // Persisted tool events use the same image formats as Codex 0.166; no extra model request.
  const state=manager.activity.states.get(session.name);assert(state.path);
  
  await fs.appendFile(state.path,[{type:'event_msg',payload:{type:'image_generation_end',call_id:'fixture-generate',status:'completed',saved_path:viewed}}].map(e=>JSON.stringify({...e,timestamp:new Date().toISOString()})).join('\n')+'\n');
  await until(()=>manager.activity.messages(session.name).filter(m=>m.phase==='image').length===2);
  await page.waitForFunction(()=>document.querySelectorAll('.message .image-preview img').length===3);
  await page.reload();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message .image-preview img')).filter(i=>i.complete&&i.naturalWidth>0).length===3);
  await page.locator('.image-preview').last().click();await page.locator('.image-viewer[open] img').waitFor();await page.getByRole('button',{name:'关闭图片 ×'}).last().click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const desktop=await browser.newPage({viewport:{width:1100,height:760}});desktop.on('pageerror',e=>errors.push(e.message));await desktop.goto(base);await desktop.locator('.session-card').click();await desktop.getByRole('button',{name:'聊天记录',exact:true}).click();await desktop.waitForFunction(()=>document.querySelectorAll('.message .image-preview img').length===3);
  if(process.env.HUB_IMAGES_SCREENSHOT)await desktop.screenshot({path:process.env.HUB_IMAGES_SCREENSHOT});
  await desktop.getByRole('button',{name:'返回终端',exact:true}).click();
  await desktop.waitForFunction(()=>document.querySelector('.terminal-host')?.terminal?.options.disableStdin===false);
  const screenText = () => desktop.evaluate(() => { const t=document.querySelector('.terminal-host').terminal,b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n'); });
  await desktop.locator('.xterm-helper-textarea').focus();await desktop.keyboard.type('UNSENT_WHEEL_DRAFT');
  const beforeWheel=await screenText();
  await desktop.locator('.xterm-screen').hover();await desktop.mouse.wheel(0,-720);await pause(600);
  const afterWheel=await screenText();
  assert.notEqual(afterWheel,beforeWheel,'Fullscreen Codex must scroll its actual transcript when tmux mouse is off');
  assert(afterWheel.includes('SCROLL_CONTEXT_'),'Wheel exposes earlier conversation');
  assert(afterWheel.includes('UNSENT_WHEEL_DRAFT'),'Wheel preserves the unsent prompt');
  // Small fractional deltas, typical of a Mac trackpad, accumulate into wheel reports.
  await desktop.locator('.xterm-screen').evaluate(el=>{const r=el.getBoundingClientRect();for(let i=0;i<80;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:-2.5,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));});
  await pause(500);assert.notEqual(await screenText(),afterWheel,'Trackpad-sized deltas scroll too');
  await desktop.mouse.wheel(0,20000);await pause(700);
  await desktop.keyboard.press('Control+u');
  await desktop.context().grantPermissions(['clipboard-read','clipboard-write']);
  await desktop.evaluate(async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]),[...png]);
  await desktop.locator('.xterm-helper-textarea').focus();await desktop.keyboard.press('Control+v');
  await desktop.locator('.attachment img').waitFor();
  await desktop.waitForTimeout(11000);
  assert.equal(await desktop.locator('.attachment img').count(),1,'Unsent image survives two list reconciliations');
  await desktop.getByRole('button',{name:'加入终端输入区',exact:true}).click();
  await desktop.locator('.attachment').waitFor({state:'detached'});
  assert(!tm('capture-pane','-p','-t','=image-test:').includes('Failed to paste image'),'Ctrl+V must not invoke the server clipboard');
  assert(tm('capture-pane','-p','-t','=image-test:').includes('[Image #1]'),'Desktop paste attaches an image to the actual Codex composer without Enter');
  assert.deepEqual(errors,[]);assert.equal(requests,3,'One image prompt and one tool-result continuation; no extra model calls');
  console.log('PASS fullscreen wheel + fractional trackpad deltas preserve drafts without model input');
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
