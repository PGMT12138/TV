// 运行：node tests/downloadCentering.cjs；回归：播放页的下载面板必须以视口为基准全局居中。
// 起因：#watch-view 带 animate-fade-blur（forwards 保留 transform），fixed 弹窗以它为包含块导致偏移。
// 复用 autoSelection 的 AppContext/api mock，真实 WatchView + DownloadPanel。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const { context, api, fixture } = require('./autoSelection.cjs');
// fixed/居中由 Tailwind 类驱动，必须注入生产 CSS（与 downloads.cjs 同法）
const assetsDir = path.resolve(root, '../manage/static/cine/assets');
const cssFile = path.join(assetsDir, fs.readdirSync(assetsDir).find(f => f.endsWith('.css')));
const css = fs.readFileSync(cssFile, 'utf8');

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WatchView} from './src/views/WatchView';import {MockProvider} from './src/context/AppContext';createRoot(document.getElementById('root')).render(<MockProvider><WatchView/></MockProvider>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', plugins: [{ name: 'fixtures', setup (build) {
      build.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
      build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'context' ? context : api, loader: 'jsx', resolveDir: root }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.errors = [];
    page.on('pageerror', err => page.errors.push(err.message));
    await page.addInitScript(state => {
      window.fixture = state;
      const P = HTMLMediaElement.prototype;
      Object.defineProperties(P, {
        src: { get () { return this._src || ''; }, set (v) { this._src = v; this._paused = true; queueMicrotask(() => { this._ready = 4; this.dispatchEvent(new Event('loadedmetadata')); }); } },
        currentSrc: { get () { return this._src || ''; } }, paused: { get () { return this._paused !== false; } },
        currentTime: { get () { return this._time || 0; }, set (v) { this._time = v; } }, duration: { get () { return 7200; } },
        readyState: { get () { return this._ready || 0; } }, buffered: { get () { return { length: this._ready ? 1 : 0, start: () => 0, end: () => 7200 }; } },
      });
      P.play = function () { this._paused = false; queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve(); };
      P.pause = function () { this._paused = true; };
      P.load = function () {};
    }, fixture());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://download-centering.test/');
    await page.locator('#watch-view').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '下载', exact: true }).waitFor({ timeout: 10000 });
    // 滚动后打开面板：若 fixed 被动画祖先劫持，覆盖层矩形会随滚动偏移
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.getByRole('button', { name: '下载', exact: true }).click();
    const panel = page.locator('section[aria-label="影片下载"]');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    const info = await panel.evaluate(el => {
      const overlay = el.parentElement.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { overlay: { x: overlay.x, y: overlay.y, w: overlay.width, h: overlay.height },
               box: { x: box.x, y: box.y, w: box.width, h: box.height }, vw: innerWidth, vh: innerHeight };
    });
    assert.ok(Math.abs(info.overlay.x) < 1 && Math.abs(info.overlay.y) < 1
      && Math.abs(info.overlay.w - info.vw) < 1 && Math.abs(info.overlay.h - info.vh) < 1,
      `遮罩层未铺满视口（疑似动画祖先成为 fixed 包含块）: ${JSON.stringify(info)}`);
    const cx = info.box.x + info.box.w / 2, cy = info.box.y + info.box.h / 2;
    assert.ok(Math.abs(cx - info.vw / 2) <= 2 && Math.abs(cy - info.vh / 2) <= 2,
      `面板未全局居中: 中心(${cx},${cy}) 视口(${info.vw},${info.vh})`);
    console.log('PASS 播放页下载面板相对视口全局居中（滚动后仍正确）');
    assert.deepEqual(page.errors, []);
  } finally { await browser.close(); }
})().catch(err => { console.error('验收失败', err); process.exitCode = 1; });
