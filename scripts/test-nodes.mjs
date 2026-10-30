#!/usr/bin/env node
/**
 * 节点连通 / 延迟 / 粗测速脚本（零依赖，Node 18+）
 *
 * 用法:
 *   node scripts/test-nodes.mjs 1.1.1.1:443 104.16.1.1:443
 *   node scripts/test-nodes.mjs -f nodes.txt
 *   node scripts/test-nodes.mjs -f nodes.txt --sni worker.example.com --mode cf
 *   node scripts/test-nodes.mjs -f nodes.txt --mode tcp --concurrency 10
 *   node scripts/test-nodes.mjs -f nodes.txt --mode speed --sni worker.example.com
 *
 * nodes.txt 每行支持:
 *   1.1.1.1:443
 *   1.1.1.1:443#备注
 *   [2606:4700::1111]:443#IPv6
 *   # 注释行
 */

import { connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const DEFAULT_TIMEOUT = 6000;

function parseArgs(argv) {
  const args = {
    targets: [],
    file: '',
    mode: 'auto', // auto | tcp | cf | speed
    sni: '',
    concurrency: 8,
    timeout: DEFAULT_TIMEOUT,
    speedUrl: 'https://speed.cloudflare.com/__down?bytes=2000000',
    limit: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--file') args.file = argv[++i] || '';
    else if (a === '--mode') args.mode = String(argv[++i] || 'auto').toLowerCase();
    else if (a === '--sni') args.sni = argv[++i] || '';
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 8);
    else if (a === '--timeout') args.timeout = Math.max(500, Number(argv[++i]) || DEFAULT_TIMEOUT);
    else if (a === '--speed-url') args.speedUrl = argv[++i] || args.speedUrl;
    else if (a === '--limit') args.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!a.startsWith('-')) args.targets.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`节点连通与速度测试

用法:
  node scripts/test-nodes.mjs [选项] [host:port ...]
  node scripts/test-nodes.mjs -f nodes.txt --sni your.worker.dev --mode cf

选项:
  -f, --file <path>       从文件读取节点列表
  --mode <auto|tcp|cf|speed>
                          auto  有 --sni 时用 cf，否则 tcp
                          tcp   仅 TCP 连接延迟
                          cf    HTTPS 访问 / 期望 hello（适合 CF 精简内核优选 IP）
                          speed 在连通基础上做约 2MB 下载测速
  --sni <host>            TLS SNI / Host（cf/speed 模式建议填写 Worker 域名）
  --concurrency <n>       并发数，默认 8
  --timeout <ms>          超时，默认 6000
  --speed-url <url>       测速文件地址
  --limit <n>             只测前 n 个节点
  -h, --help              帮助
`);
}

function parseTarget(raw) {
  let line = String(raw || '').trim();
  if (!line || line.startsWith('#')) return null;
  let name = '';
  const hash = line.indexOf('#');
  if (hash >= 0) {
    name = line.slice(hash + 1).trim();
    line = line.slice(0, hash).trim();
  }
  let host = line;
  let port = 443;
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
  return { host, port, name: name || host, raw: `${isIP(host) === 6 ? `[${host}]` : host}:${port}` };
}

