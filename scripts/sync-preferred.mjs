#!/usr/bin/env node
/**
 * 定期优选 IP：探测候选列表 → 选出最快的 → 写入 Worker 配置 yx → 订阅自动带上新节点
 *
 * 必需环境变量:
 *   WORKER_HOST   Worker 域名，如 xxx.workers.dev 或自定义域
 *   UUID          面板 UUID
 *
 * 可选:
 *   PANEL_URL           经面板转发时填写，如 https://xiaojian.07398888.xyz
 *   PANEL_TOKEN         面板令牌（若启用了 PANEL_TOKEN）
 *   CANDIDATES_FILE     候选 IP 文件（默认 candidates.txt）
 *   CANDIDATES_URL      候选列表 URL（优先于文件）
 *   TOP_N               保留延迟最低的 N 个（默认 15）
 *   CONCURRENCY         探测并发（默认 8）
 *   TIMEOUT_MS          超时毫秒（默认 6000）
 *   PORT                默认端口（默认 443）
 *   DRY_RUN             设为 1 只打印不写入
 *   MIN_OK              至少成功几个才写入（默认 3）
 *
 * 用法:
 *   WORKER_HOST=xxx.workers.dev UUID=... node scripts/sync-preferred.mjs
 *   WORKER_HOST=xxx.workers.dev UUID=... CANDIDATES_FILE=nodes.txt TOP_N=12 node scripts/sync-preferred.mjs
 *   DRY_RUN=1 WORKER_HOST=... UUID=... node scripts/sync-preferred.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function parseTarget(raw, defaultPort) {
  let line = String(raw || '').trim();
  if (!line || line.startsWith('#')) return null;
  // CSV 行：IP地址,端口,... 简单兼容首列 IP
  if (line.includes(',') && /IP/i.test(line) === false) {
    const parts = line.split(',').map(s => s.trim());
    if (parts[0] && isIP(parts[0].replace(/^\[|\]$/g, ''))) {
      const host = parts[0].replace(/^\[|\]$/g, '');
      const port = Number(parts[1]) || defaultPort;
      const name = parts[3] || parts[2] || '';
      return { host, port, name: name || host };
    }
  }
  let name = '';
  const hash = line.indexOf('#');
  if (hash >= 0) {
    name = line.slice(hash + 1).trim();
    line = line.slice(0, hash).trim();
  }
  let host = line;
  let port = defaultPort;
  const v6 = line.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const idx = line.lastIndexOf(':');
    if (idx > 0 && /^\d{1,5}$/.test(line.slice(idx + 1)) && isIP(line) !== 6) {
      host = line.slice(0, idx);
      port = Number(line.slice(idx + 1));
    }
  }
  host = host.replace(/^\[|\]$/g, '').trim();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, name: name || host };
}

async function loadCandidates(defaultPort) {
  const url = env('CANDIDATES_URL');
  let text = '';
  if (url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'cfnew-sync-preferred/1.0' } });
    if (!res.ok) throw new Error(`拉取候选列表失败 HTTP ${res.status}`);
    text = await res.text();
  } else {
    const file = env('CANDIDATES_FILE', 'candidates.txt');
    if (!existsSync(file)) throw new Error(`找不到候选文件: ${file}（或设置 CANDIDATES_URL）`);
    text = readFileSync(file, 'utf8');
  }
  const seen = new Set();
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    const t = parseTarget(line, defaultPort);
    if (!t) continue;
    const key = `${t.host}|${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(t);
  }
  return list;
}

function pinnedLookup(address) {
  const family = isIP(address) === 6 ? 6 : 4;
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function probeCf({ host, port, sni, timeout }) {
  const useTls = TLS_PORTS.has(port);
  const start = performance.now();
  return new Promise(resolve => {
    const reqFn = useTls ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        host: sni,
        port,
        path: '/',
        method: 'GET',
        servername: useTls ? sni : undefined,
        lookup: isIP(host) ? pinnedLookup(host) : undefined,
        headers: { Host: sni, 'User-Agent': 'cfnew-sync-preferred/1.0', Accept: '*/*' },
        timeout,
      },
      res => {
        const chunks = [];
        res.on('data', c => {
          chunks.push(c);
          if (Buffer.concat(chunks).length > 4096) res.destroy();
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          const latency = Math.max(1, Math.round(performance.now() - start));
          const colo = String(res.headers['cf-ray'] || '').split('-').at(-1) || '';
          const ok = res.statusCode === 200 && body === 'hello';
          resolve({ ok, latency, colo, error: ok ? '' : `status=${res.statusCode}` });
        });
        res.on('error', err => resolve({ ok: false, latency: -1, colo: '', error: err.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latency: -1, colo: '', error: 'timeout' });
    });
    req.on('error', err => resolve({ ok: false, latency: -1, colo: '', error: err.message }));
    req.end();
  });
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => run()));
  return out;
}

