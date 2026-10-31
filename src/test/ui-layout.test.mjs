import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const css = await readFile(new URL('../theme.css', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
const source = bridge.slice(0, bridge.indexOf('// 原界面'));
function setup(containers = [], initialBar = null) {
  const values = new Map();
  const listeners = {};
  const observers = {};
  let bar = initialBar;
  const document = {
    body: {},
    documentElement: { style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) } },
    querySelectorAll: () => containers,
    querySelector: () => bar,
  };
  const context = { document, window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    ResizeObserver: class { constructor(fn) { observers.resize = fn; } observe() {} disconnect() {} },
    MutationObserver: class { constructor(fn) { observers.mutation = fn; } observe() {} },
  };
  runInNewContext(source + '\ninitializePanelLayout();', context);
  return { values, listeners, observers, setBar(value) { bar = value; } };
}
function element(isCard, wide = false) {
  const classes = new Set(isCard ? ['card'] : []);
  return { classes, classList: { contains: name => classes.has(name), add: name => classes.add(name) }, querySelector: () => wide ? {} : null };
}
test('layout marks direct cards without moving DOM or widening unrelated elements', () => {
  const a = element(true), b = element(true, true), heading = element(false);
  const parent = element(false); parent.children = [heading, a, b];
  setup([parent]);
  assert.ok(parent.classes.has('cp-layout-grid'));
  assert.ok(b.classes.has('cp-card-wide'));
  assert.ok(!a.classes.has('cp-card-wide'));
  assert.deepEqual(parent.children, [heading, a, b]);
});
test('single card stays in normal flow', () => {
  const parent = element(false); parent.children = [element(true)];
  setup([parent]); assert.ok(!parent.classes.has('cp-layout-grid'));
});
test('action bar reserve tracks measured height and wrapping', () => {
  let height = 106.2;
  const state = setup([], { getBoundingClientRect: () => ({ height }) });
  assert.equal(state.values.get('--action-bar-height'), '107px');
  height = 164;
  state.observers.resize(); assert.equal(state.values.get('--action-bar-height'), '164px');
  height = 180;
  state.listeners.resize(); assert.equal(state.values.get('--action-bar-height'), '180px');
});
test('late inserted and removed action bars update reserve', () => {
  const state = setup();
  state.setBar({ getBoundingClientRect: () => ({ height: 120 }) });
  state.observers.mutation(); assert.equal(state.values.get('--action-bar-height'), '120px');
  state.setBar(null); state.observers.mutation();
  assert.equal(state.values.has('--action-bar-height'), false);
});
test('hidden, desktop grid, focus, and safe-area rules remain present', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  assert.match(css, /--panel-width:\s*1120px/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /bottom:\s*calc\(var\(--action-bar-height\)/);
});
function luminance(hex) {
  const rgb = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value,16)/255);
  const c = rgb.map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
}
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('primary gradient endpoints and muted text have at least 4.5:1 token contrast', () => {
  const token = name => css.match(new RegExp('--'+name+':\\s*(#[0-9a-f]{6})','i'))[1];
  assert.ok(contrast('#ffffff',token('accent')) >= 4.5);
  assert.ok(contrast('#ffffff',token('accent-2')) >= 4.5);
  assert.ok(contrast(token('text-muted'),token('bg0')) >= 4.5);
  assert.ok(contrast(token('text-muted'),token('bg1')) >= 4.5);
});
