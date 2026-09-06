// 使用本地生成的 H.264/AAC 媒体、真实 hls.js/Chromium 解码验证交接，不访问外部影片。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { context, fixture, origin, b, c } = require('./autoSelection.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cine-handoff-'));
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=25',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','36','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-g','50','-sc_threshold','0','-c:a','aac','-movflags','+faststart',path.join(temp,'clip.mp4')], { windowsHide:true });
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error','-i',path.join(temp,'clip.mp4'),'-c','copy',
    '-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(temp,'seg%d.ts'),path.join(temp,'index.m3u8')], { windowsHide:true });
  const api = `export const api={siteDetail:async key=>({flags:[{flag:key,episodes:[{name:'正片',url:key+'-episode'}]}]}),
    player:async key=>{window.playerRequests.push(key);return {play:location.origin+'/media/'+key+'/index.m3u8'};}};`;
  const bundle = await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
    import {WatchView} from './src/views/WatchView';import {MockProvider} from './src/context/AppContext';
    import * as handoff from './src/utils/mediaHandoff';import Hls from 'hls.js';window.handoff=handoff;window.Hls=Hls;
    const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
    if(window.renderWatch)root.render(<MockProvider><WatchView/></MockProvider>);`,resolveDir:root,loader:'jsx'},bundle:true,write:false,
    plugins:[{name:'fixtures',setup(build){
      build.onResolve({filter:/context\/AppContext$/},()=>({path:'context',namespace:'fixture'}));
      build.onResolve({filter:/\/api$/},()=>({path:'api',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='context'?context:api,loader:'jsx',resolveDir:root}));
    }}]});
  let requests=[], bad={}, heldKey='', held=[];
  const send = (req,res,pathname) => {
    const basename = path.basename(pathname);
    const file = basename.endsWith('.mp4') ? 'clip.mp4' : basename;
    if (!/^seg\d+\.ts$|^index\.m3u8$|^clip\.mp4$/.test(file)) {res.writeHead(404).end();return;}
    const data=fs.readFileSync(path.join(temp,file));
    const headers={'Content-Type':file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.ts')?'video/mp2t':'video/mp4','Accept-Ranges':'bytes'};
    const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
      res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});res.end(data.subarray(start,end+1));
    }else{res.writeHead(200,{...headers,'Content-Length':data.length});res.end(data);}
  };
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!url.pathname.startsWith('/media/')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(`<style>#cine-video-player{position:relative;width:640px;height:360px}#cine-video-player video{position:absolute;width:100%;height:100%}video[data-active=false]{opacity:0;pointer-events:none}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`);return;}
    requests.push(url.pathname);
    if(bad[url.pathname]){res.writeHead(bad[url.pathname],{'Cache-Control':'no-store'}).end('missing');return;}
    if(heldKey && url.pathname.includes('/'+heldKey+'/')){held.push(()=>{if(!res.destroyed)send(req,res,url.pathname);});return;}
    send(req,res,url.pathname);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  let count=0;
  async function test(name,fn){if(process.env.CINE_TEST_FILTER && !name.includes(process.env.CINE_TEST_FILTER))return;requests=[];bad={};heldKey='';held=[];await fn();count++;console.log('PASS',name);}
  async function pageFor(state){const page=await browser.newPage();page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
    await page.addInitScript(f=>{window.renderWatch=!!f;window.fixture=f||{};window.playerRequests=[];window.toasts=[];},state);
    await page.goto(base);await page.waitForFunction(()=>!!window.handoff);return page;}
  const active='video[data-active="true"]';
  const startState=patch=>fixture([origin],{initialAutoPlayPending:false,awaitScan:false,autoUpgradeEligible:false,...patch});
  const started=page=>page.waitForFunction(()=>document.querySelector('video[data-active="true"]')?.currentTime>0.25);
  const clean=async page=>{assert.deepEqual(page.errors,[]);await page.close();};
  try {
    for(const code of [404,410])await test(code+' 同一分片只重试一次，随后停止请求',async()=>{
      bad['/media/bad/seg0.ts']=code;
      const page=await pageFor(null);
      await page.evaluate(()=>{
        const v=document.createElement('video');document.body.append(v);const h=new Hls(handoff.playbackHlsConfig());window.h=h;
        const attempts=new Map();h.on(Hls.Events.ERROR,(_e,d)=>{if(handoff.missingFragment(d,attempts)){window.missing=true;h.stopLoad();}});
        h.attachMedia(v);h.loadSource(location.origin+'/media/bad/index.m3u8');
      });
      await page.waitForFunction(()=>window.missing);
      await page.waitForTimeout(1500);
      assert.equal(requests.filter(p=>p==='/media/bad/seg0.ts').length,2);
      await clean(page);
    });
    await test('普通 500 保留原有重试策略',async()=>{
      bad['/media/bad/seg0.ts']=500;const page=await pageFor(null);
      await page.evaluate(()=>{const v=document.createElement('video');document.body.append(v);const h=new Hls(handoff.playbackHlsConfig());h.attachMedia(v);h.loadSource(location.origin+'/media/bad/index.m3u8');});
      for(let i=0;i<60 && requests.filter(p=>p==='/media/bad/seg0.ts').length<3;i++)await page.waitForTimeout(100);
      assert.ok(requests.filter(p=>p==='/media/bad/seg0.ts').length>=3);await clean(page);
    });
    await test('备用验证当前进度附近真实分片并解码，同步播放倍速',async()=>{
      const page=await pageFor(null);
      await page.evaluate(()=>{const v=document.createElement('video');v.style.opacity='0';document.body.append(v);window.v=v;
        window.controller=new AbortController();window.handoff.prepareMedia(v,{play:location.origin+'/media/target/index.m3u8'},
          {signal:controller.signal,valid:()=>true,position:()=>17.25,paused:()=>true,rate:()=>1.5}).then(w=>{window.w=w;window.done=true;});});
      await page.waitForFunction(()=>window.done);
      const parts=requests.filter(p=>p.includes('/target/seg'));
      assert.ok(parts.some(p=>/seg8\.ts$/.test(p)),JSON.stringify(parts));
      assert.ok(!parts.some(p=>/seg0\.ts$/.test(p)), '不以首片冒充当前进度验证');
      assert.ok(await page.evaluate(()=>Math.abs(v.currentTime-17.25)<0.5 && v.readyState>=3 && v.playbackRate===1.5));
      await page.evaluate(()=>w.destroy());await clean(page);
    });
    await test('自动升级准备时旧画面持续播放，解码后原备用实例接替且不重复加载',async()=>{
      const page=await pageFor(startState({autoUpgradeEligible:true}));await started(page);
      heldKey='C';await page.evaluate(()=>window.old=document.querySelector('video[data-active="true"]'));
      await page.evaluate(results=>window.updateResource({scan:{...window.resource.scan,results}}),[origin,b,c]);
      await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      const before=await page.evaluate(()=>old.currentTime);await page.waitForTimeout(800);
      assert.ok(await page.evaluate(t=>old.currentTime>t+0.4 && !old.paused && resource.selected.siteKey==='origin',before));
      assert.equal(await page.locator(active).evaluate(el=>el===window.old),true);
      await page.evaluate(()=>window.next=document.querySelector('video[data-active="false"]'));
      heldKey='';held.splice(0).forEach(fn=>fn());
      await page.waitForFunction(()=>resource.selected.siteKey==='C');
      assert.ok(await page.evaluate(()=>document.querySelector('video[data-active="true"]')===next && next.readyState>=3 && !next.paused && old.paused && old.muted && !next.muted));
      assert.equal(requests.filter(p=>p==='/media/C/index.m3u8').length,1);
      await page.waitForFunction(()=>resource.autoDuringDone===true);await clean(page);
    });
    await test('预加载发现远处坏片先准备备用，原线接近缺口时才交接',async()=>{
      bad['/media/origin/seg7.ts']=404;
      const state=startState({autoUserPicked:true,searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}});
      const page=await pageFor(state);await started(page);
      await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      await page.waitForFunction(()=>document.querySelector('[aria-label="线路切换进度"]')?.textContent.includes('备用已就绪'));
      assert.ok(await page.evaluate(()=>resource.selected.siteKey==='origin' && !document.querySelector('video[data-active="true"]').paused));
      await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=10);
      await page.waitForFunction(()=>resource.selected.siteKey==='B');
      assert.ok(await page.locator(active).evaluate(v=>v.currentTime>=9.5 && v.readyState>=3));
      assert.equal(requests.filter(p=>p==='/media/origin/seg7.ts').length,2);await clean(page);
    });
    await test('备用当前进度分片损坏时保留旧线，取消预加载后停止后台媒体',async()=>{
      const page=await pageFor(null);bad['/media/target/seg8.ts']=404;
      await page.evaluate(()=>{const old=document.createElement('video');const next=document.createElement('video');document.body.append(old,next);window.old=old;window.next=next;
        old.muted=true;old.src=location.origin+'/media/old/clip.mp4';old.play();
        const controller=new AbortController();handoff.prepareMedia(next,{play:location.origin+'/media/target/index.m3u8'},
          {signal:controller.signal,valid:()=>true,position:()=>17.25,paused:()=>false,rate:()=>1}).catch(()=>window.failed=true);});
      await page.waitForFunction(()=>window.failed);
      assert.ok(await page.evaluate(()=>!old.paused && old.currentTime>0 && next.paused && !next.getAttribute('src')));
      assert.equal(requests.filter(p=>p==='/media/target/seg8.ts').length,2);await clean(page);
    });
    await test('故障恢复跳过无法起播的备用线路，使用下一条且保留原线直到就绪',async()=>{
      bad['/media/origin/seg7.ts']=404;bad['/media/C/seg0.ts']=404;
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b,c]}}));
      await started(page);
      await page.waitForFunction(()=>document.querySelector('[aria-label="线路切换进度"]')?.textContent.includes('备用已就绪'));
      assert.ok(await page.evaluate(()=>resource.selected.siteKey==='origin' && !document.querySelector('video[data-active="true"]').paused));
      assert.deepEqual(await page.evaluate(()=>playerRequests),['origin','C','B']);
      await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=10);
      await page.waitForFunction(()=>resource.selected.siteKey==='B');
      assert.equal(requests.filter(p=>p==='/media/origin/index.m3u8').length,1);await clean(page);
    });
    await test('故障恢复准备中手动选择另一路，迟到的恢复任务不得抢回线路',async()=>{
      bad['/media/origin/seg7.ts']=404;heldKey='C';
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b,c]}}));
      await started(page);await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      await page.getByTitle('切换到 B · B',{exact:true}).click();
      await page.waitForFunction(()=>resource.selected.siteKey==='B');
      heldKey='';held.splice(0).forEach(fn=>fn());await page.waitForTimeout(400);
      assert.equal(await page.evaluate(()=>resource.selected.siteKey),'B');
      assert.deepEqual(await page.evaluate(()=>playerRequests),['origin','C','B']);await clean(page);
    });
    await test('准备期间拖动旧线路进度并暂停，备用按最新位置解码后以暂停状态交接',async()=>{
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
      await started(page);heldKey='B';await page.getByTitle('切换到 B · B（综合最佳）').click();
      await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      await page.evaluate(()=>{const v=document.querySelector('video[data-active="true"]');v.pause();v.currentTime=17.25;v.playbackRate=1.5;});
      heldKey='';held.splice(0).forEach(fn=>fn());
      await page.waitForFunction(()=>resource.selected.siteKey==='B');
      assert.ok(await page.locator(active).evaluate(v=>v.paused && Math.abs(v.currentTime-17.25)<0.5 && v.playbackRate===1.5 && v.readyState>=3));
      assert.ok(requests.some(p=>p==='/media/B/seg8.ts'));await clean(page);
    });
    await test('退出播放页取消备用加载并释放两个播放器',async()=>{
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
      await started(page);heldKey='B';await page.getByTitle('切换到 B · B（综合最佳）').click();
      await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      await page.evaluate(()=>{window.videos=[...document.querySelectorAll('video')];window.unmount();});
      heldKey='';held.splice(0).forEach(fn=>fn());await page.waitForTimeout(200);
      assert.ok(await page.evaluate(()=>videos.every(v=>v.paused && !v.getAttribute('src'))));await clean(page);
    });
    await test('备用全部失败时不通过重搜打断仍可播放的旧缓冲',async()=>{
      bad['/media/origin/seg7.ts']=404;bad['/media/C/seg0.ts']=404;bad['/media/B/seg0.ts']=404;
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b,c]}}));
      await started(page);await page.waitForFunction(()=>playerRequests.length===3);
      await page.waitForTimeout(1700);
      assert.ok(await page.evaluate(()=>resource.selected.siteKey==='origin' && !document.querySelector('video[data-active="true"]').paused));
      assert.equal(await page.evaluate(()=>toasts.some(t=>t[0].includes('实时重新搜索'))),false);
      assert.equal(requests.filter(p=>p==='/media/origin/index.m3u8').length,1);await clean(page);
    });
    await test('手动切换失败后恢复备用准备，不遗留失效原线',async()=>{
      bad['/media/origin/seg7.ts']=404;bad['/media/B/seg0.ts']=404;heldKey='C';
      const page=await pageFor(startState({autoUserPicked:true,scan:{...fixture().scan,status:'done',results:[origin,b,c]}}));
      await started(page);await page.getByRole('status',{name:'线路切换进度'}).waitFor();
      await page.getByTitle('切换到 B · B',{exact:true}).click();
      await page.waitForFunction(()=>playerRequests.filter(k=>k==='C').length===2);
      heldKey='';held.splice(0).forEach(fn=>fn());
      await page.waitForFunction(()=>document.querySelector('[aria-label="线路切换进度"]')?.textContent.includes('备用已就绪'));
      await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=10);
      await page.waitForFunction(()=>resource.selected.siteKey==='C');await clean(page);
    });
    console.log(count+' real media checks passed');
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // 仅删除本测试创建的临时目录。
    if(path.dirname(temp)===os.tmpdir() && path.basename(temp).startsWith('cine-handoff-'))fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