function loadTargets(args) {
  const list = [...args.targets];
  if (args.file) {
    const text = readFileSync(args.file, 'utf8');
    for (const line of text.split(/\r?\n/)) list.push(line);
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const t = parseTarget(item);
    if (!t) continue;
    const key = `${t.host}|${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (args.limit > 0) return out.slice(0, args.limit);
  return out;
}

function tcpPing(host, port, timeout) {
  const start = performance.now();
  return new Promise(resolve => {
    const socket = connect({ host, port, family: isIP(host) === 6 ? 6 : undefined }, () => {
      const ms = Math.max(1, Math.round(performance.now() - start));
      socket.destroy();
      resolve({ ok: true, latency: ms });
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, latency: -1, error: 'timeout' });
    }, timeout);
    socket.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, latency: -1, error: err.message });
    });
    socket.on('close', () => clearTimeout(timer));
  });
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

function httpProbe({ host, port, sni, timeout, path = '/', expectHello = false }) {
  const useTls = TLS_PORTS.has(port);
  const start = performance.now();
  const urlHost = sni || host;
  return new Promise(resolve => {
    const reqFn = useTls ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        host: urlHost,
        port,
        path,
        method: 'GET',
        servername: useTls ? urlHost : undefined,
        lookup: isIP(host) ? pinnedLookup(host) : undefined,
        headers: {
          Host: urlHost,
          'User-Agent': 'cfnew-node-test/1.0',
          Accept: '*/*',
        },
        timeout,
      },
      res => {
        const chunks = [];
        res.on('data', c => {
          chunks.push(c);
          if (Buffer.concat(chunks).length > 8192) res.destroy();
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          const latency = Math.max(1, Math.round(performance.now() - start));
          const colo = String(res.headers['cf-ray'] || '').split('-').at(-1) || '';
          if (expectHello && (res.statusCode !== 200 || body !== 'hello')) {
            resolve({ ok: false, latency, error: `unexpected body/status ${res.statusCode}`, colo });
            return;
          }
          resolve({ ok: res.statusCode > 0 && res.statusCode < 500, latency, status: res.statusCode, colo, body: body.slice(0, 40) });
        });
        res.on('error', err => resolve({ ok: false, latency: -1, error: err.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latency: -1, error: 'timeout' });
    });
    req.on('error', err => resolve({ ok: false, latency: -1, error: err.message }));
    req.end();
  });
}

function downloadSpeed({ host, port, sni, timeout, speedUrl }) {
  const useTls = TLS_PORTS.has(port) || speedUrl.startsWith('https:');
  const target = new URL(speedUrl);
  const start = performance.now();
  let bytes = 0;
  return new Promise(resolve => {
    const reqFn = useTls ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        protocol: target.protocol,
        host: target.hostname,
        servername: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        port: target.port || (useTls ? 443 : 80),
        // 若测的是「经某 IP 访问 CF」，可把 lookup 钉在节点 IP 上
        lookup: isIP(host) ? pinnedLookup(host) : undefined,
        headers: {
          'User-Agent': 'cfnew-node-test/1.0',
          Accept: '*/*',
          Host: target.hostname,
        },
        timeout,
      },
      res => {
        res.on('data', chunk => {
          bytes += chunk.length;
        });
        res.on('end', () => {
          const sec = Math.max(0.001, (performance.now() - start) / 1000);
          const mbps = (bytes * 8) / sec / 1e6;
          resolve({
            ok: res.statusCode === 200 && bytes > 0,
            bytes,
            mbps: Math.round(mbps * 100) / 100,
            latency: Math.max(1, Math.round(performance.now() - start)),
            error: res.statusCode === 200 ? '' : `HTTP ${res.statusCode}`,
          });
        });
        res.on('error', err => resolve({ ok: false, bytes, mbps: 0, latency: -1, error: err.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, bytes, mbps: 0, latency: -1, error: 'timeout' });
    });
    req.on('error', err => resolve({ ok: false, bytes, mbps: 0, latency: -1, error: err.message }));
    req.end();
  });
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function pad(str, n) {
  str = String(str);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const targets = loadTargets(args);
  if (!targets.length) {
    printHelp();
    console.error('错误: 没有可测试的节点。请传入 host:port 或 -f 文件。');
    process.exit(1);
  }

  let mode = args.mode;
  if (mode === 'auto') mode = args.sni ? 'cf' : 'tcp';

  console.log(`模式=${mode}  并发=${args.concurrency}  超时=${args.timeout}ms  节点=${targets.length}${args.sni ? `  SNI=${args.sni}` : ''}`);
  console.log('-'.repeat(88));

  const rows = await mapPool(targets, args.concurrency, async t => {
    const row = { ...t, ok: false, latency: -1, colo: '', speed: '', error: '' };
    try {
      if (mode === 'tcp') {
        const r = await tcpPing(t.host, t.port, args.timeout);
        row.ok = r.ok;
        row.latency = r.latency;
        row.error = r.error || '';
      } else if (mode === 'cf') {
        if (!args.sni) {
          row.error = 'cf 模式需要 --sni Worker域名';
        } else {
          const r = await httpProbe({
            host: t.host,
            port: t.port,
            sni: args.sni,
            timeout: args.timeout,
            expectHello: true,
          });
          row.ok = r.ok;
          row.latency = r.latency;
          row.colo = r.colo || '';
          row.error = r.error || '';
        }
      } else if (mode === 'speed') {
        const probe = args.sni
          ? await httpProbe({ host: t.host, port: t.port, sni: args.sni, timeout: args.timeout, expectHello: false })
          : await tcpPing(t.host, t.port, args.timeout);
        if (!probe.ok) {
          row.ok = false;
          row.latency = probe.latency;
          row.error = probe.error || 'connect failed';
          row.colo = probe.colo || '';
        } else {
          const s = await downloadSpeed({
            host: t.host,
            port: t.port,
            sni: args.sni,
            timeout: Math.max(args.timeout, 15000),
            speedUrl: args.speedUrl,
          });
          row.ok = s.ok;
          row.latency = probe.latency;
          row.speed = s.ok ? `${s.mbps} Mbps` : '';
          row.error = s.error || '';
          row.colo = probe.colo || '';
        }
      } else {
        row.error = `未知模式 ${mode}`;
      }
    } catch (e) {
      row.error = e.message || String(e);
    }
    const flag = row.ok ? 'OK ' : 'ERR';
    console.log(
      `${flag}  ${pad(row.raw, 28)}  ${pad(row.latency > 0 ? row.latency + 'ms' : '-', 8)}  ${pad(row.colo || '-', 5)}  ${pad(row.speed || '-', 12)}  ${row.name}${row.error ? '  (' + row.error + ')' : ''}`,
    );
    return row;
  });

  const ok = rows.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
  const bad = rows.filter(r => !r.ok);
  console.log('-'.repeat(88));
  console.log(`完成: 成功 ${ok.length} / ${rows.length}，失败 ${bad.length}`);
  if (ok.length) {
    console.log('\n延迟最低的前 10 个:');
    for (const r of ok.slice(0, 10)) {
      console.log(`  ${pad(r.latency + 'ms', 8)}  ${pad(r.raw, 28)}  ${r.colo || ''}  ${r.speed || ''}  ${r.name}`);
    }
    console.log('\n可复制为优选列表 (host:port#name):');
    console.log(ok.slice(0, 20).map(r => `${r.raw}${r.name && r.name !== r.host ? '#' + r.name : ''}`).join('\n'));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