function formatYx(items) {
  return items
    .map(t => {
      const host = isIP(t.host) === 6 ? `[${t.host}]` : t.host;
      const base = `${host}:${t.port}`;
      const name = t.colo ? `${t.name || t.host}-${t.colo}` : t.name || t.host;
      return `${base}#${name}`;
    })
    .join(',');
}

function workerOrigin(host) {
  const h = host.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `https://${h}`;
}

function configApiUrl(workerHost, uuid) {
  const panel = env('PANEL_URL').replace(/\/$/, '');
  if (panel) {
    // 公共面板: /worker-api/{base64url(origin)}/{uuid}/api/config
    const origin = workerOrigin(workerHost);
    const token = Buffer.from(origin).toString('base64url');
    return `${panel}/worker-api/${token}/${uuid}/api/config`;
  }
  return `${workerOrigin(workerHost)}/${uuid}/api/config`;
}

async function pushYx(workerHost, uuid, yx) {
  const url = configApiUrl(workerHost, uuid);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'cfnew-sync-preferred/1.0',
  };
  const token = env('PANEL_TOKEN');
  if (token) {
    headers['x-panel-token'] = token;
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ yx }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.success !== true) {
    throw new Error(`写入配置失败 HTTP ${res.status}: ${data?.message || data?.error || res.statusText}`);
  }
  return data;
}

async function main() {
  const workerHost = env('WORKER_HOST') || env('WORKER');
  const uuid = env('UUID') || env('CFNEW_UUID');
  if (!workerHost || !uuid) {
    console.error('请设置环境变量 WORKER_HOST 与 UUID');
    process.exit(1);
  }

  const defaultPort = Math.max(1, Number(env('PORT', '443')) || 443);
  const topN = Math.max(1, Number(env('TOP_N', '15')) || 15);
  const concurrency = Math.max(1, Number(env('CONCURRENCY', '8')) || 8);
  const timeout = Math.max(1000, Number(env('TIMEOUT_MS', '6000')) || 6000);
  const minOk = Math.max(1, Number(env('MIN_OK', '3')) || 3);
  const dryRun = env('DRY_RUN') === '1' || env('DRY_RUN').toLowerCase() === 'true';
  const sni = (env('SNI') || workerHost).replace(/^https?:\/\//i, '').replace(/\/$/, '');

  console.log(`[sync-preferred] Worker=${workerHost} SNI=${sni} TOP_N=${topN} dryRun=${dryRun}`);
  const candidates = await loadCandidates(defaultPort);
  if (!candidates.length) {
    console.error('候选列表为空');
    process.exit(1);
  }
  console.log(`[sync-preferred] 候选 ${candidates.length} 个，开始探测…`);

  const results = await mapPool(candidates, concurrency, async t => {
    const r = await probeCf({ host: t.host, port: t.port, sni, timeout });
    const row = { ...t, ...r };
    const flag = row.ok ? 'OK ' : 'ERR';
    console.log(`${flag} ${(isIP(t.host) === 6 ? `[${t.host}]` : t.host) + ':' + t.port}  ${row.latency > 0 ? row.latency + 'ms' : '-'}  ${row.colo || ''}  ${row.error || ''}`);
    return row;
  });

  const ok = results.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
  console.log(`[sync-preferred] 成功 ${ok.length} / ${results.length}`);

  if (ok.length < minOk) {
    console.error(`[sync-preferred] 成功数 ${ok.length} < MIN_OK=${minOk}，跳过写入以免覆盖成空列表`);
    process.exit(2);
  }

  const selected = ok.slice(0, topN);
  const yx = formatYx(selected);
  console.log('[sync-preferred] 将写入的优选列表:');
  for (const t of selected) {
    console.log(`  ${t.latency}ms  ${(isIP(t.host) === 6 ? `[${t.host}]` : t.host)}:${t.port}  ${t.colo || ''}  ${t.name}`);
  }

  if (dryRun) {
    console.log('[sync-preferred] DRY_RUN=1，不写入配置');
    console.log(yx);
    return;
  }

  const data = await pushYx(workerHost, uuid, yx);
  console.log('[sync-preferred] 已写入 Worker 配置 yx，订阅刷新后生效');
  if (data.message) console.log(data.message);
}

main().catch(err => {
  console.error('[sync-preferred] 失败:', err.message || err);
  process.exit(1);
});
