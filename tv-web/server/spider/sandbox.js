// server/spider/sandbox.js
import vm from 'node:vm';
import axios from 'axios';
import crypto from 'node:crypto';

function buildSandboxContext(executor) {
  const sandbox = {
    console: {
      log: (...args) => console.log('[spider]', ...args),
      error: (...args) => console.error('[spider]', ...args),
      warn: (...args) => console.warn('[spider]', ...args)
    },
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (id) => clearTimeout(id),
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Math,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    atob: (str) => Buffer.from(str, 'base64').toString('binary'),
    Base64: {
      encode: (str) => Buffer.from(str).toString('base64'),
      decode: (str) => Buffer.from(str, 'base64').toString('utf-8')
    },
    TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : null,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : null,
    Uint8Array: typeof Uint8Array !== 'undefined' ? Uint8Array : null,
    ArrayBuffer: typeof ArrayBuffer !== 'undefined' ? ArrayBuffer : null,
    req: async function(url, options = {}) {
      try {
        const method = (options.method || 'GET').toUpperCase();
        const headers = { ...options.headers };
        if (options['User-Agent']) headers['User-Agent'] = options['User-Agent'];

        const config = { method, url, headers, timeout: options.timeout || 15000 };
        if (options.body || options.data) config.data = options.body || options.data;
        if (options.responseType === 'arraybuffer') config.responseType = 'arraybuffer';

        const resp = await axios(config);
        return {
          content: options.responseType === 'arraybuffer'
            ? Buffer.from(resp.data).toString('base64')
            : typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
          headers: resp.headers,
          code: resp.status
        };
      } catch (e) {
        return { content: '', headers: {}, code: e.response?.status || 0 };
      }
    },
    md5: (str) => crypto.createHash('md5').update(str).digest('hex'),
    md5X: (str) => crypto.createHash('md5').update(str).digest('hex')
  };
  return sandbox;
}

export async function createSpiderSandbox(spiderCode, spiderUrl, ext) {
  const sandbox = buildSandboxContext();

  // Detect CatVod format vs new format
  const isCatvod = spiderCode.includes('__jsEvalReturn');

  // Wrap the spider code to expose the spider object
  const wrappedCode = isCatvod
    ? `${spiderCode}\n; globalThis.__JS_SPIDER__ = __jsEvalReturn;`
    : spiderCode;

  const context = vm.createContext({ ...sandbox, globalThis: sandbox });

  try {
    vm.runInContext(wrappedCode, context, { filename: spiderUrl, timeout: 10000 });
  } catch (e) {
    throw new Error(`Spider init failed for ${spiderUrl}: ${e.message}`);
  }

  const spiderObj = context.__JS_SPIDER__;
  if (!spiderObj) throw new Error(`Spider object not found in ${spiderUrl}`);

  // Call init
  const initArg = isCatvod
    ? { stype: 3, skey: '', ext: typeof ext === 'string' && ext.startsWith('{') ? JSON.parse(ext) : ext }
    : ext;
  if (typeof spiderObj.init === 'function') {
    await vmRunInContext(spiderObj, 'init', context, initArg);
  }

  return { spiderObj, context, isCatvod };
}

function vmRunInContext(obj, method, context, ...args) {
  const callCode = `__JS_SPIDER__.${method}(${args.map((a, i) => `__arg_${i}__`).join(',')})`;
  for (let i = 0; i < args.length; i++) {
    context[`__arg_${i}__`] = args[i];
  }
  const result = vm.runInContext(callCode, context, { timeout: 30000 });
  // Clean up
  for (let i = 0; i < args.length; i++) {
    delete context[`__arg_${i}__`];
  }
  return result;
}

export function callSpiderMethod(spiderObj, context, method, ...args) {
  return vmRunInContext(spiderObj, method, context, ...args);
}
