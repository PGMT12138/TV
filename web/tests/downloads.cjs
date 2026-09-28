// 真实浏览器 + 隔离 FastAPI + 本地 HLS + FFmpeg，含 /tv-manage 前缀。
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),esbuild=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),manage=path.resolve(root,'../manage');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cine-download-ui-'));
 let server,browser,serverUrl,logs='',passed=0;
 try{
  await esbuild.build({stdin:{contents:`import React,{useState,useCallback} from 'react';import{createRoot}from'react-dom/client';import{DownloadPanel}from'./src/components/DownloadPanel';
  function App(){const[open,setOpen]=useState(true);const close=useCallback(()=>setOpen(false),[]);const config=useCallback(()=>{},[]);return <><button onClick={()=>setOpen(true)}>查看我的下载</button>{open&&<DownloadPanel onClose={close} onConfig={config} source={{movieId:'test',title:'验收电影',siteKey:'test-site',siteName:'验收站点',vodId:'vod',flag:'高清',episodeId:'one',episodeName:'正片',episodeNumber:1}}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'jsx'},bundle:true,outfile:path.join(tmp,'bundle.js')});
  const assets=path.join(manage,'static/cine/assets');fs.copyFileSync(path.join(assets,fs.readdirSync(assets).find(f=>f.endsWith('.css'))),path.join(tmp,'style.css'));
  const python=process.env.CINE_PYTHON||path.join(manage,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  server=spawn(python,['-u',path.join(manage,'download_ui_server.py'),tmp],{cwd:manage,windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stderr.on('data',d=>logs+=d);
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('验收服务器启动超时 '+logs)),30000);server.stdout.on('data',d=>{for(const line of String(d).split('\n'))try{const r=JSON.parse(line);if(r.url){clearTimeout(timer);resolve(r.url)}}catch{}});server.on('exit',code=>{clearTimeout(timer);reject(Error('验收服务器退出 '+code+' '+logs))})});
  serverUrl=url;
  browser=await chromium.launch({headless:true});
  const client=await browser.newContext({acceptDownloads:true}),admin=await browser.newContext({acceptDownloads:true});
  const page=await client.newPage(),management=await admin.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));management.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/cine/');
  await page.getByRole('alert').filter({hasText:'请先登录'}).waitFor();
  passed++;console.log('PASS 未登录不能创建缓存');
  await client.request.post(url+'/api/auth/register',{data:{username:'浏览器验收',password:'test-password'}});
  await page.reload();const create=page.getByRole('button',{name:'缓存当前影片 / 集数'});await create.waitFor();
  await create.click();await page.getByText('文件已就绪',{exact:true}).waitFor({timeout:30000});
  passed++;console.log('PASS HLS 完整文件生成，网站展示已就绪');
  const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:'保存到本机'}).click();const download=await downloadEvent;
  await download.saveAs(path.join(tmp,'browser.mp4'));assert.ok(fs.statSync(path.join(tmp,'browser.mp4')).size>1000);assert.match(download.suggestedFilename(),/验收电影/);
  passed++;console.log('PASS 浏览器实际保存中文命名视频');
  await management.goto(url+'/downloads');assert.equal(await management.locator('input[type=password]').count(),0);
  await management.locator('.card').waitFor();assert.match(await management.locator('.card').innerText(),/浏览器验收/);
  await management.getByRole('button',{name:'查看视频',exact:true}).click();await management.waitForFunction(()=>document.querySelector('video').readyState>=1);
  assert.ok(await management.locator('video').evaluate(v=>v.duration>5));await management.getByRole('button',{name:'关闭预览'}).click();
  passed++;console.log('PASS 管理端显示记录并解码预览文件');
  const adminDownloadEvent=management.waitForEvent('download');await management.getByRole('link',{name:'下载文件',exact:true}).click();await(await adminDownloadEvent).saveAs(path.join(tmp,'admin.mp4'));
  assert.deepEqual(fs.readFileSync(path.join(tmp,'admin.mp4')),fs.readFileSync(path.join(tmp,'browser.mp4')));
  passed++;console.log('PASS 管理端下载与用户文件一致');
  await management.getByRole('switch').click();await management.waitForFunction(()=>document.querySelector('#toggle').getAttribute('aria-checked')==='false');
  await page.getByRole('status').filter({hasText:'管理员已关闭'}).waitFor({timeout:10000});assert.equal(await create.isDisabled(),true);
  const source={movieId:'test',title:'验收电影',siteKey:'test-site',siteName:'验收站点',vodId:'vod',flag:'高清',episodeId:'slow',episodeName:'正片',episodeNumber:1};
  assert.equal((await client.request.post(url+'/api/downloads',{data:source})).status(),403);
  passed++;console.log('PASS 总开关同步到网页，绕过按钮请求也被拒绝');
  await management.getByRole('switch').click();await management.waitForFunction(()=>document.querySelector('#toggle').getAttribute('aria-checked')==='true');
  const pending=await(await client.request.post(url+'/api/downloads',{data:source})).json();await management.getByRole('button',{name:'刷新',exact:true}).click();await management.getByRole('button',{name:'取消任务',exact:true}).waitFor({timeout:10000});
  await management.getByRole('button',{name:'取消任务',exact:true}).click();await management.getByText('已取消',{exact:true}).waitFor();
  assert.equal((await(await client.request.get(url+'/api/downloads/'+pending.id)).json()).status,'cancelled');
  passed++;console.log('PASS 管理端取消任务并同步到用户记录');
  await management.getByRole('button',{name:'从头重试',exact:true}).click();await management.getByRole('button',{name:'取消任务',exact:true}).waitFor();await management.getByRole('button',{name:'取消任务',exact:true}).click();
  passed++;console.log('PASS 管理端重试任务');
  for(const width of [320,1280]){await management.setViewportSize({width,height:900});assert.equal(await management.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
  passed++;console.log('PASS 320px 与 1280px 页面无横向溢出');
  if(process.env.CINE_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.CINE_UI_SCREENSHOT_DIR,{recursive:true});await management.screenshot({path:path.join(process.env.CINE_UI_SCREENSHOT_DIR,'downloads-admin.png'),fullPage:true});await page.screenshot({path:path.join(process.env.CINE_UI_SCREENSHOT_DIR,'downloads-site.png'),fullPage:true})}
  management.on('dialog',dialog=>dialog.accept());const card=management.locator('.card').filter({has:management.getByText('文件已就绪',{exact:true})});await card.getByRole('button',{name:'删除服务端文件'}).click();await management.locator('.state').filter({hasText:'已删除'}).waitFor();
  assert.ok(fs.statSync(path.join(tmp,'browser.mp4')).size>1000);await management.reload();await management.locator('.state').filter({hasText:'已删除'}).waitFor();
  passed++;console.log('PASS 删除服务端文件后记录保留，本机文件不受影响');
  assert.deepEqual(errors,[]);console.log(`${passed} download browser checks passed`);
 }catch(error){console.error('验收失败',error,logs);throw error}
 finally{if(browser)await browser.close();if(server&&server.exitCode===null){const ended=once(server,'exit');if(serverUrl)await fetch(serverUrl+'/__test_shutdown',{method:'POST'}).catch(()=>{});else server.kill();await ended};if(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
})().catch(e=>{console.error(e);process.exitCode=1});
