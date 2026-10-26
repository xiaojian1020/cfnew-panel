import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

const privateTesting = process.env.CFNEW_ALLOW_PRIVATE === 'yes';
const tlsPorts = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const plainPorts = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);

const DNS_CACHE_TTL = 60000;
const DNS_CACHE_MAX = 256;
const dnsCache = new Map();

const listCache = new Map();
const LIST_CACHE_TTL = 60000;
const LIST_CACHE_MAX = 64;
const listInflight = new Map();

const PROBE_CONCURRENCY = 6;
let probeActive = 0;
const probeWaiters = [];

const probeCache = new Map();
const PROBE_SUCCESS_TTL = 45000;
const PROBE_FAIL_TTL = 12000;
const PROBE_CACHE_MAX = 256;
const probeInflight = new Map();

function cachePut(map, key, value, max) {
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

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
  const clean = String(host).replace(/^\[|\]$/g, '').trim();
  if (!isIP(clean) && !/^[a-z0-9.-]+$/i.test(clean)) throw new Error('地址格式无效');

  // 裸 IP 无需 DNS，也不做公网缓存键污染
  if (isIP(clean)) {
    if (!privateTesting && !isPublicAddress(clean)) throw new Error('只能检测公网地址');
    return [{ address: clean, family: isIP(clean) }];
  }

  const cached = dnsCache.get(clean);
  if (cached && cached.expires > Date.now()) return cached.addresses;

  const addresses = await lookup(clean, { all: true });
  if (!addresses.length || (!privateTesting && addresses.some(item => !isPublicAddress(item.address)))) throw new Error('只能检测公网地址');
  cachePut(dnsCache, clean, { expires: Date.now() + DNS_CACHE_TTL, addresses }, DNS_CACHE_MAX);
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

function findHeaderIndex(headers, labels) {
  for (const label of labels) {
    const index = headers.findIndex(value => value.includes(label));
    if (index >= 0) return index;
  }
  return -1;
}

function normalizeEntry(raw, defaultPort = '443') {
  let value = String(raw || '').trim();
  if (!value || value.startsWith('#')) return '';
  // 去掉多余空白
  value = value.replace(/\s+/g, '');

  let name = '';
  const hash = value.indexOf('#');
  if (hash >= 0) {
    name = value.slice(hash + 1).trim();
    value = value.slice(0, hash);
  }

  // [ipv6]:port 或 host:port 或 裸地址
  let host = value;
  let port = defaultPort;
  const v6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = v6[2];
  } else {
    const lastColon = value.lastIndexOf(':');
    if (lastColon > 0 && /^\d{1,5}$/.test(value.slice(lastColon + 1)) && isIP(value) !== 6) {
      host = value.slice(0, lastColon);
      port = value.slice(lastColon + 1);
    }
  }

  host = host.replace(/^\[|\]$/g, '');
  if (!host) return '';
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) port = defaultPort;

  const wrapped = isIP(host) === 6 ? '[' + host + ']' : host;
  return wrapped + ':' + port + (name ? '#' + name : '');
}

export function normalizePreferredList(text, defaultPort = '443') {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return '';
  const headers = lines[0].split(',').map(value => value.trim());
  const ipIndex = headers.findIndex(value => /IP/i.test(value));
  const looksLikeCsv = lines.length > 1 && ipIndex >= 0 && headers.some(value => ['端口', '数据中心', '平均延迟', '下载速度'].some(label => value.includes(label)));

  let entries;
  if (looksLikeCsv) {
    const portIndex = findHeaderIndex(headers, ['端口']);
    const tlsIndex = findHeaderIndex(headers, ['TLS']);
    const nameIndex = findHeaderIndex(headers, ['国家', '城市', '数据中心']);
    entries = lines.slice(1).flatMap(line => {
      const fields = line.split(',').map(value => value.trim());
      if (tlsIndex >= 0 && fields[tlsIndex] && fields[tlsIndex].toLowerCase() !== 'true') return [];
      const host = fields[ipIndex];
      if (!host) return [];
      const wrapped = isIP(host) === 6 ? '[' + host + ']' : host;
      const port = portIndex >= 0 && fields[portIndex] ? fields[portIndex] : defaultPort;
      const name = nameIndex >= 0 && fields[nameIndex] ? fields[nameIndex] : '';
      return [normalizeEntry(wrapped + ':' + port + (name ? '#' + name : ''), defaultPort)].filter(Boolean);
    });
  } else {
    entries = lines.flatMap(line => line.split(',').map(value => normalizeEntry(value, defaultPort)).filter(Boolean));
  }

  // 按 host:port 去重，保留首次出现的备注
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = entry.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.join('\n');
}

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
      cachePut(listCache, cacheKey, { expires: Date.now() + LIST_CACHE_TTL, body }, LIST_CACHE_MAX);
      return body;
    }
    throw new Error('列表来源重定向过多');
  })().finally(() => {
    if (listInflight.get(cacheKey) === pending) listInflight.delete(cacheKey);
  });

  listInflight.set(cacheKey, pending);
  return pending;
}

function probeCacheKey(workerBase, address, port) {
  return String(workerBase).replace(/\/$/, '') + '|' + String(address).trim().toLowerCase() + '|' + Number(port);
}

export async function probePreferred(workerBase, address, port, signal) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || (!tlsPorts.has(numericPort) && !plainPorts.has(numericPort))) throw new Error('请使用 Cloudflare 支持的端口');

  const key = probeCacheKey(workerBase, address, numericPort);
  const cached = probeCache.get(key);
  if (cached && cached.expires > Date.now()) return { ...cached.result, cached: true };

  let pending = probeInflight.get(key);
  if (pending) return pending;

  pending = (async () => {
    await acquireProbeSlot();
    try {
      if (signal?.aborted) throw new Error('检测已取消');
      // 双检缓存：排队期间可能已被其他请求写入
      const again = probeCache.get(key);
      if (again && again.expires > Date.now()) return { ...again.result, cached: true };

      const addresses = await resolveAddress(address);
      const worker = new URL(workerBase);
      const url = new URL((tlsPorts.has(numericPort) ? 'https://' : 'http://') + worker.hostname + ':' + numericPort + '/');
      const started = performance.now();
      let response;
      // 域名含双栈记录时允许正常的地址族回退；每一个实际连接地址都经过公网检查。
      const candidates = addresses.slice(0, 4);
      for (const pinned of candidates) {
        try {
          response = await readPublic(url, { address: pinned, signal, limit: 4096, timeout: 6000 });
          break;
        } catch (error) {
          if (signal?.aborted || pinned === candidates.at(-1)) throw error;
        }
      }
      let result;
      if (!response || response.status !== 200 || response.body.trim() !== 'hello') {
        result = { success: false, latency: -1, colo: '', error: '该地址未连接到精简内核' };
      } else {
        const colo = String(response.headers['cf-ray'] || '').split('-').at(-1);
        result = { success: true, latency: Math.max(1, Math.round(performance.now() - started)), colo: /^[A-Z]{3}$/.test(colo) ? colo : '', vantage: 'server' };
      }
      const ttl = result.success ? PROBE_SUCCESS_TTL : PROBE_FAIL_TTL;
      cachePut(probeCache, key, { expires: Date.now() + ttl, result }, PROBE_CACHE_MAX);
      return result;
    } finally {
      releaseProbeSlot();
    }
  })().finally(() => {
    if (probeInflight.get(key) === pending) probeInflight.delete(key);
  });

  probeInflight.set(key, pending);
  return pending;
}
