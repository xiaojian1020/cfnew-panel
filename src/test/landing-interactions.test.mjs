import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function setup(saved = [], token = '') {
  const elements = new Map();
  function element(id) {
    const listeners = {};
    return { value: '', checked: false, disabled: false, hidden: true, textContent: '', validity: '', options: [], attrs: {},
      addEventListener(name, fn) { listeners[name] = fn; },
      fire(name) { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners[name]?.(event); return event; },
      replaceChildren(...items) { this.options = items; this.value = ''; }, add(item) { this.options.push(item); },
      setCustomValidity(message) { this.validity = message; },
      reportValidity() { return !elements.get('host').validity && !elements.get('uuid').validity; },
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
    };
  }
  const local = new Map([['cfnew-panel-nodes', JSON.stringify(saved)]]);
  const session = new Map([['cfnew-panel-token', token]]);
  let fail = false, confirmed = true;
  const events = {};
  const context = { URL, document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); } },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    localStorage: { getItem: key => local.get(key) ?? null, setItem(key,value) { if (fail) throw new Error('storage blocked'); local.set(key,value); }, removeItem(key) { if (fail) throw new Error('storage blocked'); local.delete(key); } },
    sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key,value) => session.set(key,value), removeItem: key => session.delete(key) },
    Option: function(text,value) { this.text=text; this.value=value; }, confirm: () => confirmed,
  };
  runInNewContext(script, context);
  return { el: id => elements.get(id), local, session, events, fail(value) { fail=value; }, confirm(value) { confirmed=value; } };
}
const node = { host: 'worker.example.com', uuid: 'Admin/Panel' };
test('back navigation resets pending submit and busy state', () => {
  const s=setup(); s.el('host').value=node.host; s.el('uuid').value=node.uuid;
  assert.equal(s.el('connectForm').fire('submit').defaultPrevented,false);
  assert.equal(s.el('submitBtn').disabled,true); assert.equal(s.el('connectForm').attrs['aria-busy'],'true');
  s.events.pageshow(); assert.equal(s.el('submitBtn').disabled,false); assert.equal(s.el('connectForm').attrs['aria-busy'],undefined);
});
test('failed delete retains state for a successful retry', () => {
  const s=setup([node]); s.fail(true); s.el('deleteNode').fire('click');
  assert.deepEqual(JSON.parse(s.local.get('cfnew-panel-nodes')),[node]);
  s.fail(false); s.el('deleteNode').fire('click');
  assert.equal(s.local.has('cfnew-panel-nodes'),false); assert.equal(s.el('historyControls').hidden,true);
});
test('failed clear retains state for a successful retry', () => {
  const s=setup([node,{host:'second.example.com',uuid:'Other'}]); s.fail(true); s.el('clearAll').fire('click');
  assert.equal(JSON.parse(s.local.get('cfnew-panel-nodes')).length,2);
  s.fail(false); s.el('clearAll').fire('click'); assert.equal(s.local.has('cfnew-panel-nodes'),false);
});
test('cancelled clear does not change records', () => {
  const s=setup([node]); s.confirm(false); s.el('clearAll').fire('click');
  assert.deepEqual(JSON.parse(s.local.get('cfnew-panel-nodes')),[node]);
});
test('storage failure allows continuing after unchecking remember', () => {
  const s=setup(); s.el('host').value=node.host; s.el('uuid').value=node.uuid; s.el('remember').checked=true; s.fail(true);
  assert.equal(s.el('connectForm').fire('submit').defaultPrevented,true); assert.equal(s.el('submitBtn').disabled,false);
  s.el('remember').checked=false;
  assert.equal(s.el('connectForm').fire('submit').defaultPrevented,false); assert.equal(s.el('submitBtn').disabled,true);
});
test('invalid hosts fail locally before submission becomes busy', () => {
  for (const host of [' ', 'http://worker.example.com','https://worker.example.com/admin','https://user:pass@worker.example.com','https://worker.example.com?q=x']) {
    const s=setup(); s.el('host').value=host; s.el('uuid').value=node.uuid;
    assert.equal(s.el('connectForm').fire('submit').defaultPrevented,true,host); assert.equal(s.el('submitBtn').disabled,false);
  }
});
test('whitespace is trimmed without changing custom path case', () => {
  const s=setup(); s.el('host').value='  worker.example.com  '; s.el('uuid').value='  Admin/Panel  ';
  assert.equal(s.el('connectForm').fire('submit').defaultPrevented,false);
  assert.equal(s.el('host').value,node.host); assert.equal(s.el('uuid').value,'Admin/Panel');
});
test('saved session token expands advanced options but is not stored in node history', () => {
  const s=setup([node],'session-only'); assert.equal(s.el('advancedConnection').open,true);
  assert.equal(s.el('token').value,'session-only'); assert.ok(!s.local.get('cfnew-panel-nodes').includes('session-only'));
});
test('invalid history selection cannot crash or delete records', () => {
  const s=setup([node]); s.el('history').value='999'; s.el('history').fire('change'); s.el('deleteNode').fire('click');
  assert.equal(s.el('deleteNode').disabled,true); assert.deepEqual(JSON.parse(s.local.get('cfnew-panel-nodes')),[node]);
});
test('double submit is stopped until pageshow restores the form', () => {
  const s=setup(); s.el('host').value=node.host; s.el('uuid').value=node.uuid;
  s.el('connectForm').fire('submit'); assert.equal(s.el('connectForm').fire('submit').defaultPrevented,true);
});
