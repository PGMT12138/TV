// 使用管理端原始 CSS 和 renderSearchSites，验证指标展示、排序与三列布局。
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const html=fs.readFileSync(path.join(__dirname,'templates/index.html'),'utf8');
  const style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const select=html.match(/<select id="siteSort"[\s\S]*?<\/select>/)[0];
  const render=html.slice(html.indexOf('        function renderSearchSites()'),html.indexOf('        async function toggleSearchSite('));
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<style>${style}</style><div id="searchPanel">${select}<div id="siteList"></div></div>`);
    await page.addScriptTag({content:`let searchSites=[];const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');const fmtTime=s=>s||'—';${render}
      window.setSites=sites=>{searchSites=sites;renderSearchSites();};`});
    const site=(key,rate,searchRate)=>({site_key:key,site_name:key,disabled:0,success_rate:searchRate,
      completed_count:10,success_count:1,probe_count:100,probe_result_count:rate==null?0:4,
      probe_success_count:rate==null?0:rate/25,probe_success_rate:rate,avg_probe_duration_ms:1000});
    await page.evaluate(sites=>setSites(sites),[site('A',25,100),site('B',100,25),site('C',null,80),site('D',0,50)]);
    assert.ok(await page.locator('#siteList').textContent().then(t=>t.includes('平均探测成功率') && t.includes('25.0%') && t.includes('线路探测成功 1 / 已统计 4 次')));
    for(const [sort,expected] of [['probe-desc',['B','A','D','C']],['probe-asc',['D','A','B','C']],['success-desc',['A','C','D','B']]]){
      await page.selectOption('#siteSort',sort);
      assert.deepEqual(await page.locator('.site-name').allTextContents(),expected);
    }
    for(const [width,columns] of [[1280,3],[900,2],[390,1]]){
      await page.setViewportSize({width,height:850});
      assert.equal(await page.locator('#siteList').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),columns);
      assert.ok(await page.locator('#siteList').evaluate(el=>el.scrollWidth<=el.clientWidth));
    }
    console.log('PASS 管理端指标展示、三种排序及三种屏幕布局');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
