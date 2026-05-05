// server/index.js
import express from 'express';
import cors from 'cors';
import { loadConfig } from './config/loader.js';
import { getSpider } from './spider/manager.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

const configCache = new Map();

app.get('/api/config', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url parameter required' });

    const cached = configCache.get(url);
    if (cached && Date.now() - cached.time < 300000) {
      return res.json(cached.data);
    }

    const config = await loadConfig(url);
    configCache.set(url, { data: config, time: Date.now() });
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config/reload', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url parameter required' });
    configCache.delete(url);
    const config = await loadConfig(url);
    configCache.set(url, { data: config, time: Date.now() });
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getSiteAndSpider(req) {
  const configUrl = req.query.config;
  const siteKey = req.query.site;
  if (!configUrl || !siteKey) throw new Error('config and site parameters required');

  const cached = configCache.get(configUrl);
  if (!cached) throw new Error('Config not loaded, call /api/config first');

  const site = cached.data.sites.find(s => s.key === siteKey);
  if (!site) throw new Error(`Site not found: ${siteKey}`);

  const spider = await getSpider(site, cached.data.baseUrl);
  return spider;
}

app.get('/api/home', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const filter = req.query.filter !== 'false';
    const result = await spider.home(filter);
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/homeVod', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const result = await spider.homeVod();
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/category', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const { tid, pg, filter } = req.query;
    let extend = {};
    if (req.query.extend) {
      try { extend = JSON.parse(req.query.extend); } catch {}
    }
    const result = await spider.category(tid, pg, filter !== 'false', extend);
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/detail', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const result = await spider.detail(req.query.id);
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const result = await spider.search(req.query.wd, req.query.quick === 'true');
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/play', async (req, res) => {
  try {
    const spider = await getSiteAndSpider(req);
    const result = await spider.play(req.query.flag, req.query.id);
    res.json(JSON.parse(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  try {
    const configUrl = req.query.config;
    if (!configUrl) return res.status(400).json({ error: 'config parameter required' });
    const cached = configCache.get(configUrl);
    if (!cached) return res.status(400).json({ error: 'Config not loaded' });

    const liveName = req.query.name;
    const live = cached.data.lives.find(l => l.name === liveName);
    if (!live) return res.status(404).json({ error: `Live source not found: ${liveName}` });

    if (live.url) {
      const axios = (await import('axios')).default;
      const { data } = await axios.get(live.url, { timeout: 15000 });
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      res.json({ raw: text, live });
    } else {
      res.json(live.groups || []);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
