// web/src/api/client.js
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export default {
  loadConfig: (url) => api.get('/config', { params: { url } }).then(r => r.data),
  reloadConfig: (url) => api.get('/config/reload', { params: { url } }).then(r => r.data),

  home: (config, site, filter) => api.get('/home', { params: { config, site, filter } }).then(r => r.data),
  homeVod: (config, site) => api.get('/homeVod', { params: { config, site } }).then(r => r.data),
  category: (config, site, tid, pg, filter, extend) =>
    api.get('/category', { params: { config, site, tid, pg, filter, extend: JSON.stringify(extend || {}) } }).then(r => r.data),
  detail: (config, site, id) => api.get('/detail', { params: { config, site, id } }).then(r => r.data),
  search: (config, site, wd, quick) => api.get('/search', { params: { config, site, wd, quick } }).then(r => r.data),
  play: (config, site, flag, id) => api.get('/play', { params: { config, site, flag, id } }).then(r => r.data),
  live: (config, name) => api.get('/live', { params: { config, name } }).then(r => r.data),

  proxyUrl: (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
  imgUrl: (url) => url ? `/api/img?url=${encodeURIComponent(url)}` : ''
};
