import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-vercel-build.mjs <build-directory>');
const destination = resolve(process.argv[2]);
for (const name of ['api/index.mjs', 'data/index.html', 'data/bridge.js', 'data/theme.css', 'data/singbox-rules.json.gz', 'data/singbox-rules.LICENSE', 'data/singbox-rules.NOTICE.md', 'LICENSE', 'NOTICE.md', 'package.json', 'vercel.json']) {
  const info = await stat(join(destination, name));
  assert.ok(info.isFile() && info.size > 0, `Missing or empty build asset: ${name}`);
}
const config = JSON.parse(await readFile(join(destination, 'vercel.json'), 'utf8'));
assert.equal(config.functions['api/index.mjs'].includeFiles, 'data/**');
assert.ok(config.rewrites.some(rule => rule.source === '/(.*)' && rule.destination === '/api/index'));

// Test only public local routes. Never use real Worker credentials.
process.env.VERCEL = '1';
for (const key of ['w', 'PANEL_TOKEN', 'panel_token', 'CFNEW_ALLOW_PRIVATE']) delete process.env[key];
const { default: handler } = await import(pathToFileURL(join(destination, 'api/index.mjs')).href);
assert.equal(typeof handler?.fetch, 'function');
const request = (path, options) => handler.fetch(new Request('https://panel.example' + path, options));
const securityHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const checkHeaders = response => {
  for (const [name, expected] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), expected, name);
};
const landing = await request('/');
assert.equal(landing.status, 200); checkHeaders(landing);
assert.match(await landing.text(), /连接控制台/);
const health = await request('/health');
assert.equal(health.status, 200); checkHeaders(health);
const state = await health.json();
assert.equal(state.ok, true);
assert.equal(state.boundWorker, false);
assert.equal(state.tokenRequired, false);
assert.equal(typeof state.version, 'string');
const head = await request('/', { method: 'HEAD' });
assert.equal(head.status, 200); checkHeaders(head);
assert.equal(await head.text(), '');
for (const path of ['/server.mjs', '/api/index.mjs', '/package.json', '/.env']) {
  const response = await request(path);
  assert.equal(response.status, 404, path); checkHeaders(response);
}
const license = await request('/rules-license');
assert.equal(license.status, 200);
assert.ok((await license.text()).trim().length > 0);
const body = new ReadableStream({ start(controller) {
  controller.enqueue(new Uint8Array(1048576));
  controller.enqueue(new Uint8Array(1));
  controller.close();
} });
const oversized = await request('/api/preferred/list', { method: 'POST', body, duplex: 'half' });
assert.equal(oversized.status, 413); checkHeaders(oversized);
assert.equal((await oversized.json()).success, false);
process.env.PANEL_TOKEN = 'ci-only-not-a-real-secret';
try {
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/', { headers: { 'x-panel-token': process.env.PANEL_TOKEN } })).status, 200);
  assert.equal((await request('/health')).status, 200);
} finally {
  delete process.env.PANEL_TOKEN;
}
console.log('Vercel package smoke checks passed (assets, routes, headers, body limit, token gate).');
