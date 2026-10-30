import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';

test('未设置 PANEL_TOKEN 时控制台可访问，设置后无令牌返回 401', async () => {
  delete process.env.PANEL_TOKEN;
  delete process.env.panel_token;
  const { handlePanel } = await import('../server.mjs?' + Date.now());
  const open = await handlePanel(new Request('https://panel.example/'));
  assert.equal(open.status, 200);

  process.env.PANEL_TOKEN = 'secret-token';
  const locked = await import('../server.mjs?' + (Date.now() + 1));
  // 动态 import 有缓存，直接用已加载模块无法切换 env 生效于 panelToken()
  // panelToken 每次读 process.env，无需重载
  const denied = await handlePanel(new Request('https://panel.example/'));
  assert.equal(denied.status, 401);
  const allowed = await handlePanel(new Request('https://panel.example/?token=secret-token'));
  assert.equal(allowed.status, 200);
  const apiDenied = await handlePanel(new Request('https://panel.example/api/preferred/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  assert.equal(apiDenied.status, 401);
  delete process.env.PANEL_TOKEN;
});

test('优选接口开启限流后超额返回 429', async () => {
  delete process.env.PANEL_TOKEN;
  process.env.CFNEW_RATE_LIMIT = '3';
  const { handlePanel } = await import('../server.mjs');
  const body = JSON.stringify({ host: 'https://example.com', uuid: '351c9981-04b6-4103-aa4b-864aa9c91469', url: 'https://example.com/list' });
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const response = await handlePanel(new Request('https://panel.example/api/preferred/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body,
    }));
    last = response.status;
  }
  assert.equal(last, 429);
  process.env.CFNEW_RATE_LIMIT = '0';
});
