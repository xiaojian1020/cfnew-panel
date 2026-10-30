import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidAddress,
  normalizeNodeHost,
  processNodeAliasPart,
  getNodeAliasBase,
  createNodeNamer,
} from '../engine-nodes.mjs';

test('节点命名工具：IP/域名与别名清洗', () => {
  assert.equal(isValidAddress('1.1.1.1'), true);
  assert.equal(isValidAddress('not-an-ip'), false);
  assert.equal(normalizeNodeHost('[2606:4700::1]'), '2606:4700::1');
  assert.equal(processNodeAliasPart('  Foo Bar  '), 'Foo_Bar');
  assert.equal(processNodeAliasPart('自定义优选-1', 'Node'), 'Node');
  assert.equal(getNodeAliasBase({ domain: 'edge.example', name: '备注' }), '优选域名');
  assert.equal(getNodeAliasBase({ ip: '1.1.1.1', name: '家宽', colo: 'SJC' }), '家宽-SJC');
  const name = createNodeNamer();
  assert.equal(name({ ip: '1.1.1.1', name: 'A' }), 'A-01');
  assert.equal(name({ ip: '1.0.0.1', name: 'A' }), 'A-02');
});
