import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createSubscriptionEngine } from './engine.mjs';
import { isPublicAddress, fetchPreferredList, probePreferred } from './preferred.mjs';
import { PANEL_VERSION, coreRelease } from './release.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const privateTesting = process.env.CFNEW_ALLOW_PRIVATE === 'yes';
const theme = '<style>' + await readFile(new URL('./theme.css', import.meta.url), 'utf8') + '</style>';
const landing = (await readFile(new URL('./index.html', import.meta.url), 'utf8')).replace('__CFNEW_PANEL_VERSION__', PANEL_VERSION).replace('</head>', theme + '</head>');
const bridge = await readFile(new URL('./bridge.js', import.meta.url), 'utf8');
const rulesLicense = await readFile(new URL('./singbox-rules.NOTICE.md', import.meta.url), 'utf8') + '\n' + await readFile(new URL('./singbox-rules.LICENSE', import.meta.url), 'utf8');
const safeJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const preferredAuth = new Map();
const inflightConfig = new Map();
const MAX_CACHE = 128;

function cacheSet(map, key, value) {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
  map.set(key, value);
}

async function authorizePreferred(workerBase, uuid) {
  workerBase = selectWorker(workerBase);
  const key = workerBase + '/' + uuid;
  let entry = preferredAuth.get(key);
  if (!entry || entry.expires < Date.now()) {
    entry = { expires: Date.now() + 45000, pending: loadWorkerConfig(workerBase, uuid) };
    cacheSet(preferredAuth, key, entry);
  }
  try { await entry.pending; }
  catch (error) { if (preferredAuth.get(key) === entry) preferredAuth.delete(key); throw error; }
}

export function normalizeWorker(value) {
  const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入 Worker 域名');
  if (!privateTesting && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) throw new Error('Worker 须使用 HTTPS');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('域名中不要带路径');
  return url.origin;
}

function allowedWorker() {
  const value = String(process.env.w || '').trim();
  if (!value) return '';
  try { return normalizeWorker(value); }
  catch { throw Object.assign(new Error('面板 w 配置无效，请填写 Worker 的 HTTPS 根地址'), { status: 503 }); }
}

function selectWorker(value) {
  const allowed = allowedWorker();
  const workerBase = normalizeWorker(String(value || allowed).trim());
  if (allowed && workerBase !== allowed) throw Object.assign(new Error('此面板仅允许接入指定的 Worker'), { status: 403 });
  return workerBase;
}

export function normalizeAccess(value) {
  const access = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!access || access.length > 2048 || /[?#\\\u0000-\u0020\u007f]/.test(access)) throw new Error('请填写 UUID 或自定义路径');
  let decoded;
  try { decoded = decodeURIComponent(access); } catch { throw new Error('自定义路径格式无效'); }
  if (/[?#\\\u0000-\u0020\u007f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('自定义路径格式无效');
  return uuidPattern.test(access) ? access.toLowerCase() : new URL('/' + access, 'https://path.invalid').pathname.slice(1);
}

const workerAddresses = new Map();
const recentConfig = new Map();

async function resolveWorkerAddress(workerBase) {
  let address = workerAddresses.get(workerBase);
  if (address && address.expires > Date.now()) return address;
  if (address?.pending) return address.pending;

  const hostname = new URL(workerBase).hostname.replace(/^\[|\]$/g, '');
  const pending = lookup(hostname, { all: true }).then(addresses => {
    if (!addresses.length || (!privateTesting && addresses.some(item => !isPublicAddress(item.address)))) {
      throw new Error('Worker 域名必须解析到公网地址');
    }
    const resolved = { ...addresses[0], expires: Date.now() + 90000 };
    cacheSet(workerAddresses, workerBase, resolved);
    return resolved;
  }).catch(error => {
    if (workerAddresses.get(workerBase)?.pending === pending) workerAddresses.delete(workerBase);
    throw error;
  });

  cacheSet(workerAddresses, workerBase, { pending, expires: 0 });
  return pending;
}

// TRUNCATED_FOR_SIZE_WILL_FIX
export async function handlePanel(request) { return new Response('temp'); }
export function createPanelServer() { return createHttpServer(() => {}); }
