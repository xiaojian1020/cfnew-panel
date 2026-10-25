import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVercelRequest } from '../api/index.mjs';

test('Vercel入口返回完整登录页与禁止缓存头，HEAD没有正文', async () => {
  const request = method => new Request('https://panel.example/', { method });
  const response = await handleVercelRequest(request('GET'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /连接你的 Worker/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await (await handleVercelRequest(request('HEAD'))).text(), '');
});

test('Vercel入口按实际流式字节限制请求体，不信任Content-Length', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1048576));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const response = await handleVercelRequest(new Request('https://panel.example/api/preferred/list', { method: 'POST', headers: { 'Content-Length': '1' }, body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).success, false);
});

test('Vercel入口保留健康检查和404，不把运行文件当静态资源暴露', async () => {
  const health = await (await handleVercelRequest(new Request('https://panel.example/health'))).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.version, 'string');
  assert.equal(typeof health.boundWorker, 'boolean');
  assert.equal((await handleVercelRequest(new Request('https://panel.example/health'))).headers.get('x-frame-options'), 'DENY');
  for (const path of ['/server.mjs', '/api/index.mjs', '/package.json', '/.env']) {
    assert.equal((await handleVercelRequest(new Request('https://panel.example' + path))).status, 404, path);
  }
});
