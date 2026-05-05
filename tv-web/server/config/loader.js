// server/config/loader.js
import axios from 'axios';
import { URL } from 'url';

const BASE_URL_CACHE = new Map();

function resolveUrl(base, relative) {
  if (!relative) return '';
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
  if (relative.startsWith('./') || relative.startsWith('../')) {
    const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
    return new URL(relative, baseDir).href;
  }
  return relative;
}

export async function loadConfig(configUrl) {
  const { data } = await axios.get(configUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  let json = typeof data === 'string' ? JSON.parse(data) : data;

  // Handle Depot format: { urls: [...] }
  if (json.urls && Array.isArray(json.urls) && !json.sites) {
    const first = json.urls[0];
    const url = first.url || first;
    return loadConfig(resolveUrl(configUrl, url));
  }

  if (json.msg) throw new Error(json.msg);
  if (!json.sites && !json.lives) throw new Error('Invalid config: no sites or lives');

  const baseUrl = configUrl;

  const sites = (json.sites || []).map(site => ({
    key: site.key,
    name: site.name,
    type: site.type ?? 3,
    api: resolveUrl(baseUrl, site.api),
    ext: resolveUrl(baseUrl, site.ext),
    jar: resolveUrl(baseUrl, site.jar),
    searchable: site.searchable ?? 1,
    quickSearch: site.quickSearch ?? 1,
    changeable: site.changeable ?? 1,
    timeout: site.timeout,
    header: site.header,
    categories: site.categories,
    style: site.style
  })).filter(s => {
    if (s.type === 3) return s.api.endsWith('.js');
    return [0, 1, 4].includes(s.type);
  });

  const parses = (json.parses || []).map(p => ({
    name: p.name,
    type: p.type,
    url: p.url,
    ext: p.ext
  }));

  const lives = (json.lives || []).map(live => ({
    name: live.name,
    url: resolveUrl(baseUrl, live.url),
    api: resolveUrl(baseUrl, live.api),
    ext: live.ext,
    epg: live.epg,
    groups: live.groups,
    boot: live.boot
  }));

  BASE_URL_CACHE.set(configUrl, baseUrl);

  return {
    url: configUrl,
    baseUrl,
    spider: resolveUrl(baseUrl, json.spider),
    sites,
    parses,
    lives,
    wallpaper: resolveUrl(baseUrl, json.wallpaper),
    doh: json.doh || [],
    proxy: json.proxy || [],
    hosts: json.hosts || [],
    headers: json.headers || [],
    ads: json.ads || []
  };
}

export function getBaseUrl(configUrl) {
  return BASE_URL_CACHE.get(configUrl) || configUrl;
}
