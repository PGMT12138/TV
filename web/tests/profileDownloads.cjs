// 运行：node tests/profileDownloads.cjs；验证用户信息弹窗的「下载管理」入口能打开/关闭下载面板。
// 真实 AppProvider + UserProfileModal + DownloadPanel，仅替换 api 模块。
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const api = `export const downloadBase='/api/downloads'; export const api={
 me:async()=>({user:{id:'u1',name:'下载入口测试',watchTimeHours:0,joinedDate:'2026-09-13'}}),
 favorites:async()=>({list:[]}),history:async()=>({list:[]}),
 catalogAll:async()=>({list:[],sections:[]}),
 deviceStatus:async()=>({online:false,name:'',version:''}),
 downloadConfig:async()=>({enabled:true,available:true,retentionHours:24}),
 downloads:async()=>({items:[{id:'t1',status:'completed',size:1024,bytes_done:1024,bytes_total:1024,segments_done:0,segments_total:0,file_available:true,expires_at:1789300000,source:{title:'验收电影',episodeName:'正片',siteName:'验收站点',flag:'高清'}}],total:1,enabled:true})
};`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {AppProvider} from './src/context/AppContext';import {UserProfileModal} from './src/components/UserProfileModal';createRoot(document.getElementById('root')).render(<AppProvider><UserProfileModal isOpen onClose={()=>{}}/></AppProvider>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', plugins: [{ name: 'network-fixture', setup (build) {
      build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: api, loader: 'js' }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  let count = 0;
  try {
    const page = await browser.newPage(); page.errors = [];
    page.on('pageerror', err => page.errors.push(err.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://profile-downloads.test/');
    const modal = page.locator('#user-profile-modal');
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    await modal.getByRole('button', { name: '下载管理' }).click();
    const panel = page.locator('section[aria-label="影片下载"]');
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await panel.innerText(), /验收电影/);
    count++; console.log('PASS 用户信息弹窗打开下载管理，任务列表渲染');
    await panel.getByRole('button', { name: '关闭下载面板' }).click();
    await panel.waitFor({ state: 'hidden', timeout: 5000 });
    await modal.waitFor({ state: 'visible', timeout: 2000 });
    count++; console.log('PASS 关闭下载面板回到用户信息弹窗');
    assert.deepEqual(page.errors, []);
    console.log(`${count} profile download checks passed`);
  } finally { await browser.close(); }
})().catch(err => { console.error('验收失败', err); process.exitCode = 1; });
