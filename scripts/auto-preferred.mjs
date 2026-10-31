#!/usr/bin/env node
/**
 * 全自动三网优选 → 写入 Worker 订阅（yx）
 *
 * 流程:
 *   1. 拉取电信 / 联通 / 移动候选列表（可配置多个源，自动容错）
 *   2. 用你的 Worker 域名做 SNI 探测（期望返回 hello）
 *   3. 每条线路各取延迟最低的 N 个
 *   4. 合并写入 Worker 配置字段 yx（订阅刷新后生效）
 *
 * 用法:
 *   WORKER_HOST=zxj-5tb.pages.dev UUID=xxx node scripts/auto-preferred.mjs
 *   DRY_RUN=1 WORKER_HOST=... UUID=... node scripts/auto-preferred.mjs
 *
 * 环境变量:
 *   WORKER_HOST   必填，Worker/Pages 域名
 *   UUID          必填
 *   PANEL_URL     可选，经面板写入时填
 *   PANEL_TOKEN   可选
 *   SNI           可选，默认等于 WORKER_HOST
 *   PER_LINE      每条线路保留几个，默认 6
 *   CONCURRENCY   探测并发，默认 12
 *   TIMEOUT_MS    超时毫秒，默认 7000
 *   MIN_OK        全局至少成功几个才写入，默认 3
 *   DRY_RUN       1=只测不写
 *   PORT          默认端口 443
 *   RANK_BY       latency=按探测延迟排序（国内网络用）
 *                 source=按数据源顺序+仅过滤可用（GitHub 自动跑推荐）
 *   SKIP_PROBE    1=完全不探测，直接按来源列表写入（最快，略粗）
 *   CT_URLS / CU_URLS / CM_URLS  逗号分隔的候选源（覆盖默认）
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);

const DEFAULT_SOURCES = {
  // 优先国内测速源顺序（列表越靠前越优先）
  ct: [
    'https://bestcf.pages.dev/wetest/ipv4.txt',
    'https://bestcf.pages.dev/uouin/all.txt',
    'https://cf.090227.xyz/ct',
    'https://addressesapi.090227.xyz/ct',
  ],
  cu: [
    'https://bestcf.pages.dev/wetest/ipv4.txt',
    'https://bestcf.pages.dev/uouin/all.txt',
    'https://cf.090227.xyz/cu',
    'https://addressesapi.090227.xyz/cu',
  ],
  cm: [
    'https://bestcf.pages.dev/wetest/ipv4.txt',
    'https://bestcf.pages.dev/uouin/all.txt',
    'https://cf.090227.xyz/cmcc',
    'https://addressesapi.090227.xyz/cmcc',
  ],
  all: [
    'https://bestcf.pages.dev/uouin/all.txt',
    'https://bestcf.pages.dev/wetest/ipv4.txt',
  ],
};

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

function parseSources(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function detectLine(text) {
  const s = String(text || '');
  if (/电信|telecom|\bct\b|CT/i.test(s)) return 'ct';
  if (/联通|unicom|\bcu\b|CU/i.test(s)) return 'cu';
  if (/移动|mobile|cmcc|\bcm\b|CM/i.test(s)) return 'cm';
  return '';
}

function parseTarget(raw, defaultPort, forcedLine = '') {
  let line = String(raw || '').trim();
  if (!line || line.startsWith('#') || /^ip\b/i.test(line)) return null;

  // CSV: IP,端口,延迟,运营商...
  if (line.includes(',')) {
    const parts = line.split(',').map(s => s.trim());
    const host0 = (parts[0] || '').replace(/^\[|\]$/g, '');
    if (isIP(host0)) {
      const port = Number(parts[1]) || defaultPort;
      const name = parts.find((p, i) => i > 1 && /电信|联通|移动|ct|cu|cm/i.test(p)) || parts[3] || parts[2] || forcedLine || host0;
      const isp = forcedLine || detectLine(line) || detectLine(name) || 'all';
      return { host: host0, port, name: String(name).slice(0, 32), line: isp };
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
  if (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) return null;

  const isp = forcedLine || detectLine(name) || detectLine(raw) || 'all';
  return { host, port, name: (name || host).slice(0, 32), line: isp };
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'cfnew-auto-preferred/1.0', Accept: 'text/plain,*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadLineCandidates(lineKey, urls, defaultPort) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    try {
      const text = await fetchText(url);
      let added = 0;
      for (const row of text.split(/\r?\n/)) {
        // wetest 合集：尝试从行内识别运营商；源本身是单线时 forcedLine
        const forced = url.includes('/ct') || url.endsWith('/ct') ? 'ct'
          : url.includes('/cu') || url.endsWith('/cu') ? 'cu'
          : url.includes('cmcc') || url.includes('/cm') ? 'cm'
          : lineKey === 'all' ? '' : lineKey;
        const t = parseTarget(row, defaultPort, forced);
        if (!t) continue;
        // 拉单线源时，过滤明显其他运营商的行（合集源里）
        if (lineKey !== 'all' && t.line && t.line !== 'all' && t.line !== lineKey) continue;
        if (lineKey !== 'all') t.line = lineKey;
        const key = `${t.host}|${t.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        added++;
      }
      console.log(`[fetch] ${lineKey} ${url} +${added}`);
      if (out.length >= 80) break;
    } catch (e) {
      console.log(`[fetch] ${lineKey} ${url} 失败: ${e.message}`);
    }
  }
  return out;
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
        headers: { Host: sni, 'User-Agent': 'cfnew-auto-preferred/1.0', Accept: '*/*' },
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
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run()));
  return out;
}

