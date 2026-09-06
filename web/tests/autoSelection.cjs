// 运行：node tests/autoSelection.cjs；浏览器包可通过 PLAYWRIGHT_MODULE 指定。
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const context = `
import React, {createContext,useContext,useState,useCallback} from '${path.join(root, 'node_modules/react/index.js').replaceAll('\\', '/')}';
const C=createContext(null), noop=()=>{};
const movie={id:'movie',title:'测试影片',type:window.fixture.mediaType||'movie',genres:[],cast:[],director:'未知',duration:window.fixture.movieDuration??'120分钟'};
export function MockProvider({children}) {
 const [resource,setResource]=useState(window.fixture);
 const patchResource=useCallback((id,patch)=>setResource(r=>({...r,...patch})),[]);
 const patchScan=useCallback((id,patch)=>setResource(r=>({...r,scan:{...r.scan,...patch}})),[]);
 window.resource=resource;
 window.updateResource=patch=>setResource(r=>({...r,...patch}));
 const value={selectedMovieId:'movie',selectedEpisodeId:null,getMovieById:()=>movie,
  movieResources:{movie:resource},currentEpisodes:()=>resource.flags[resource.activeFlagIndex],
  isFavorite:()=>false,probingSites:new Set(),watchHistory:[],patchResource,patchScan,
  showToast:(...args)=>window.toasts.push(args)};
 for(const name of ['loadMovieDetail','resolveResources','restartResourceSearch','selectMatch','selectFlag','startScan','probeSite','reprobeSites','confirmRestoredSource','navigateTo','goBack','recordWatchProgress','toggleFavorite'])value[name]=noop;
 return <C.Provider value={value}>{children}</C.Provider>;
}
export const useApp=()=>useContext(C);
`;
const api = `export const api={
 siteDetail:async(key,id)=>({flags:[{flag:key,episodes:window.detailEpisodes?.[key]||[{name:'正片',url:key+'-episode'}]}]}),
 player:async(key,flag,id)=>{
  window.playerRequests.push(key);
  if(window.holdPlayer===key) await new Promise(resolve=>window.releasePlayer=resolve);
  return window.failPlayer===key?{error:'测试解析失败'}:{play:'https://media.test/'+key+'.mp4',url:'https://media.test/'+key+'.mp4'};
 }
};`;

const line = (site, height, extra = {}) => ({ siteKey: site, siteName: site, vodId: site + '-vod', flag: site,
  status: 'ok', metrics: { durationMatch: 'ok', durationS: 7200, codec: 'h264', throughputMbps: 40,
    bitrateKbps: 1000, adLevel: 'clean', height, scores: { total: 0.8 }, ...extra } });
const origin = line('origin', 360);
const b = line('B', 720), c = line('C', 1080), d = line('D', 2160), e = line('E', 4320);
const fixture = (results = [origin, b], patch = {}) => ({status:'ready', searchStartedAt:1,
  initialAutoPlayPending:true, awaitScan:true, autoUpgradeEligible:true, searchEnded:false, automaticScanComplete:false,
  matches:[origin,b,c,d,e].map(r=>({...r,title:'测试影片',score:100})), selected:origin,
  flags:[{flag:'origin',episodes:[{id:'origin-episode',number:1,title:'正片'}]}], activeFlagIndex:0,
  scan:{scanId:'scan',status:'running',finished:results.length,total:5,results}, ...patch});

module.exports={context,api,line,fixture,origin,b,c,d,e};

