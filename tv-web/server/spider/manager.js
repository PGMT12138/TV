// server/spider/manager.js
import axios from 'axios';
import { createSpiderSandbox, callSpiderMethod } from './sandbox.js';

const spiderCache = new Map();

async function fetchSpiderCode(apiUrl, baseUrl) {
  let url = apiUrl;
  if (apiUrl.startsWith('./') || apiUrl.startsWith('../')) {
    const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    url = new URL(apiUrl, base).href;
  }
  const { data } = await axios.get(url, { timeout: 15000 });
  return typeof data === 'string' ? data : JSON.stringify(data);
}

export async function getSpider(site, baseUrl) {
  const cacheKey = site.key;
  const cached = spiderCache.get(cacheKey);
  if (cached) return cached;

  if (site.type !== 3 || !site.api.endsWith('.js')) {
    throw new Error(`Unsupported spider type: ${site.type} api: ${site.api}`);
  }

  const code = await fetchSpiderCode(site.api, baseUrl);
  const sandbox = await createSpiderSandbox(code, site.api, site.ext);

  const spider = {
    key: site.key,
    name: site.name,
    sandbox,

    async home(filter = true) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'home', filter);
    },
    async homeVod() {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'homeVod');
    },
    async category(tid, pg, filter, extend) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'category', tid, pg || '1', filter ?? false, extend || {});
    },
    async detail(id) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'detail', id);
    },
    async search(key, quick) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'search', key, quick ?? false);
    },
    async play(flag, id, vipFlags) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'play', flag, id, vipFlags || []);
    },
    async live(url) {
      return callSpiderMethod(sandbox.spiderObj, sandbox.context, 'live', url);
    },
    async destroy() {
      try {
        callSpiderMethod(sandbox.spiderObj, sandbox.context, 'destroy');
      } catch {}
      spiderCache.delete(cacheKey);
    }
  };

  spiderCache.set(cacheKey, spider);
  return spider;
}

export function clearSpiders() {
  for (const spider of spiderCache.values()) {
    try { spider.destroy(); } catch {}
  }
  spiderCache.clear();
}
