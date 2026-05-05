// server/proxy/handler.js
import axios from 'axios';

export async function proxyRequest(url, headers = {}) {
  const resp = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...headers
    },
    timeout: 15000,
    responseType: 'arraybuffer'
  });
  return {
    data: resp.data,
    contentType: resp.headers['content-type'] || 'application/octet-stream',
    status: resp.status
  };
}
