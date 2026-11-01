#!/usr/bin/env node
// Run the existing selector in dry-run mode, then gate yx writes on CDN download tests.
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPublicAddress } from '../src/preferred.mjs';

export function numberOption(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid numeric setting: ${value}`);
  return n;
}
export function parseCandidates(output) {
  const line = output.trim().split(/\r?\n/).at(-1) || '';
  return line.split(',').map(raw => {
    const match = raw.match(/^(\[[^\]]+\]|[^:#]+):(\d+)#小健优选-(DX|LT|YD|YX)$/);
    if (!match) throw new Error('Unexpected selector output; refusing to write');
    const host = match[1].replace(/^\[|\]$/g, '');
    const port = Number(match[2]);
    if (!isIP(host) || !isPublicAddress(host) || ![443,2053,2083,2087,2096,8443].includes(port)) return null;
    return { host, port, tag: match[3] };
  }).filter(Boolean);
}
export function chooseFast(results, minimum, perLine) {
  const selected = [], seen = new Set();
  for (const tag of ['DX','LT','YD','YX']) {
    const group = results.filter(row => row.tag === tag && row.speeds.length && row.speeds.every(n => Number.isFinite(n) && n >= minimum));
    group.sort((a,b) => Math.min(...b.speeds) - Math.min(...a.speeds));
    let count = 0;
    for (const row of group) {
      const key = `${row.host}:${row.port}`;
      if (seen.has(key)) continue;
      selected.push(row); seen.add(key);
      if (++count >= perLine) break;
    }
  }
  return selected;
}
export function measureDownload(target, options, requestFn = httpsRequest, now = () => performance.now()) {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('DOWNLOAD_URL must be HTTPS without credentials');
  if (url.port && url.port !== '443') throw new Error('DOWNLOAD_URL must use the default HTTPS port');
  const maxBytes = options.maxBytes;
  return new Promise((resolve, reject) => {
    let req, res, timer, interval, done = false, bytes = 0, valid = false;
    const started = now();
    function finish(error) {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(interval);
      const elapsed = now() - started;
      res?.destroy(); req?.destroy();
      if (error) reject(error);
      else if (!valid || bytes < 1048576 || elapsed <= 0) reject(new Error(`Insufficient download sample: ${bytes} bytes in ${Math.round(elapsed)}ms`));
      else resolve({ mbps: bytes / 1000000 / (elapsed / 1000), bytes, elapsedMs: elapsed });
    }
    try {
      req = requestFn(url, {
        port: target.port, servername: url.hostname, agent: false,
        headers: { Host: url.hostname, 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'cfnew-download-gate/1.0' },
        lookup: (_host, opt, cb) => opt?.all ? cb(null,[{address:target.host,family:isIP(target.host)}]) : cb(null,target.host,isIP(target.host)),
      }, response => {
        res = response;
        const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
        if (res.statusCode !== 200 || encoding !== 'identity' || !/^application\/octet-stream\b/i.test(String(res.headers['content-type'] || ''))) {
          finish(new Error(`HTTP ${res.statusCode}; content-type=${res.headers['content-type'] || 'none'}; encoding=${encoding}`)); return;
        }
        valid = true;
        res.on('data', chunk => { bytes += Math.min(chunk.length, maxBytes - bytes); if (bytes >= maxBytes) finish(); });
        res.on('end', () => finish());
        res.on('aborted', () => finish(new Error(`Download aborted after ${bytes} bytes`)));
        res.on('error', finish);
      });
      req.on('error', finish);
      timer = setTimeout(() => finish(new Error(`Download timeout after ${bytes} bytes`)), options.timeoutMs);
      interval = setInterval(() => { if (now() - started >= options.durationMs) finish(); }, 100);
      req.end();
    } catch (error) { finish(error); }
  });
}
async function collect(env) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[fileURLToPath(new URL('./auto-preferred.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
    let output = '', size = 0;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8*1024*1024) child.kill(); else output += chunk; });
    // Do not forward child logs: they may contain the UUID or subscription URL.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 600000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); status === 0 && size <= 8*1024*1024 ? resolve(parseCandidates(output)) : reject(new Error('Candidate selection failed; existing yx unchanged')); });
  });
}
async function main() {
  const env = process.env;
  const perLine = Math.floor(numberOption(env.PER_LINE,5,1,20));
  const count = Math.floor(numberOption(env.DOWNLOAD_CANDIDATES_PER_LINE,10,perLine,30));
  const minimum = numberOption(env.MIN_DOWNLOAD_MBPS,5,0.01,1000);
  const rounds = Math.floor(numberOption(env.DOWNLOAD_ROUNDS,2,1,3));
  const minOk = Math.floor(numberOption(env.MIN_OK,3,1,60));
  const options = {
    url: env.DOWNLOAD_URL || 'https://speed.cloudflare.com/__down?bytes=25000000',
    durationMs: numberOption(env.DOWNLOAD_DURATION_MS,5000,1000,15000),
    timeoutMs: numberOption(env.DOWNLOAD_TIMEOUT_MS,10000,2000,30000),
    maxBytes: Math.floor(numberOption(env.DOWNLOAD_MAX_BYTES,25000000,1048576,200000000)),
  };
  if (options.timeoutMs <= options.durationMs) throw new Error('Download timeout must exceed duration');
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid DOWNLOAD_URL');
  if (!env.WORKER_HOST && !env.WORKER) throw new Error('WORKER_HOST required');
  if (!env.UUID && !env.CFNEW_UUID) throw new Error('UUID required');
  console.log(`[speed] runner-to-CDN only; not a China-wide or proxy throughput test. Minimum ${minimum} MB/s (decimal), rounds=${rounds}`);
  console.log(`[speed] sequential downloads; at most ${count*3*rounds*options.maxBytes/1e9} GB for DX/LT/YD samples`);
  const candidates = await collect({...env,DRY_RUN:'1',SKIP_PROBE:'0',PER_LINE:String(count)});
  const results = [];
  for (const target of candidates) {
    const row = {...target,speeds:[]};
    try {
      for (let i=0;i<rounds;i++) {
        const result = await measureDownload(target,options);
        row.speeds.push(result.mbps);
        if (result.mbps < minimum) break;
      }
      if (row.speeds.length === rounds && row.speeds.every(n => n >= minimum)) results.push(row);
      console.log(`[speed] ${target.host}:${target.port} ${row.speeds.map(n=>n.toFixed(2)).join('/')} MB/s`);
    } catch (error) { console.log(`[speed] ${target.host}:${target.port} failed: ${error.message}`); }
  }
  const selected = chooseFast(results,minimum,perLine);
  if (selected.length < minOk) throw new Error(`Only ${selected.length} passed; MIN_OK=${minOk}; existing yx unchanged`);
  const yx = selected.map(t=>`${isIP(t.host)===6?'['+t.host+']':t.host}:${t.port}#小健优选-${t.tag}`).join(',');
  if (/^(1|true)$/i.test(env.DRY_RUN || '')) { console.log('[speed] DRY_RUN; no config written'); console.log(yx); return; }
  const worker = new URL(/^https?:\/\//i.test(env.WORKER_HOST || env.WORKER) ? env.WORKER_HOST || env.WORKER : 'https://'+(env.WORKER_HOST || env.WORKER));
  if (worker.protocol !== 'https:' || worker.username || worker.password || worker.search || worker.hash || worker.pathname !== '/' || worker.port) throw new Error('Invalid Worker origin');
  const uuid = env.UUID || env.CFNEW_UUID;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uuid)) throw new Error('Invalid UUID');
  let endpoint = `${worker.origin}/${uuid}/api/config`;
  if (env.PANEL_URL) {
    const panel = new URL(env.PANEL_URL);
    if (panel.protocol !== 'https:' || panel.username || panel.password || panel.search || panel.hash || panel.pathname !== '/') throw new Error('Invalid PANEL_URL');
    endpoint = `${panel.origin}/worker-api/${Buffer.from(worker.origin).toString('base64url')}/${uuid}/api/config`;
  }
  const headers = {'Content-Type':'application/json',Accept:'application/json',...(env.PANEL_TOKEN?{'x-panel-token':env.PANEL_TOKEN}:{})};
  // Patch yx only; retain all other settings. No write is attempted before the gate passes.
  const response = await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({yx}),signal:AbortSignal.timeout(15000)});
  const data = await response.json();
  if (!response.ok || data.success !== true) throw new Error(`Write not confirmed (HTTP ${response.status}); check Worker before retrying`);
  console.log(`[speed] Wrote ${selected.length} entries to yx; refresh your existing subscription`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('[speed] Failed; no speed guarantee. Check configuration/network. If a write was attempted, verify Worker state.'); process.exitCode=1; });