function hostPort(t) {
  return `${isIP(t.host) === 6 ? `[${t.host}]` : t.host}:${t.port}`;
}

function formatYx(items) {
  // 小健优选-DX/LT/YD（电信/联通/移动）
  const lineTag = { ct: 'DX', cu: 'LT', cm: 'YD', all: 'YX' };
  return items
    .map(t => {
      const tag = lineTag[t.line] || 'YX';
      return `${hostPort(t)}#小健优选-${tag}`;
    })
    .join(',');
}

function workerOrigin(host) {
  return `https://${host.replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
}

function configApiUrl(workerHost, uuid) {
  const panel = env('PANEL_URL').replace(/\/$/, '');
  if (panel) {
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
    'User-Agent': 'cfnew-auto-preferred/1.0',
  };
  const token = env('PANEL_TOKEN');
  if (token) {
    headers['x-panel-token'] = token;
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ yx }) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.success !== true) {
    throw new Error(`写入失败 HTTP ${res.status}: ${data?.message || data?.error || res.statusText}`);
  }
  return data;
}

async function main() {
  const workerHost = env('WORKER_HOST') || env('WORKER');
  const uuid = env('UUID') || env('CFNEW_UUID');
  if (!workerHost || !uuid) {
    console.error('请设置 WORKER_HOST 与 UUID');
    process.exit(1);
  }

  const defaultPort = Math.max(1, Number(env('PORT', '443')) || 443);
  const perLine = Math.max(1, Number(env('PER_LINE', '6')) || 6);
  const concurrency = Math.max(1, Number(env('CONCURRENCY', '12')) || 12);
  const timeout = Math.max(1000, Number(env('TIMEOUT_MS', '7000')) || 7000);
  const minOk = Math.max(1, Number(env('MIN_OK', '3')) || 3);
  const dryRun = env('DRY_RUN') === '1' || env('DRY_RUN').toLowerCase() === 'true';
  const sni = (env('SNI') || workerHost).replace(/^https?:\/\//i, '').replace(/\/$/, '');

  console.log(`[auto] Worker=${workerHost} SNI=${sni} 每线=${perLine} dryRun=${dryRun}`);

  const ctUrls = parseSources(env('CT_URLS'), DEFAULT_SOURCES.ct);
  const cuUrls = parseSources(env('CU_URLS'), DEFAULT_SOURCES.cu);
  const cmUrls = parseSources(env('CM_URLS'), DEFAULT_SOURCES.cm);

  const [ct, cu, cm] = await Promise.all([
    loadLineCandidates('ct', ctUrls, defaultPort),
    loadLineCandidates('cu', cuUrls, defaultPort),
    loadLineCandidates('cm', cmUrls, defaultPort),
  ]);

  // 某条线拉空时，用合集兜底
  let allFallback = [];
  if (!ct.length || !cu.length || !cm.length) {
    allFallback = await loadLineCandidates('all', DEFAULT_SOURCES.all, defaultPort);
  }

  const pool = [];
  const takePool = (list, line) => {
    const base = list.length ? list : allFallback.map(x => ({ ...x, line }));
    for (const t of base) pool.push({ ...t, line });
  };
  takePool(ct, 'ct');
  takePool(cu, 'cu');
  takePool(cm, 'cm');

  // 非标准端口额外补一条 :443（Pages/Worker 常用 443/8443 等）
  const extras = [];
  for (const t of pool) {
    if (!TLS_PORTS.has(t.port)) {
      extras.push({ ...t, port: 443, name: t.name });
    }
  }
  pool.push(...extras);

  // 去重（同 IP:端口保留先出现的线路标签）
  const uniq = [];
  const seen = new Set();
  for (const t of pool) {
    const key = `${t.host}|${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }

  if (!uniq.length) {
    console.error('[auto] 候选为空，请检查网络或更换 CT_URLS/CU_URLS/CM_URLS');
    process.exit(1);
  }
  console.log(`[auto] 候选合计 ${uniq.length}（电信源${ct.length} 联通源${cu.length} 移动源${cm.length}），开始探测…`);

  const rankBy = (env('RANK_BY', 'source') || 'source').toLowerCase();
  const skipProbe = env('SKIP_PROBE') === '1' || env('SKIP_PROBE').toLowerCase() === 'true';
  console.log(`[auto] RANK_BY=${rankBy} SKIP_PROBE=${skipProbe}`);

  let results;
  if (skipProbe) {
    results = uniq.map((t, index) => ({ ...t, ok: true, latency: index + 1, colo: '', error: '' }));
  } else {
    results = await mapPool(uniq, concurrency, async t => {
      const r = await probeCf({ host: t.host, port: t.port, sni, timeout });
      const row = { ...t, ...r };
      console.log(`${row.ok ? 'OK ' : 'ERR'} ${hostPort(t)}  ${row.latency > 0 ? row.latency + 'ms' : '-'}  ${row.colo || '-'}  ${t.line}  ${row.error || ''}`);
      return row;
    });
  }

  const ok = results.filter(r => r.ok);
  // source: 保持候选原有顺序（国内源已按质量排过）；latency: 按本次探测延迟
  const pick = line => {
    const list = ok.filter(r => r.line === line);
    if (rankBy === 'latency') list.sort((a, b) => a.latency - b.latency);
    // source 模式：ok 已是探测过滤后的结果，顺序尽量跟随 uniq
    return list.slice(0, perLine);
  };

  let selected = [...pick('ct'), ...pick('cu'), ...pick('cm')];

  if (selected.length < minOk) {
    const extra = ok
      .filter(r => !selected.some(s => s.host === r.host && s.port === r.port))
      .slice(0, Math.max(0, perLine * 3 - selected.length));
    if (rankBy === 'latency') extra.sort((a, b) => a.latency - b.latency);
    selected = selected.concat(extra);
  }

  console.log(`[auto] 可用 ${ok.length}/${results.length}，拟写入 ${selected.length} 条（排序=${rankBy}）`);
  for (const t of selected) {
    console.log(`  ${hostPort(t)}  ${t.line}  ${t.latency > 0 ? t.latency + 'ms' : ''}  ${t.colo || ''}`);
  }

  if (selected.length < minOk) {
    console.error(`[auto] 成功数 ${selected.length} < MIN_OK=${minOk}，跳过写入`);
    process.exit(2);
  }

  const yx = formatYx(selected);
  if (dryRun) {
    console.log('[auto] DRY_RUN=1，不写入');
    console.log(yx);
    return;
  }

  await pushYx(workerHost, uuid, yx);
  console.log('[auto] 已写入 yx，请在客户端更新订阅');
  console.log(`订阅: https://${sni}/${uuid}/sub`);
}

main().catch(err => {
  console.error('[auto] 失败:', err.message || err);
  process.exit(1);
});