if(require.main===module)(async()=>{
 const bundle=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {WatchView} from './src/views/WatchView';import {MockProvider} from './src/context/AppContext';import * as selection from './src/utils/autoSelection';import {referenceDurationSeconds} from './src/utils/referenceDuration';import {getSessionLineFailure} from './src/utils/sessionLineFailures';window.sessionLineFailure=getSessionLineFailure;window.referenceDurationSeconds=referenceDurationSeconds;window.selection=selection;let root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();window.remount=()=>{root.unmount();root=createRoot(document.getElementById('root'));root.render(<MockProvider><WatchView/></MockProvider>);};root.render(<MockProvider><WatchView/></MockProvider>);`,resolveDir:root,loader:'jsx'},
  bundle:true,write:false,format:'iife',plugins:[{name:'fixtures',setup(build){
   build.onResolve({filter:/context\/AppContext$/},()=>({path:'context',namespace:'fixture'}));
   build.onResolve({filter:/\/api$/},()=>({path:'api',namespace:'fixture'}));
   build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='context'?context:api,loader:'jsx',resolveDir:root}));
  }}]});
 const browser=await chromium.launch({headless:true});
 let count=0;
 async function test(name,fn){if(process.env.CINE_TEST_FILTER && !name.includes(process.env.CINE_TEST_FILTER))return;await fn();count++;console.log('PASS',name);}
 async function pageFor(state){
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',err=>errors.push(err.message));page.errors=errors;
  await page.clock.install({time:new Date('2026-09-06T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-09-06T00:00:01Z'));
  await page.addInitScript(state=>{
   window.fixture=state;window.loads=[];window.playerRequests=[];window.toasts=[];
   const P=HTMLMediaElement.prototype;
   Object.defineProperties(P,{
    src:{get(){return this._src||''},set(v){this._src=v;this._paused=true;this._time=0;window.loads.push(v);queueMicrotask(()=>{this._ready=4;this.dispatchEvent(new Event('loadedmetadata'));});}},
    currentSrc:{get(){return this._src||''}},paused:{get(){return this._paused!==false}},
    currentTime:{get(){return this._time||0},set(v){this._time=v}},duration:{get(){return 7200}},
    readyState:{get(){return this._ready||0}},buffered:{get(){return {length:this._ready?1:0,start:()=>0,end:()=>7200}}},
   });
   HTMLVideoElement.prototype.requestVideoFrameCallback=undefined;
   P.play=function(){this._paused=false;queueMicrotask(()=>{
    if(window.failPlayback && this._src?.includes('/'+window.failPlayback+'.mp4')) this.dispatchEvent(new Event('error'));
    else if(!window.suppressPlaying)this.dispatchEvent(new Event('playing'));
   });return Promise.resolve();};
   P.pause=function(){this._paused=true;this.dispatchEvent(new Event('pause'));};
   P.load=function(){};
  },state);
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`}));
  await page.goto('http://selection.test/');
  await page.waitForFunction(()=>!!window.updateResource);
  return page;
 }
 const update=async(page,results,patch={})=>{
  await page.evaluate(({results,patch})=>window.updateResource({scan:{...window.resource.scan,results,finished:results.length},...patch}),{results,patch});
  await page.clock.runFor(1);
 };
 const played=async(page,key)=>{await page.waitForFunction(key=>document.querySelector('video[data-active="true"]')?.src.endsWith('/'+key+'.mp4') && window.resource.selected.siteKey===key,key);};
 const failed=async(page,key)=>{await page.waitForFunction(key=>!!window.sessionLineFailure('movie',key,key+'-vod',key),key);await page.clock.runFor(1);};
 const clean=async page=>{assert.deepEqual(page.errors,[]);await page.close();};
 try {
  await test('12 秒前不播放；12 秒到达选择第一推荐，而非初始低清线路',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(11999);
   assert.deepEqual(await page.evaluate(()=>window.loads),[]);
   await page.clock.runFor(1);await played(page,'B');await clean(page);
  });
  await test('12 秒后无推荐按可用线路兜底；还无可用结果则继续等',async()=>{
   const page=await pageFor(fixture([]));await page.clock.runFor(13000);
   assert.deepEqual(await page.evaluate(()=>window.loads),[]);
   await update(page,[line('B',720,{durationMatch:undefined})]);await played(page,'B');await clean(page);
  });
  await test('历史/指定来源沿用原起播，不强制等 12 秒',async()=>{
   const page=await pageFor(fixture([origin],{initialAutoPlayPending:false,awaitScan:false,autoUpgradeEligible:false}));
   await played(page,'origin');await clean(page);
  });
  await test('只有两条合格推荐时不做中途升级',async()=>{
   const page=await pageFor(fixture([b]));await page.clock.runFor(12000);await played(page,'B');
   await update(page,[b,c]);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');await clean(page);
  });
  await test('用户在倒计时内手动选线可立即播放，后续推荐不接管',async()=>{
   const page=await pageFor(fixture());
   await page.getByTitle('切换到 B · B（综合最佳）').click();await played(page,'B');
   assert.equal(await page.evaluate(()=>window.resource.autoUserPicked),true);
   await update(page,[origin,b,c,d],{searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b,c,d]}});
   await page.clock.runFor(13000);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');await clean(page);
  });
  await test('升级地址准备中手动切换，迟到的自动结果不得覆盖用户选择',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>window.holdPlayer='C');await update(page,[origin,b,c]);
   await page.waitForFunction(()=>!!window.releasePlayer);
   await page.getByTitle('切换到 origin · origin').click();await played(page,'origin');
   await page.evaluate(()=>window.releasePlayer());await page.clock.runFor(1);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   assert.equal(await page.locator('button[disabled]').filter({hasText:'本次会话不可用'}).count(),0);
   assert.equal(await page.evaluate(()=>!!window.resource.autoDuringDone),false);await clean(page);
  });
  await test('升级准备中暂停则保留原线，恢复播放后仍可升级',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>window.holdPlayer='C');await update(page,[origin,b,c]);
   await page.waitForFunction(()=>!!window.releasePlayer);await page.keyboard.press('Space');
   await page.evaluate(()=>{window.holdPlayer='';window.releasePlayer();});await page.clock.runFor(1);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').paused),true);
   await page.keyboard.press('Space');await played(page,'C');await clean(page);
  });
  await test('暂停时手动换源保留暂停和进度',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=12.25);await page.keyboard.press('Space');
   await page.getByTitle('切换到 origin · origin').click();await played(page,'origin');
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').paused),true);
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime),12.25);await clean(page);
  });
  await test('目标缺少当前集时保留原线路，不跳回第一集',async()=>{
   const page=await pageFor(fixture([b],{selected:b,flags:[{flag:'B',episodes:[{id:'B-episode',number:2,title:'第二集'}]}]}));
   await page.clock.runFor(12000);await played(page,'B');await update(page,[origin,b,c]);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await page.evaluate(()=>window.playerRequests.includes('C')),false);await clean(page);
  });
  await test('探测中、最终各升级一次，确认 playing 才记额度，并保留前 5 秒进度',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>{document.querySelector('video[data-active="true"]').currentTime=4.25;window.suppressPlaying=true;});
   await update(page,[origin,b,c]);await page.waitForFunction(()=>window.loads.some(s=>s.endsWith('/C.mp4')));
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').paused),false);
   assert.equal(await page.evaluate(()=>!!window.resource.autoDuringDone),false);
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime),4.25);
   await page.evaluate(()=>{window.suppressPlaying=false;document.querySelector('video[data-active="false"]').dispatchEvent(new Event('playing'));});
   await page.waitForFunction(()=>window.resource.autoDuringDone===true);
   await update(page,[origin,b,c,d]);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'C');
   await update(page,[origin,b,c,d],{scan:{...fixture().scan,results:[origin,b,c,d],status:'done'},searchEnded:true});
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'C');
   await page.evaluate(()=>window.updateResource({automaticScanComplete:true}));await played(page,'D');
   await page.waitForFunction(()=>window.resource.autoFinalDone===true);
   await update(page,[origin,b,c,d,e]);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'D');await clean(page);
  });
  await test('同清晰度仅评分更高不切换',async()=>{
   const current=line('B',1080,{scores:{total:0.1}}),other=line('C',1080,{scores:{total:1}});
   const page=await pageFor(fixture([origin,current]));await page.clock.runFor(12000);await played(page,'B');
   await update(page,[origin,current,other]);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');await clean(page);
  });
  await test('目标地址准备失败保留原线、不消耗额度、不重复尝试',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>window.failPlayer='C');await update(page,[origin,b,c]);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await page.evaluate(()=>!!window.resource.autoDuringDone),false);
   await update(page,[origin,b,c]);assert.equal(await page.evaluate(()=>window.playerRequests.filter(k=>k==='C').length),1);await clean(page);
  });
  await test('目标媒体起播失败不重载原线，升级额度不消耗',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>{window.failPlayback='C';document.querySelector('video[data-active="true"]').currentTime=2.5;});
   await update(page,[origin,b,c]);await page.waitForFunction(()=>window.loads.length===2);
   await played(page,'B');assert.equal(await page.evaluate(()=>!!window.resource.autoDuringDone),false);
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime),2.5);await clean(page);
  });
  await test('新线路迟迟没有 playing，30 秒后取消预加载并保留原线',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>window.suppressPlaying=true);await update(page,[origin,b,c]);await page.waitForFunction(()=>window.loads.length===2);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   await page.clock.runFor(30101);await played(page,'B');assert.equal(await page.evaluate(()=>!!window.resource.autoDuringDone),false);await clean(page);
  });
  await test('手动选线后只在全部自动探测结束时提示，点击按钮才切换并保留进度',async()=>{
   const page=await pageFor(fixture());
   await page.getByTitle('切换到 B · B（综合最佳）').click();await played(page,'B');
   const notice=page.getByRole('status',{name:'更优线路提示'});
   await update(page,[origin,b,c]);assert.equal(await notice.count(),0);
   await update(page,[origin,b,c],{scan:{...fixture().scan,status:'done',results:[origin,b,c]}});
   assert.equal(await notice.count(),0);
   await update(page,[origin,b,c],{searchEnded:true});assert.equal(await notice.count(),0);
   await update(page,[origin,b,c],{automaticScanComplete:true});await notice.waitFor();
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await notice.evaluate(el=>!!el.closest('#cine-video-player')),true);
   if(process.env.CINE_UI_CHECK){
    const fs=require('node:fs'),assets=path.join(root,'../manage/static/cine/assets');
    const css=fs.readdirSync(assets).find(file=>file.endsWith('.css'));
    await page.addStyleTag({content:fs.readFileSync(path.join(assets,css),'utf8')});
    await page.addStyleTag({content:'*, *::before, *::after { animation: none !important; transition: none !important; }'});
    for(const width of [320,1280]){
     await page.setViewportSize({width,height:800});
     await page.locator('#cine-video-player').scrollIntoViewIfNeeded();
     const box=await notice.boundingBox(),player=await page.locator('#cine-video-player').boundingBox();
     assert.ok(box.x>=player.x && box.y>=player.y && box.x+box.width<=player.x+player.width);
     assert.ok(box.y+box.height<=player.y+player.height);
     assert.ok(box.height<=64,'提示最多两行高度');
     assert.ok(Math.abs(player.x+player.width-box.x-box.width-13)<2,'提示应固定在播放器右上角');
     if(process.env.CINE_UI_SCREENSHOT_DIR)await page.locator('#cine-video-player').screenshot({path:path.join(process.env.CINE_UI_SCREENSHOT_DIR,'cine-notice-'+width+'.png'),animations:'disabled'});
     const hit=await notice.getByRole('button',{name:'切换到更优线路'}).evaluate(el=>{
      const r=el.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {ok:el.contains(top),top:top?.outerHTML.slice(0,600),rect:r.toJSON()};
     });
     assert.equal(hit.ok,true,'切换按钮不能被播放器控制栏遮挡：'+JSON.stringify(hit));
    }
   }
   await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=4.25);
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await played(page,'C');
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime),4.25);
   assert.equal(await page.evaluate(()=>window.resource.autoUserPicked),true);
   assert.equal(await notice.count(),0);await clean(page);
  });
  await test('历史续播同样提示更优线路，暂停时确认切换仍保持暂停',async()=>{
   const page=await pageFor(fixture([origin],{initialAutoPlayPending:false,awaitScan:false,autoUpgradeEligible:false,restoredPick:true}));
   await played(page,'origin');await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime=123.5);
   await page.keyboard.press('Space');
   await update(page,[origin,b],{searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}});
   const notice=page.getByRole('status',{name:'更优线路提示'});await notice.waitFor();
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await played(page,'B');
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').paused),true);
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').currentTime),123.5);await clean(page);
  });
  await test('关闭提示后重复探测结果不再弹出，也不影响当前播放',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
   await played(page,'origin');const notice=page.getByRole('status',{name:'更优线路提示'});await notice.waitFor();
   await notice.getByRole('button',{name:'关闭更优线路提示'}).click();await update(page,[origin,line('B',720,{scores:{total:1}})]);
   assert.equal(await notice.count(),0);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   assert.equal(await page.getByRole('status',{name:'线路升级建议'}).count(),1);
   assert.equal(await page.evaluate(()=>document.querySelector('video[data-active="true"]').paused),false);await clean(page);
  });
  for(const mode of ['手动选线','历史续播'])await test(mode+'浮层最多显示 10 秒，下方无按钮提示常驻直到切到推荐线路',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,
    ...(mode==='手动选线'?{autoUserPicked:true}:{autoUpgradeEligible:false,restoredPick:true}),
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
   await played(page,'origin');const notice=page.getByRole('status',{name:'更优线路提示'});
   const persistent=page.getByRole('status',{name:'线路升级建议'});
   await notice.waitFor();await persistent.waitFor();
   assert.equal(await persistent.locator('button, a, [role="button"]').count(),0);
   assert.ok((await persistent.innerText()).includes('推荐线路'));
   await page.clock.runFor(5000);await update(page,[origin,line('B',720,{scores:{total:1}})]);
   await page.clock.runFor(4998);assert.equal(await notice.count(),1);
   await page.clock.runFor(1);assert.equal(await notice.count(),0);
   await page.clock.runFor(60000);assert.equal(await persistent.count(),1);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   await page.getByTitle('切换到 B · B（综合最佳）').click();await played(page,'B');
   assert.equal(await persistent.count(),0);assert.equal(await notice.count(),0);await clean(page);
  });
  await test('10 秒到期只隐藏浮层，不取消用户已经点击的切换请求',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
   await played(page,'origin');await page.evaluate(()=>window.holdPlayer='B');
   const notice=page.getByRole('status',{name:'更优线路提示'}),persistent=page.getByRole('status',{name:'线路升级建议'});
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await page.waitForFunction(()=>!!window.releasePlayer);
   await page.clock.runFor(10000);assert.equal(await notice.count(),0);assert.equal(await persistent.count(),1);
   await page.evaluate(()=>window.releasePlayer());await played(page,'B');
   assert.equal(await persistent.count(),0);await clean(page);
  });
  await test('同清晰度微小评分提升、质量门槛不符或探测错误均不提示',async()=>{
   const page=await pageFor(fixture([origin],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true,searchEnded:true,automaticScanComplete:true}));
   await played(page,'origin');const notice=page.getByRole('status',{name:'更优线路提示'});
   for(const other of [line('B',360,{scores:{total:1}}),line('B',2160,{throughputMbps:2}),line('B',2160,{durationMatch:'short'})]){
    await update(page,[origin,other],{scan:{...fixture().scan,status:'done',results:[origin,other]}});
    assert.equal(await notice.count(),0);
   }
   await update(page,[origin,b],{scan:{...fixture().scan,status:'done',error:'模拟中断',results:[origin,b]}});
   assert.equal(await notice.count(),0);await clean(page);
  });
  await test('提示按钮准备期间显示忙碌，解析失败保留原线路并禁用失败线路',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b]}}));
   await played(page,'origin');const notice=page.getByRole('status',{name:'更优线路提示'});await notice.waitFor();
   await page.evaluate(()=>{window.holdPlayer='B';window.failPlayer='B';});
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await page.waitForFunction(()=>!!window.releasePlayer);
   assert.equal(await page.getByRole('status',{name:'线路切换进度'}).count(),1);
   assert.equal(await notice.count(),0);
   if(process.env.CINE_UI_CHECK){
    const fs=require('node:fs'),assets=path.join(root,'../manage/static/cine/assets');
    const css=fs.readdirSync(assets).find(file=>file.endsWith('.css'));
    await page.addStyleTag({content:fs.readFileSync(path.join(assets,css),'utf8')});
    await page.addStyleTag({content:'*, *::before, *::after { animation: none !important; transition: none !important; }'});
    for(const width of [320,1280]){
     await page.setViewportSize({width,height:800});await page.locator('#cine-video-player').scrollIntoViewIfNeeded();
     const box=await page.getByRole('status',{name:'线路切换进度'}).boundingBox(),player=await page.locator('#cine-video-player').boundingBox();
     assert.ok(box.width<=194 && box.height<=64 && box.x>=player.x && box.x+box.width<=player.x+player.width,'切换进度应缩窄并显示两行');
     if(process.env.CINE_UI_SCREENSHOT_DIR)await page.locator('#cine-video-player').screenshot({path:path.join(process.env.CINE_UI_SCREENSHOT_DIR,'cine-switch-'+width+'.png'),animations:'disabled'});
    }
   }
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   await page.evaluate(()=>{window.holdPlayer='';window.releasePlayer();});
   await failed(page,'B');assert.equal(await page.getByTitle(/^切换到 B · B/).count(),0);assert.equal(await notice.count(),0);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   await clean(page);
  });
  await test('提示切换准备中另选线路，迟到结果不得覆盖新选择',async()=>{
   const page=await pageFor(fixture([origin,b,c],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,b,c]}}));
   await played(page,'origin');await page.evaluate(()=>window.holdPlayer='C');
   await page.getByRole('button',{name:'切换到更优线路',exact:true}).click();await page.waitForFunction(()=>!!window.releasePlayer);
   await page.getByTitle('切换到 B · B',{exact:true}).click();await played(page,'B');
   await page.evaluate(()=>window.releasePlayer());await page.clock.runFor(1);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');await clean(page);
  });
  await test('剧集没有基准片长时仍展示三条可用推荐，包括当前 4K 线路，并支持手动选择',async()=>{
   const results=[line('origin',2160,{durationMatch:undefined,throughputMbps:10}),
    line('B',1080,{durationMatch:undefined}),line('C',720,{durationMatch:undefined}),line('D',360,{durationMatch:undefined})];
   const page=await pageFor(fixture(results,{initialAutoPlayPending:false,awaitScan:false,autoUpgradeEligible:false,restoredPick:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results}}));
   await played(page,'origin');await page.getByTitle('当前线路：origin · origin',{exact:true}).waitFor();
   assert.equal(await page.getByTitle('当前线路：origin · origin',{exact:true}).count(),1);
   assert.equal(await page.getByTitle('切换到 B · B',{exact:true}).count(),1);
   assert.equal(await page.getByTitle('切换到 C · C',{exact:true}).count(),1);
   assert.equal(await page.getByTitle('切换到 D · D',{exact:true}).count(),0);
   await page.getByTitle('切换到 B · B',{exact:true}).click();await played(page,'B');
   assert.equal(await page.getByRole('status',{name:'更优线路提示'}).count(),0);
   assert.equal(await page.getByRole('status',{name:'线路升级建议'}).count(),0);await clean(page);
  });
  await test('推荐展示可用但信息不全的线路，已确认合格线路排在前面，最新失败结果不再展示',async()=>{
   const page=await pageFor(fixture());
   const results=[line('C',2160,{durationMatch:undefined}),b,line('D',1080,{codec:undefined}),
    line('E',720,{bitrateKbps:30000,throughputMbps:10}),line('origin',4320),{...origin,status:'fail',metrics:undefined}];
   assert.deepEqual(await page.evaluate(results=>window.selection.displayRecommendations(results,7200).map(r=>r.siteKey),results),['B','C','D','E']);
   assert.deepEqual(await page.evaluate(results=>window.selection.qualifiedRecommendations(results,7200).map(r=>r.siteKey),results),['B']);
   await clean(page);
  });
  await test('展示了未核验片长的高清推荐，也不能触发自动升级',async()=>{
   const page=await pageFor(fixture([b]));await page.clock.runFor(12000);await played(page,'B');
   const results=[b,line('C',2160,{durationMatch:undefined}),line('D',4320,{durationMatch:undefined})];
   await update(page,results);assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   await update(page,results,{searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results}});
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   assert.equal(await page.getByTitle('切换到 D · D',{exact:true}).count(),1);await clean(page);
  });
  for(const mediaType of ['movie','series','anime','doc'])await test(mediaType+' 无基准片长时：12 秒初选、中途和最终升级均不核验片长',async()=>{
   const initial=line('B',720,{durationMatch:undefined}),middle=line('C',1080,{durationMatch:'short'}),final=line('D',2160,{durationMatch:'long'});
   const page=await pageFor(fixture([origin,initial],{mediaType,movieDuration:'共18集'}));
   await page.clock.runFor(12000);await played(page,'B');
   await update(page,[origin,initial,middle]);await played(page,'C');
   await page.waitForFunction(()=>window.resource.autoDuringDone===true);
   const results=[origin,initial,middle,final];
   await update(page,results,{searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results}});
   await played(page,'D');await page.waitForFunction(()=>window.resource.autoFinalDone===true);
   assert.equal(await page.getByTitle('当前线路：D · D',{exact:true}).count(),1);await clean(page);
  });
  await test('无基准仍检查编码、速度和码率余量，广告不作硬门槛，有基准必须通过片长核验',async()=>{
   const page=await pageFor(fixture());await page.evaluate(()=>MediaSource.isTypeSupported=()=>false);
   const results=[line('B',720,{durationMatch:undefined}),line('C',1080,{durationMatch:'short'}),line('D',2160,{durationMatch:'long'}),
    line('slow',4320,{throughputMbps:2.9}),line('ads',4320,{adLevel:'dirty'}),line('codec',4320,{codec:'hevc'}),
    line('bitrate',4320,{bitrateKbps:30000,throughputMbps:40})];
   assert.deepEqual(await page.evaluate(results=>window.selection.qualifiedRecommendations(results).map(r=>r.siteKey),results),['ads','D','C','B']);
   for(const refDurationS of [2700,7200]){
    assert.deepEqual(await page.evaluate(({results,refDurationS})=>window.selection.qualifiedRecommendations(results,refDurationS).map(r=>r.siteKey),{results,refDurationS}),['ads']);
   }
   assert.equal(results[1].metrics.durationMatch,'short');await clean(page);
  });
  await test('没有基准时当前线路片长标记不构成同清晰度升级理由',async()=>{
   const current=line('B',1080,{durationMatch:'short',scores:{total:0.1}}),other=line('C',1080,{scores:{total:1}});
   const page=await pageFor(fixture([origin,current],{mediaType:'movie',movieDuration:''}));
   await page.clock.runFor(12000);await played(page,'B');await update(page,[origin,current,other]);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');await clean(page);
  });
  await test('历史资源没有基准片长时也会提示更优线路，点击后才切换',async()=>{
   const better=line('B',1080,{durationMatch:undefined});
   const page=await pageFor(fixture([origin,better],{mediaType:'series',movieDuration:'共18集',initialAutoPlayPending:false,awaitScan:false,autoUpgradeEligible:false,restoredPick:true,
    searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[origin,better]}}));
   await played(page,'origin');const notice=page.getByRole('status',{name:'更优线路提示'});await notice.waitFor();
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await played(page,'B');await clean(page);
  });
  await test('剧集有基准片长也必须核验，未知或异常不能升级，正常后才允许升级',async()=>{
   const page=await pageFor(fixture([origin,b],{mediaType:'series',movieDuration:'45分钟 / 集'}));
   await page.clock.runFor(12000);await played(page,'B');
   await update(page,[origin,b,line('C',1080,{durationMatch:undefined}),line('D',2160,{durationMatch:'short'})]);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'B');
   await update(page,[origin,b,c]);await played(page,'C');
   await page.waitForFunction(()=>window.resource.autoDuringDone===true);await clean(page);
  });
  await test('基准片长解析与探测接口一致，空值、集数及零分钟均视为没有基准',async()=>{
   const page=await pageFor(fixture());
   for(const [duration,expected] of [['118分钟',7080],['45分钟 / 集',2700],['共18集',undefined],['4K',undefined],['',undefined],['0分钟',undefined],[undefined,undefined]]){
    assert.equal(await page.evaluate(duration=>window.referenceDurationSeconds(duration),duration),expected);
   }
   const result=line('B',1080,{durationMatch:undefined});
   assert.deepEqual(await page.evaluate(result=>[undefined,0,-1,Infinity,NaN].map(ref=>window.selection.qualifiedRecommendations([result],ref).length),result),[1,1,1,1,1]);
   await clean(page);
  });
  await test('有基准时未知片长、编码不兼容、吞吐不足、码率余量不足不算合格推荐',async()=>{
   const page=await pageFor(fixture());
   await page.evaluate(()=>MediaSource.isTypeSupported=()=>false);
   const results=[b,line('C',2160,{durationMatch:undefined}),line('D',2160,{throughputMbps:2.9}),line('E',2160,{bitrateKbps:30000,throughputMbps:40}),line('HEVC',2160,{codec:'hevc'}),line('unknown',2160,{codec:'unknown'}),line('ads',2160,{adLevel:'dirty'})];
   assert.deepEqual(await page.evaluate(results=>window.selection.qualifiedRecommendations(results,7200).map(r=>r.siteKey),results),['ads','B']);
   assert.equal(await page.evaluate(c=>window.selection.isMeaningfulUpgrade(c,undefined),c),false);
   await clean(page);
  });
  await test('失败线路移出推荐，全部线路保留置灰禁用，不能重复选择',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));
   await played(page,'origin');await page.evaluate(()=>window.failPlayback='B');
   await page.getByTitle('切换到 B · B（综合最佳）').click();
   await failed(page,'B');assert.equal(await page.getByTitle(/^切换到 B · B/).count(),0);
   await page.getByText('点击卡片可查看全部线路并更换').locator('..').locator('..').getByRole('button').first().click();
   const dialog=page.getByRole('dialog',{name:'选择来源与线路'});
   const chip=dialog.getByRole('button').filter({hasText:'B本次会话不可用'});await chip.waitFor();
   assert.equal(await chip.isDisabled(),true);await chip.evaluate(el=>el.click());
   assert.equal(await page.evaluate(()=>window.playerRequests.filter(k=>k==='B').length),1);
   assert.equal(await page.evaluate(()=>window.resource.selected.siteKey),'origin');await clean(page);
  });
  await test('失败状态仅在内存：站内返回及重探保留，刷新页面清除',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));
   await played(page,'origin');const storage=await page.evaluate(()=>[JSON.stringify(localStorage),JSON.stringify(sessionStorage)]);
   await page.evaluate(()=>window.failPlayer='B');await page.getByTitle('切换到 B · B（综合最佳）').click();
   await failed(page,'B');
   await update(page,[origin,b],{searchStartedAt:2});assert.equal(await page.getByTitle(/^切换到 B · B/).count(),0);
   await page.evaluate(()=>{window.fixture=window.resource;window.remount();});await failed(page,'B');
   assert.equal(await page.getByTitle(/^切换到 B · B/).count(),0);
   assert.deepEqual(await page.evaluate(()=>[JSON.stringify(localStorage),JSON.stringify(sessionStorage)]),storage);
   await page.reload();await page.getByTitle('切换到 B · B（综合最佳）').waitFor();
   assert.equal(await page.getByTitle('切换到 B · B（综合最佳）').isEnabled(),true);await clean(page);
  });
  await test('会话失败线路自动初选跳过，其它线路仍然可用',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));
   await played(page,'origin');await page.evaluate(()=>window.failPlayer='B');await page.getByTitle('切换到 B · B（综合最佳）').click();
   await failed(page,'B');
   await page.evaluate(()=>{window.fixture={...window.resource,autoUserPicked:false,initialAutoPlayPending:true,awaitScan:true};window.remount();});
   await page.clock.runFor(12000);await played(page,'origin');
   assert.equal(await page.evaluate(()=>window.playerRequests.filter(k=>k==='B').length),1);await clean(page);
  });
  await test('探测结果被重置后，全部线路仍保留本会话失败线路的禁用标签',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));
   await played(page,'origin');await page.evaluate(()=>window.failPlayer='B');await page.getByTitle('切换到 B · B（综合最佳）').click();
   await failed(page,'B');await update(page,[]);
   await page.getByText('点击卡片可查看全部线路并更换').locator('..').locator('..').getByRole('button').first().click();
   const dialog=page.getByRole('dialog',{name:'选择来源与线路'});await dialog.getByRole('button',{name:'探测失败',exact:true}).click();
   const chip=dialog.getByRole('button').filter({hasText:'B本次会话不可用'});await chip.waitFor();assert.equal(await chip.isDisabled(),true);
   await clean(page);
  });
  await test('自动探测结束后的手动补测只提示，点击才切换，即使最终升级额度未使用',async()=>{
   const page=await pageFor(fixture([b],{selected:b,flags:[{flag:'B',episodes:[{id:'B-episode',number:1,title:'正片'}]}],
    initialAutoPlayPending:false,awaitScan:false,searchEnded:true,automaticScanComplete:true,scan:{...fixture().scan,status:'done',results:[b]}}));
   await played(page,'B');
   await update(page,[b,c,d],{manualProbeStarted:true});
   const notice=page.getByRole('status',{name:'更优线路提示'});await notice.waitFor();
   await page.clock.runFor(9000);assert.equal(await page.evaluate(()=>resource.selected.siteKey),'B');
   assert.deepEqual(await page.evaluate(()=>playerRequests),['B']);
   await notice.getByRole('button',{name:'切换到更优线路'}).click();await played(page,'D');await clean(page);
  });
  await test('开始手动补测会取消尚未交接的自动升级，迟到结果不切换也不误标失败',async()=>{
   const page=await pageFor(fixture());await page.clock.runFor(12000);await played(page,'B');
   await page.evaluate(()=>window.holdPlayer='C');await update(page,[origin,b,c]);await page.waitForFunction(()=>!!releasePlayer);
   await update(page,[origin,b,c],{manualProbeStarted:true});await page.evaluate(()=>releasePlayer());await page.clock.runFor(1);
   assert.equal(await page.evaluate(()=>resource.selected.siteKey),'B');
   assert.equal(await page.evaluate(()=>!!sessionLineFailure('movie','C','C-vod','C')),false);await clean(page);
  });
  await test('三条推荐先后实际播放失败后逐个移除，按规则补位且最多展示三条',async()=>{
   const page=await pageFor(fixture([origin,b,c,d,e],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));
   await played(page,'origin');
   for(const key of ['E','D','C']){
    await page.evaluate(key=>window.failPlayback=key,key);
    await page.getByTitle(new RegExp('^切换到 '+key+' · '+key)).click();await failed(page,key);
    assert.equal(await page.getByTitle(new RegExp('^切换到 '+key+' · '+key)).count(),0);
    assert.ok(await page.locator('button[title^="切换到 "]').count()<=3);
   }
   await page.getByTitle('切换到 B · B（综合最佳）').waitFor();
   await page.getByTitle('当前线路：origin · origin').waitFor();await clean(page);
  });
  await test('4K 有广告优于 1080P 无广告，同清晰度无广告优先，速度和片长门槛保留',async()=>{
   const page=await pageFor(fixture());
   const high=line('C',2160,{adLevel:'dirty',scores:{total:0.1}}),low=line('B',1080,{scores:{total:1}}),cleanHigh=line('D',2160,{scores:{total:0}});
   assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results,7200).map(r=>r.siteKey),[high,low,cleanHigh]),['D','C','B']);
   assert.equal(await page.evaluate(results=>selection.initialCandidate(results,12000,7200).siteKey,[high,low]),'C');
   for(const invalid of [line('C',2160,{adLevel:'dirty',throughputMbps:2}),line('C',2160,{adLevel:'dirty',durationMatch:'short'})])
    assert.equal(await page.evaluate(results=>selection.initialCandidate(results,12000,7200).siteKey,[invalid,low]),'B');
   await clean(page);
  });
  await test('更清晰的慢线保留第三名，不能越过自动升级速度门槛',async()=>{
   const page=await pageFor(fixture());const slow=line('E',4320,{throughputMbps:1}),fast=[line('B',2160),line('C',1080),line('D',720)];
   assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results,7200).slice(0,3).map(r=>r.siteKey),[...fast,slow]),['B','C','E']);
   assert.deepEqual(await page.evaluate(results=>selection.qualifiedRecommendations(results,7200).map(r=>r.siteKey),[...fast,slow]),['B','C','D']);
   const equal=line('E',2160,{throughputMbps:1});
   assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results,7200).slice(0,3).map(r=>r.siteKey),[...fast,equal]),['B','C','D']);
   const invalid=line('E',4320,{throughputMbps:1,durationMatch:'short'});
   assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results,7200).slice(0,3).map(r=>r.siteKey),[...fast,invalid]),['B','C','D']);await clean(page);
  });
  await test('不足十分钟严格排除，600秒正常，只有全部明确为短片才能兜底',async()=>{
   const page=await pageFor(fixture());const short=line('B',4320,{durationS:599}),normal=line('C',720,{durationS:600});
   for(const ref of [undefined,7200]){
    assert.deepEqual(await page.evaluate(({results,ref})=>selection.displayRecommendations(results,ref).map(r=>r.siteKey),{results:[short,normal],ref}),['C']);
    assert.deepEqual(await page.evaluate(({results,ref})=>selection.qualifiedRecommendations(results,ref).map(r=>r.siteKey),{results:[short,normal],ref}),['C']);
   }
   for(const durationS of [undefined,0,NaN,Infinity]){
    const unknown=line('C',720,{durationS});
    assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results).map(r=>r.siteKey),[short,unknown]),['C']);
   }
   const shorts=[short,line('C',1080,{durationS:300}),line('D',720,{durationS:60})];
   assert.equal(await page.evaluate(results=>selection.displayRecommendations(results).length,shorts),3);
   assert.equal(await page.evaluate(results=>selection.qualifiedRecommendations(results).length,shorts),0);
   await clean(page);
  });
  await test('慢线保留位置不能把不足十分钟的超高清线路塞回推荐',async()=>{
   const page=await pageFor(fixture());
   const results=[b,c,d,line('E',4320,{durationS:120,throughputMbps:1})];
   assert.deepEqual(await page.evaluate(results=>selection.displayRecommendations(results).slice(0,3).map(r=>r.siteKey),results),['D','C','B']);await clean(page);
  });
  await test('点击推荐后卡片右侧持续加载，直到备用实际起播后才消失',async()=>{
   const page=await pageFor(fixture([origin,b],{initialAutoPlayPending:false,awaitScan:false,autoUserPicked:true}));await played(page,'origin');
   await page.evaluate(()=>{window.holdPlayer='B';window.suppressPlaying=true;});
   const card=page.getByTitle('切换到 B · B（综合最佳）');await card.click();
   await card.getByRole('status',{name:'正在加载该线路'}).waitFor();assert.equal(await card.isDisabled(),true);
   await page.evaluate(()=>releasePlayer());await page.waitForFunction(()=>loads.length===2);
   assert.equal(await card.getByRole('status',{name:'正在加载该线路'}).count(),1);
   assert.equal(await page.evaluate(()=>resource.selected.siteKey),'origin');
   await page.evaluate(()=>{window.suppressPlaying=false;document.querySelector('video[data-active="false"]').dispatchEvent(new Event('playing'));});
   await played(page,'B');assert.equal(await page.getByRole('status',{name:'正在加载该线路'}).count(),0);await clean(page);
  });
  await test('首次直接点推荐起播也要等 playing 才移除卡片加载动画',async()=>{
   const page=await pageFor(fixture());await page.evaluate(()=>window.suppressPlaying=true);
   await page.getByTitle('切换到 B · B（综合最佳）').click();await played(page,'B');
   await page.getByRole('status',{name:'正在加载该线路'}).waitFor();
   await page.evaluate(()=>{window.suppressPlaying=false;document.querySelector('video[data-active="true"]').dispatchEvent(new Event('playing'));});
   await page.waitForFunction(()=>!document.querySelector('[aria-label="正在加载该线路"]'));await clean(page);
  });
  console.log(count+' browser checks passed');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
