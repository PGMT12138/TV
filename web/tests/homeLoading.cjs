// 运行：node tests/homeLoading.cjs；验证首页片库未就绪时的加载动画/提示，以及就绪后内容渲染。
// 用真实 AppProvider + HomeView，仅替换 api 模块（catalogAll 可控延迟/失败/空库）。
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const movie = (id, patch = {}) => ({ id, title: '测试影片' + id, originalTitle: '', type: 'movie', cover: '', backdrop: '',
  rating: 8.5, year: 2026, duration: '120分钟', genres: ['剧情'], region: '中国大陆', quality: '1080P Ultra',
  tagline: '', description: '测试简介', director: '未知', cast: [], episodes: [], trailerVideoUrl: '',
  accentColor: 'emerald', ...patch });
const api = `export const downloadBase='/api/downloads'; export const api={
 me:async()=>({user:{id:'u1',name:'加载测试',watchTimeHours:0,joinedDate:'2026-09-12'}}),
 favorites:async()=>({list:[]}),history:async()=>({list:[]}),
 toggleFavorite:async movie=>({ok:true,favorited:true,count:1}),
 deviceStatus:async()=>({online:false,name:'',version:''}),
 catalogAll:async()=>{
  if(window.catalogFail) throw new Error('模拟接口失败');
  await new Promise(r=>setTimeout(r,window.catalogDelay??1500));
  return {list:window.catalogList??[${JSON.stringify(movie('m1', { isFeatured: true, isTrending: true }))},${JSON.stringify(movie('m2', { isTrending: true }))}],
          sections:window.catalogSections??[{key:'hot_movie',title:'热门电影',ids:['m1','m2']}]};
 }
};`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {AppProvider, useApp} from './src/context/AppContext';import {HomeView} from './src/views/HomeView';function Capture(){window.app=useApp();return null;}createRoot(document.getElementById('root')).render(<AppProvider><Capture/><HomeView/></AppProvider>);`, resolveDir: root, loader: 'jsx' },
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
    await page.goto('http://home-loading.test/');
    return page;
  }
  async function test (name, fn) { await fn(); count++; console.log('PASS', name); }
  try {
    await test('片库未就绪时展示加载动画与提示，内容区不出现', async () => {
      const page = await pageFor(() => { window.catalogDelay = 1500; });
      const loading = page.locator('#home-loading');
      await loading.waitFor({ state: 'visible', timeout: 1000 });
      const text = await loading.innerText();
      assert.match(text, /正在加载推荐内容/);
      assert.match(text, /首次加载或榜单更新后/);
      assert.equal(await page.locator('#editorial-curations-section').count(), 0);
      await loading.waitFor({ state: 'hidden', timeout: 5000 });
      await page.locator('#editorial-curations-section').waitFor({ state: 'visible' });
      assert.match(await page.locator('#editorial-curations-section').innerText(), /测试影片m1/);
      assert.deepEqual(page.errors, []); await page.close();
    });
    await test('空片库就绪后展示空态提示', async () => {
      const page = await pageFor(() => { window.catalogDelay = 0; window.catalogList = []; window.catalogSections = []; });
      const empty = page.locator('#home-empty');
      await empty.waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await empty.innerText(), /片库还是空的/);
      assert.deepEqual(page.errors, []); await page.close();
    });
    await test('接口失败后展示空态提示（catalogReady 置位，不卡加载态）', async () => {
      const page = await pageFor(() => { window.catalogFail = true; });
      const empty = page.locator('#home-empty');
      await empty.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('#home-loading').count(), 0);
      assert.deepEqual(page.errors, []); await page.close();
    });
    await test('轮播位收藏按钮可点击（不被简介操作区覆盖层挡住）', async () => {
      const page = await pageFor(() => { window.catalogDelay = 0; });
      await page.locator('#hero-spotlight-banner').waitFor({ state: 'visible', timeout: 5000 });
      const fav = page.locator('#hero-spotlight-banner button[aria-label="添加收藏"]');
      await fav.waitFor({ state: 'visible', timeout: 5000 });
      await fav.click();
      await page.locator('#hero-spotlight-banner button[aria-label="取消收藏"]').waitFor({ state: 'visible', timeout: 5000 });
      assert.deepEqual(page.errors, []); await page.close();
    });
    await test('详情/搜索等二级数据合并不会冲掉轮播标记（幻灯片不缩水）', async () => {
      const page = await pageFor(() => { window.catalogDelay = 0; });
      await page.locator('#hero-spotlight-banner').waitFor({ state: 'visible', timeout: 5000 });
      const slides = page.locator('#hero-spotlight-banner button[aria-label^="Slide "], #hero-spotlight-banner button[aria-label^="Slide"]');
      const before = await slides.count();
      assert.ok(before >= 2, `初始幻灯片应有 2 帧(m1 featured + m2 trending), 实际 ${before}`);
      // 模拟二级接口(详情/搜索/收藏)返回不带标记的同一影片:m1 显式 isFeatured:false
      await page.evaluate(() => {
        const m = window.app.movies.find((x) => x.id === 'm1');
        window.app.mergeMovies([{ ...m, isFeatured: false, isTrending: false, description: '详情补全' }]);
      });
      await page.waitForTimeout(200);
      const after = await slides.count();
      assert.equal(after, before, '合并后幻灯片数量不应减少');
      const stillFeatured = await page.evaluate(() => window.app.movies.find((x) => x.id === 'm1').isFeatured);
      assert.equal(stillFeatured, true, 'mergeMovies 应保留原有轮播标记');
      assert.deepEqual(page.errors, []); await page.close();
    });
    console.log(`${count} home loading checks passed`);
  } finally { await browser.close(); }
})().catch(err => { console.error('验收失败', err); process.exitCode = 1; });
