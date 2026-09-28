// 运行：node tests/sdRecommendations.cjs；验证「推荐位全是 2K/4K 时补 ≤1080p 流畅备选」。
// 第一部分纯逻辑（Node 直跑 bundle），第二部分真实 WatchView 浏览器渲染（复用 autoSelection 的 mock）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const line = (site, height, extra = {}) => ({ siteKey: site, siteName: site, vodId: site + '-vod', flag: site, status: 'ok',
  metrics: { durationMatch: 'ok', durationS: 7200, codec: 'h264', throughputMbps: 40, bitrateKbps: 1000,
    adLevel: 'clean', height, scores: { total: 0.8 }, ...extra } });
const names = (rs) => rs.map((r) => r.siteKey);

(async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-rec-')), 'bundle.cjs');
  await esbuild.build({ stdin: { contents: `export { displayRecommendations, standardDefinitionRecommendations, FULL_HD_HEIGHT } from ${JSON.stringify(path.join(root, 'src/utils/autoSelection.ts').replaceAll('\\', '/'))};`, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', outfile: tmp });
  const { displayRecommendations, standardDefinitionRecommendations } = require(tmp);

  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('PASS', name); };

  check('推荐位全为 2K/4K：按同一排序给出 ≤1080p 前三条', () => {
    const rs = [line('A', 2160), line('B', 2160), line('C', 1440), line('D', 1080), line('E', 720), line('F', 540), line('G', 2160)];
    assert.deepEqual(names(displayRecommendations(rs).slice(0, 3)), ['A', 'B', 'G']);
    assert.deepEqual(names(standardDefinitionRecommendations(rs)), ['D', 'E', 'F']);
  });
  check('推荐位存在 ≤1080p 线路：不展示流畅备选组', () => {
    const rs = [line('A', 2160), line('B', 1440), line('C', 1080), line('D', 720)];
    assert.deepEqual(standardDefinitionRecommendations(rs), []);
  });
  check('清晰度未知(height=0)不入流畅备选', () => {
    const rs = [line('A', 2160), line('B', 2160), line('C', 1440), line('D', 0)];
    assert.deepEqual(standardDefinitionRecommendations(rs), []);
  });
  check('不可播（hevc 不支持/片长异常）不入流畅备选', () => {
    const rs = [line('A', 2160), line('B', 2160), line('C', 1440), line('D', 1080, { codec: 'hevc' }), line('E', 720, { durationS: 300, durationMatch: 'short' })];
    assert.deepEqual(standardDefinitionRecommendations(rs), []);
  });
  check('低速低清晰度线路保留（要低清晰度本来就是网慢）', () => {
    const rs = [line('A', 2160), line('B', 2160), line('C', 1440), line('D', 1080, { throughputMbps: 1.5 })];
    assert.deepEqual(names(standardDefinitionRecommendations(rs)), ['D']);
  });
  check('不足三条时全部给出，不超过可用数', () => {
    const rs = [line('A', 2160), line('B', 2160), line('C', 2160), line('D', 1080)];
    assert.deepEqual(names(standardDefinitionRecommendations(rs)), ['D']);
  });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  console.log(`${passed} sd recommendation logic checks passed`);

  // ---- 浏览器渲染：WatchView 展示流畅线路分组 ----
  const { context: contextMock, api: apiMock, fixture } = require('./autoSelection.cjs');
  const mk = (site, height, extra = {}) => ({ siteKey: site, siteName: site, vodId: site + '-vod', flag: site, status: 'ok', title: '测试影片', score: 100,
    metrics: { durationMatch: 'ok', durationS: 7200, codec: 'h264', throughputMbps: 40, bitrateKbps: 1000,
      adLevel: 'clean', height, scores: { total: 0.8 }, ...extra } });
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WatchView} from './src/views/WatchView';import {MockProvider} from './src/context/AppContext';createRoot(document.getElementById('root')).render(<MockProvider><WatchView/></MockProvider>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', plugins: [{ name: 'fixtures', setup (build) {
      build.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
      build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'context' ? contextMock : apiMock, loader: 'jsx', resolveDir: root }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.errors = [];
    page.on('pageerror', err => page.errors.push(err.message));
    const state = fixture([mk('origin', 2160), mk('B', 2160), mk('C', 1440), mk('D', 1080, { throughputMbps: 20 }), mk('E', 720, { throughputMbps: 15 }), mk('F', 1080, { codec: 'hevc' })],
      { matches: ['origin', 'B', 'C', 'D', 'E', 'F'].map((s) => ({ siteKey: s, siteName: s, vodId: s + '-vod', flag: s, title: '测试影片', score: 100 })) });
    await page.addInitScript((st) => { window.fixture = st; }, state);
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://sd-rec.test/');
    await page.getByText('推荐线路', { exact: false }).first().waitFor({ timeout: 10000 });
    const sd = page.getByText('流畅线路（≤1080p）', { exact: false });
    await sd.waitFor({ timeout: 5000 });
    assert.ok(await page.getByTitle(/切换到 D · D/).count() >= 1, '流畅组含 D(1080p)');
    assert.ok(await page.getByTitle(/切换到 E · E/).count() >= 1, '流畅组含 E(720p)');
    assert.equal(await page.getByTitle(/切换到 F · F/).count(), 0, 'hevc 不可播不入流畅组');
    assert.deepEqual(page.errors, []);
    console.log('PASS 播放页在推荐全 2K/4K 时展示 ≤1080p 流畅线路分组');
  } finally { await browser.close(); }
})().catch(err => { console.error('验收失败', err); process.exitCode = 1; });
