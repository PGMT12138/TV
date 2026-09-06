// 验证真实 AppProvider 的扫描生命周期；仅替换网络与 SSE。
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const api = `export const api={
 me:async()=>({user:null}),catalogAll:async()=>({list:[]}),deviceStatus:async()=>({online:true}),
 resourceScan:async(candidates,duration,full,prior)=>{
  window.scanCalls.push({candidates,duration,prior});
  return window.failScan?{error:'模拟失败'}:{scanId:'scan-'+window.scanCalls.length};
 }
};`;
const line = key => ({siteKey:key,siteName:key,vodId:key+'-vod',flag:key,status:'ok'});
const state = keys => ({status:'ready',searchEnded:false,automaticScanComplete:false,
 matches:keys.map(line),flags:[],activeFlagIndex:0,scan:{status:'running',scanId:'',total:0,finished:0,results:[]}});

(async()=>{
 const bundle=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AppProvider,useApp} from './src/context/AppContext';function Capture(){window.app=useApp();return null;}createRoot(document.getElementById('root')).render(<AppProvider><Capture/></AppProvider>);`,resolveDir:root,loader:'jsx'},
 bundle:true,write:false,format:'iife',plugins:[{name:'network-fixture',setup(build){
  build.onResolve({filter:/\/api$/},()=>({path:'api',namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:api,loader:'js'}));
 }}]});
 const browser=await chromium.launch({headless:true});
 let count=0;
 async function pageFor(keys){
  const page=await browser.newPage();page.errors=[];page.on('pageerror',err=>page.errors.push(err.message));
  await page.addInitScript(()=>{
   window.streams={};window.scanCalls=[];
   window.EventSource=class{constructor(url){window.streams[url]=this;}close(){this.closed=true;}};
   window.emit=(id,msg)=>window.streams['/api/resource/scan/'+id].onmessage({data:JSON.stringify(msg)});
  });
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`}));
  await page.goto('http://completion.test/');await page.waitForFunction(()=>window.app?.catalogReady);
  await page.evaluate(s=>window.app.patchResource('movie',s),state(keys));
  await page.waitForFunction(()=>window.app.movieResources.movie?.status==='ready');return page;
 }
 async function clean(page){assert.deepEqual(page.errors,[]);await page.close();}
 async function test(name,fn){await fn();count++;console.log('PASS',name);}
 try{
  await test('最后一条探测结果与 done 同批到达，不重复补测已完成的站点',async()=>{
   const page=await pageFor(['A']);
   await page.evaluate(()=>window.app.mergeMovies([{id:'movie',type:'series',duration:'118分钟'}]));
   await page.waitForFunction(()=>window.app.getMovieById('movie')?.duration==='118分钟');
   await page.evaluate(()=>window.app.patchResource('movie',{scan:undefined,searchEnded:true}));
   await page.waitForFunction(()=>window.app.movieResources.movie.scan===undefined);
   await page.evaluate(()=>window.app.startScan('movie'));await page.waitForFunction(()=>!!window.streams['/api/resource/scan/scan-1']);
   assert.equal(await page.evaluate(()=>window.scanCalls[0].duration),7080);
   await page.evaluate(r=>{window.emit('scan-1',{type:'result',result:r});window.emit('scan-1',{type:'done'});},line('A'));
   await page.waitForFunction(()=>window.app.movieResources.movie.automaticScanComplete===true);
   assert.equal(await page.evaluate(()=>window.scanCalls.length),1);await clean(page);
  });
  await test('搜索新增站点与首轮完成同批提交，补测新站后才标记全部完成',async()=>{
   const page=await pageFor(['A']);
   await page.evaluate(()=>window.app.patchResource('movie',{scan:undefined}));
   await page.waitForFunction(()=>window.app.movieResources.movie.scan===undefined);
   await page.evaluate(()=>window.app.startScan('movie'));await page.waitForFunction(()=>!!window.streams['/api/resource/scan/scan-1']);
   await page.evaluate(({a,b})=>{
    window.app.patchResource('movie',{matches:[a,b],searchEnded:true});
    window.emit('scan-1',{type:'result',result:a});window.emit('scan-1',{type:'done'});
   },{a:line('A'),b:line('B')});
   await page.waitForFunction(()=>!!window.streams['/api/resource/scan/scan-2']);
   assert.deepEqual(await page.evaluate(()=>window.scanCalls[1].candidates.map(c=>c.key)),['B']);
   assert.deepEqual(await page.evaluate(()=>window.scanCalls[1].prior.map(c=>c.siteKey)),['A']);
   assert.equal(await page.evaluate(()=>window.app.movieResources.movie.automaticScanComplete),false);
   await page.evaluate(r=>{window.emit('scan-2',{type:'result',result:r});window.emit('scan-2',{type:'done'});},line('B'));
   await page.waitForFunction(()=>window.app.movieResources.movie.automaticScanComplete===true);
   assert.equal(await page.evaluate(()=>window.scanCalls.length),2);await clean(page);
  });
  await test('探测先结束时等待搜索，搜索结束后再补测',async()=>{
   const page=await pageFor(['A','B']);
   await page.evaluate(a=>window.app.patchResource('movie',{scan:{status:'done',results:[a],finished:1,total:1}}),line('A'));
   await page.waitForFunction(()=>window.app.movieResources.movie.scan.status==='done');
   assert.equal(await page.evaluate(()=>window.scanCalls.length),0);
   await page.evaluate(()=>window.app.patchResource('movie',{searchEnded:true}));
   await page.waitForFunction(()=>window.scanCalls.length===1);
   assert.deepEqual(await page.evaluate(()=>window.scanCalls[0].candidates.map(c=>c.key)),['B']);await clean(page);
  });
  await test('补测启动失败保持未完成，且不会无限自动重试',async()=>{
   const page=await pageFor(['A','B']);
   await page.evaluate(a=>{window.failScan=true;window.app.patchResource('movie',{searchEnded:true,scan:{status:'done',results:[a],finished:1,total:1}});},line('A'));
   await page.waitForFunction(()=>!!window.app.movieResources.movie.scan.error);
   await page.evaluate(()=>window.app.patchResource('movie',{provisional:true}));
   assert.equal(await page.evaluate(()=>window.app.movieResources.movie.automaticScanComplete),false);
   assert.equal(await page.evaluate(()=>window.scanCalls.length),1);await clean(page);
  });
  for(const mode of ['single','batch'])await test(mode+' 手动补测在请求前设置仅提示标记，结果及结束事件不解除标记',async()=>{
   const page=await pageFor(['A','B']);
   await page.evaluate(a=>window.app.patchResource('movie',{searchEnded:true,automaticScanComplete:true,scan:{status:'done',results:[a],finished:1,total:1}}),line('A'));
   await page.waitForFunction(()=>app.movieResources.movie.automaticScanComplete);
   await page.evaluate(mode=>mode==='single'?app.probeSite('movie','B'):app.reprobeSites('movie',['B']),mode);
   await page.waitForFunction(()=>!!streams['/api/resource/scan/scan-1']);
   assert.equal(await page.evaluate(()=>app.movieResources.movie.manualProbeStarted),true);
   await page.evaluate(r=>{emit('scan-1',{type:'result',result:r});emit('scan-1',{type:'done'});},line('B'));
   await page.waitForFunction(()=>app.probingSites.size===0);
   assert.equal(await page.evaluate(()=>app.movieResources.movie.manualProbeStarted),true);
   assert.equal(await page.evaluate(()=>app.movieResources.movie.scan.results.length),2);await clean(page);
  });
  console.log(count+' scan lifecycle checks passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
