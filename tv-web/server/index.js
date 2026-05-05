// server/index.js
import express from 'express';
import cors from 'cors';
import { loadConfig } from './config/loader.js';

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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
