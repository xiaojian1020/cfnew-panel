import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

const privateTesting = process.env.CFNEW_ALLOW_PRIVATE === 'yes';
const tlsPorts = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const plainPorts = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);

export function isPublicAddress(address) {
  const value = address.toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (value.startsWith('::ffff:') && value.includes('.')) return isPublicAddress(value.slice(7));
  return isIP(value) === 6 && /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:');
}

export async function resolveAddress(host) {
  const clean = String(host).replace(/^\[|\]$/g, '');
  if (!isIP(clean) && !/^[a-z0-9.-]+$/i.test(clean)) throw new Error('地址格式无效');
  const addresses = await lookup(clean, { all: true });
  if (!addresses.length || (!privateTesting && addresses.some(item => !isPublicAddress(item.address)))) throw new Error('只能检测公网地址');
  return addresses;
}

async function readPublic(url, { address, timeout = 8000, limit = 1048576, signal } = {}) {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('来源须为 HTTP 或 HTTPS 地址');
  const pinned = address || (await resolveAddress(url.hostname))[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, agent: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CFnewPanel)', 'Accept': '*/*' },
      lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { request.destroy(new Error('来源内容过大')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => request.destroy(new Error('检测超时')), timeout);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end();
  });
}

export function normalizePreferredList(text, defaultPort = '443') {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return '';
  const headers = lines[0].split(',').map(value => value.trim());
  const ipIndex = headers.findIndex(value => /IP/i.test(value));
  if (lines.length > 1 && ipIndex >= 0 && headers.some(value => ['端口', '数据中心', '平均延迟', '下载速度'].some(label => value.includes(label)))) {
    const portIndex = headers.indexOf('端口'), tlsIndex = headers.indexOf('TLS');
    const nameIndex = ['国家', '城市', '数据中心'].map(label => headers.indexOf(label)).find(index => index >= 0);
    return lines.slice(1).flatMap(line => {
      const fields = line.split(',').map(value => value.trim());
      if (tlsIndex >= 0 && fields[tlsIndex]?.toLowerCase() !== 'true') return [];
      const host = fields[ipIndex];
      if (!host) return [];
      const wrapped = isIP(host) === 6 ? '[' + host + ']' : host;
      return [wrapped + ':' + (portIndex >= 0 ? fields[portIndex] : defaultPort) + (nameIndex !== undefined ? '#' + fields[nameIndex] : '')];
    }).join('\n');
  }
  return lines.flatMap(line => line.split(',').map(value => value.trim()).filter(Boolean)).join('\n');
}

const listCache = new Map();
const LIST_CACHE_TTL = 45000;
const LIST_CACHE_MAX = 64;
const listInflight = new Map();

const PROBE_CONCURRENCY = 5;
let probeActive = 0;
const probeWaiters = [];

function acquireProbeSlot() {
  if (probeActive < PROBE_CONCURRENCY) {
    probeActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => probeWaiters.push(resolve));
}

function releaseProbeSlot() {
  const next = probeWaiters.shift();
  if (next) next();
  else probeActive = Math.max(0, probeActive - 1);
}

export async function fetchPreferredList(value, signal) {
  const cacheKey = String(value).trim();
  const cached = listCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.body;

  let pending = listInflight.get(cacheKey);
  if (pending) return pending;

  pending = (async () => {
    let url = new URL(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await readPublic(url, { signal });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        url = new URL(response.headers.location, url); continue;
      }
      if (response.status !== 200) throw new Error('列表来源返回 HTTP ' + response.status);
      const body = normalizePreferredList(response.body, url.searchParams.get('port') || '443');
      if (listCache.size >= LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value);
      listCache.set(cacheKey, { expires: Date.now() + LIST_CACHE_TTL, body });
      return body;
    }
    throw new Error('列表来源重定向过多');
  })().finally(() => {
    if (listInflight.get(cacheKey) === pending) listInflight.delete(cacheKey);
  });

  listInflight.set(cacheKey, pending);
  return pending;
}

export async function probePreferred(workerBase, address, port, signal) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || (!tlsPorts.has(numericPort) && !plainPorts.has(numericPort))) throw new Error('请使用 Cloudflare 支持的端口');
  await acquireProbeSlot();
  try {
    if (signal?.aborted) throw new Error('检测已取消');
    const addresses = await resolveAddress(address);
    const worker = new URL(workerBase);
    const url = new URL((tlsPorts.has(numericPort) ? 'https://' : 'http://') + worker.hostname + ':' + numericPort + '/');
    const started = performance.now();
    let response;
    // 域名含双栈记录时允许正常的地址族回退；每一个实际连接地址都经过公网检查。
    for (const pinned of addresses.slice(0, 4)) {
      try { response = await readPublic(url, { address: pinned, signal, limit: 4096 }); break; }
      catch (error) { if (signal?.aborted || pinned === addresses.slice(0, 4).at(-1)) throw error; }
    }
    if (!response || response.status !== 200 || response.body.trim() !== 'hello') return { success: false, latency: -1, colo: '', error: '该地址未连接到精简内核' };
    const colo = String(response.headers['cf-ray'] || '').split('-').at(-1);
    return { success: true, latency: Math.max(1, Math.round(performance.now() - started)), colo: /^[A-Z]{3}$/.test(colo) ? colo : '', vantage: 'server' };
  } finally {
    releaseProbeSlot();
  }
}
