// 运行：node tests/liveLoading.cjs；验证直播页初始加载/失败的整页反馈与切源提示。
// 真实 AppProvider + LiveView，仅替换 api 模块（liveList 可控延迟/失败）。
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const channel = (name, lines = 1) => ({ name, number: '1', logo: '', lines, epg: false });
const table = { name: '测试源', groups: [{ name: '央视', channels: [channel('CCTV-1'), channel('CCTV-2', 2)] }], lives: [{ name: '测试源' }] };
const api = `export const downloadBase='/api/downloads'; export const api={
 me:async()=>({user:{id:'u1',name:'直播测试',watchTimeHours:0,joinedDate:'2026-09-13'}}),
 favorites:async()=>({list:[]}),history:async()=>({list:[]}),
 catalogAll:async()=>({list:[],sections:[]}),
 deviceStatus:async()=>({online:false,name:'',version:''}),
 liveList:async(live)=>{
  if(window.liveListError) throw new Error(window.liveListError);
  await new Promise(r=>setTimeout(r,window.liveListDelay??1500));
  return JSON.parse(JSON.stringify(window.liveTable||${JSON.stringify(table)}));
 },
 livePlay:async()=>({url:'http://media.test/live.mp4',hls:false,direct:true}),
 liveEpg:async()=>({list:[]}),
 liveFavorites:async()=>({list:[]}),
 liveHistory:async()=>({list:[]}),
 liveProbe:async()=>({list:[],ttl:0}),
 liveGroups:async()=>({name:'x',groups:1,channels:1})
};
export const imgUrl=(u)=>u||'';`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {AppProvider} from './src/context/AppContext';import {LiveView} from './src/views/LiveView';createRoot(document.getElementById('root')).render(<AppProvider><LiveView/></AppProvider>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', plugins: [{ name: 'network-fixture', setup (build) {
      build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: api, loader: 'js' }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  let count = 0;
  async function pageFor (init) {
    const page = await browser.newPage(); page.errors = [];
    page.on('pageerror', err => page.errors.push(err.message));
    await page.addInitScript(init);
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://live-loading.test/');
    return page;
  }
  async function test (name, fn) { await fn(); count++; console.log('PASS', name); }
  try {
    await test('频道表未返回时整页展示加载动画与提示', async () => {
      const page = await pageFor(() => { window.liveListDelay = 1500; });
      const loading = page.locator('#live-loading');
      await loading.waitFor({ state: 'visible', timeout: 1000 });
      const text = await loading.innerText();
      assert.match(text, /正在加载直播源/);
      assert.match(text, /首次加载可能需要几秒钟/);
      await loading.waitFor({ state: 'hidden', timeout: 8000 });
      await page.getByText('直播源', { exact: true }).first().waitFor({ timeout: 5000 });
      assert.deepEqual(page.errors, []); await page.close();
    });
    await test('初始加载失败展示整页错误态，重试后恢复', async () => {
      const page = await pageFor(() => { window.liveListError = '设备未连接'; });
      const err = page.locator('#live-error');
      await err.waitFor({ state: 'visible', timeout: 8000 });
      assert.match(await err.innerText(), /直播源加载失败/);
      await page.evaluate(() => { window.liveListError = null; window.liveListDelay = 0; });
      await err.getByRole('button', { name: '重试' }).click();
      await page.getByText('直播源', { exact: true }).first().waitFor({ timeout: 8000 });
      assert.deepEqual(page.errors, []); await page.close();
    });
    console.log(`${count} live loading checks passed`);
  } finally { await browser.close(); }
})().catch(err => { console.error('验收失败', err); process.exitCode = 1; });
