import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cachedChromeForTesting = readdirSync(tmpdir(), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('random-password-backspace-cft-'))
  .map(entry => join(tmpdir(), entry.name, 'chrome-win64', 'chrome.exe'))
  .filter(existsSync)
  .reverse();
const chromeCandidates = [
  process.env.CHROME_PATH,
  ...cachedChromeForTesting,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = chromeCandidates.find(existsSync);

const fixture = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Backspace test</title></head><body>
  <input id="text" type="text" autocomplete="off">
  <input id="pw" type="password" autocomplete="off">
  <input id="readonly" type="password" readonly>
  <input id="disabled" type="password" disabled>
  <div id="dynamic"></div>
  <iframe id="frame" src="/frame"></iframe>
</body></html>`;
const frame = '<!doctype html><html><body><input id="frame-pw" type="password"></body></html>';
const crossFrame = `<!doctype html><html><body><input id="cross-pw" type="password" value="ABCDEFGHIJ">
<script>
  window.addEventListener('message', event => {
    const input = document.getElementById('cross-pw');
    if (event.data === 'focus') {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      parent.postMessage({ kind: 'focused', focused: document.activeElement === input }, '*');
    }
    if (event.data === 'snapshot') {
      parent.postMessage({ kind: 'snapshot', value: input.value,
        notice: document.getElementById('random-password-backspace-notice')?.textContent ?? '' }, '*');
    }
  });
  parent.postMessage({ kind: 'ready' }, '*');
</script></body></html>`;

class DevTools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
    this.contexts = [];
    this.ready = new Promise((accept, reject) => {
      this.socket.addEventListener('open', accept, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.executionContextCreated') {
        this.contexts.push(message.params.context);
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed');
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

let server;
let crossServer;
let chromeProcess;
let chromeData;
let cdp;
let fixtureUrl;
let crossUrl;
let sequence = 0;

async function pause(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function until(action, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await pause(50);
  }
  throw lastError ?? new Error('Timed out waiting for Chrome');
}

async function fresh() {
  sequence++;
  await cdp.send('Page.navigate', { url: `${fixtureUrl}/?test=${sequence}` });
  await until(() => cdp.eval(`location.search === '?test=${sequence}' && document.readyState === 'complete'`));
  await cdp.send('Page.bringToFront');
  // chrome.storage.local settings are loaded asynchronously in the content script.
  await pause(100);
}

async function prepare(id, value, start = value.length, end = start) {
  await cdp.eval(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    input.value = ${JSON.stringify(value)};
    input.focus();
    input.setSelectionRange(${start}, ${end});
    window.__events = [];
    if (!input.__testListenerAdded) {
      input.addEventListener('input', event => window.__events.push({
        type: event.type, inputType: event.inputType, value: input.value,
      }));
      input.__testListenerAdded = true;
    }
  })()`);
}

async function pressBackspace(modifiers = 0) {
  const params = {
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    modifiers,
  };
  await cdp.send('Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
  await cdp.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
}

async function value(id = 'pw') {
  return cdp.eval(`document.getElementById(${JSON.stringify(id)}).value`);
}

async function noticeText() {
  return cdp.eval(`(() => {
    const roots = [];
    const visit = root => {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot.textContent);
          visit(element.shadowRoot);
        }
      }
    };
    visit(document);
    return [document.getElementById('random-password-backspace-notice')?.textContent ?? '',
      ...roots].join(' | ');
  })()`);
}

async function extensionId() {
  return until(() => {
    for (const context of cdp.contexts) {
      const candidate = `${context.origin} ${context.name}`;
      const match = candidate.match(/chrome-extension:\/\/([a-p]{32})/);
      if (match) return match[1];
    }
    return null;
  }, 3000);
}

let popupSequence = 0;
async function openPopup() {
  const id = await extensionId();
  const url = `chrome-extension://${id}/popup.html?test=${++popupSequence}`;
  await cdp.send('Page.navigate', { url });
  await until(() => cdp.eval(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`));
  await pause(100);
}

async function setPopup(id, property, value) {
  await cdp.eval(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    element[${JSON.stringify(property)}] = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => cdp.eval(`document.getElementById('saveStatus').textContent === '저장됨'`));
}

const browserTest = chrome ? test : test.skip;

before(async () => {
  if (!chrome) return;
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url.startsWith('/frame') ? frame : fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${server.address().port}`;
  crossServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(crossFrame);
  });
  await new Promise(resolve => crossServer.listen(0, '127.0.0.1', resolve));
  crossUrl = `http://127.0.0.1:${crossServer.address().port}`;

  chromeData = await mkdtemp(join(tmpdir(), 'random-password-backspace-test-'));
  chromeProcess = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-gpu',
    '--remote-allow-origins=*', '--remote-debugging-port=0',
    `--user-data-dir=${chromeData}`,
    `--disable-extensions-except=${project}`,
    `--load-extension=${project}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(chromeData, 'DevToolsActivePort');
  const port = await until(async () => {
    if (!existsSync(portFile)) return null;
    const [line] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
    return Number(line) || null;
  });
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(fixtureUrl)}`, { method: 'PUT' });
    if (!response.ok) return null;
    return response.json();
  });
  cdp = new DevTools(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await until(() => cdp.eval(`location.origin === ${JSON.stringify(fixtureUrl)} && document.readyState === 'complete'`));
  await until(() => cdp.contexts.some(context =>
    /chrome-extension:\/\/[a-p]{32}/.test(`${context.origin} ${context.name}`)), 3000);
  await pause(250);
});

after(async () => {
  cdp?.close();
  chromeProcess?.kill();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await new Promise(resolve => crossServer?.close(resolve) ?? resolve());
  if (chromeData) {
    const target = await realpath(chromeData);
    const temporaryRoot = await realpath(tmpdir());
    const insideTemporaryRoot = target.toLowerCase().startsWith(
      `${temporaryRoot}${sep}`.toLowerCase());
    if (!insideTemporaryRoot ||
        !basename(target).startsWith('random-password-backspace-test-')) {
      throw new Error(`Refusing to remove unexpected Chrome profile path: ${target}`);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(target, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await pause(150);
      }
    }
  }
});

test('Manifest V3 has only the required extension permissions', async () => {
  const manifest = JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions ?? [], ['storage']);
  assert.equal(manifest.content_scripts?.[0]?.all_frames, true);
});

browserTest('ordinary text uses the browser default single-character backspace', async () => {
  await fresh();
  await prepare('text', 'ABCDE');
  await pressBackspace();
  assert.equal(await value('text'), 'ABCD');
});

browserTest('password deletion removes 1–3 characters and reports the actual number', async () => {
  await fresh();
  const observed = new Set();
  for (let run = 0; run < 12; run++) {
    await prepare('pw', 'ABCDEFGHIJ');
    await pressBackspace();
    const remaining = await value();
    const removed = 10 - remaining.length;
    observed.add(removed);
    assert.ok(removed >= 1 && removed <= 3, `removed ${removed}`);
    assert.equal(remaining, 'ABCDEFGHIJ'.slice(0, 10 - removed));
    assert.match(await noticeText(), new RegExp(`${removed}글자 삭제`));
    assert.equal(await cdp.eval('window.__events.length'), 1);
  }
  assert.ok(observed.size >= 2, `Only observed deletion count ${[...observed]}`);
});

browserTest('one remaining character reports one deletion; empty input stays empty', async () => {
  await fresh();
  await prepare('pw', 'A');
  await pressBackspace();
  assert.equal(await value(), '');
  assert.match(await noticeText(), /1글자 삭제/);
  await pressBackspace();
  assert.equal(await value(), '');
  assert.equal(await cdp.eval('window.__events.length'), 1);
  assert.doesNotMatch(await noticeText(), /\d글자 삭제/);
});

browserTest('notice stays inside the viewport and does not intercept clicks', async () => {
  await fresh();
  await cdp.eval(`document.getElementById('pw').style.cssText =
    'position: fixed; right: 0; bottom: 0; width: 240px; height: 40px'`);
  await prepare('pw', 'ABCDEFGHIJ');
  await pressBackspace();
  const notice = await cdp.eval(`(() => {
    const element = document.getElementById('random-password-backspace-notice');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: innerWidth, height: innerHeight, position: style.position,
      pointerEvents: style.pointerEvents, visibility: style.visibility };
  })()`);
  assert.ok(notice);
  assert.equal(notice.position, 'fixed');
  assert.equal(notice.pointerEvents, 'none');
  assert.equal(notice.visibility, 'visible');
  assert.ok(notice.left >= 0 && notice.top >= 0, JSON.stringify(notice));
  assert.ok(notice.right <= notice.width && notice.bottom <= notice.height, JSON.stringify(notice));
});

browserTest('notice colors respond to light and dark mode', async () => {
  await fresh();
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await prepare('pw', 'ABCDEFGHIJ');
  await pressBackspace();
  const light = await cdp.eval(`getComputedStyle(
    document.getElementById('random-password-backspace-notice')).backgroundColor`);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  const dark = await cdp.eval(`getComputedStyle(
    document.getElementById('random-password-backspace-notice')).backgroundColor`);
  assert.notEqual(light, dark);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
});

browserTest('notice disappears when focus leaves the password input', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await pressBackspace();
  assert.match(await noticeText(), /\d글자 삭제/);
  await cdp.eval(`document.getElementById('text').focus()`);
  assert.doesNotMatch(await noticeText(), /\d글자 삭제/);
});

browserTest('middle-of-string deletion keeps text after the caret intact', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHI', 5);
  await pressBackspace();
  const result = await cdp.eval(`(() => { const e = document.getElementById('pw');
    return { value: e.value, start: e.selectionStart, end: e.selectionEnd }; })()`);
  const removed = 9 - result.value.length;
  assert.ok(removed >= 1 && removed <= 3);
  assert.equal(result.value, 'ABCDE'.slice(0, 5 - removed) + 'FGHI');
  assert.equal(result.start, 5 - removed);
  assert.equal(result.end, result.start);
});

browserTest('selected password text is deleted by the browser normally', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHI', 2, 5);
  await pressBackspace();
  assert.equal(await value(), 'ABFGHI');
  assert.equal(await cdp.eval('window.__events.length'), 1);
});

browserTest('Ctrl+Backspace is not intercepted by the extension', async () => {
  await fresh();
  await prepare('pw', 'alpha beta');
  await cdp.eval(`document.addEventListener('keydown', event => {
    if (event.key === 'Backspace' && event.ctrlKey) window.__ctrlPrevented = event.defaultPrevented;
  });`);
  await pressBackspace(2);
  assert.equal(await cdp.eval('window.__ctrlPrevented'), false);
});

browserTest('read-only and disabled password inputs are not changed', async () => {
  await fresh();
  await prepare('readonly', 'ABCDE');
  await pressBackspace();
  assert.equal(await value('readonly'), 'ABCDE');
  await cdp.eval(`document.getElementById('disabled').value = 'ABCDE'; document.getElementById('disabled').focus()`);
  await pressBackspace();
  assert.equal(await value('disabled'), 'ABCDE');
});

browserTest('a dynamically added password input is handled', async () => {
  await fresh();
  await cdp.eval(`document.getElementById('dynamic').innerHTML = '<input id="new-pw" type="password">'`);
  await prepare('new-pw', 'ABCDE');
  await pressBackspace();
  const length = (await value('new-pw')).length;
  assert.ok(length >= 2 && length <= 4);
});

browserTest('one grapheme cluster is never cut in half', async () => {
  await fresh();
  const original = 'ab👩‍👩‍👧‍👧cd';
  await prepare('pw', original, 'ab👩‍👩‍👧‍👧'.length);
  await pressBackspace();
  const result = await value();
  assert.ok(['abcd', 'acd', 'cd'].includes(result), JSON.stringify(result));
  assert.equal(await cdp.eval('document.getElementById("pw").selectionStart'), result.length - 2);
});

browserTest('one input event reflects the edited value for site state handlers', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await cdp.eval(`window.__siteState = 'ABCDEFGHIJ';
    document.getElementById('pw').addEventListener('input', e => { window.__siteState = e.target.value; });`);
  await pressBackspace();
  const state = await cdp.eval(`({ value: document.getElementById('pw').value,
    state: window.__siteState, events: window.__events })`);
  assert.equal(state.state, state.value);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].value, state.value);
});

browserTest('a canceled beforeinput prevents the password edit', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await cdp.eval(`(() => {
    window.__beforeInputCount = 0;
    document.getElementById('pw').addEventListener('beforeinput', event => {
      window.__beforeInputCount++;
      event.preventDefault();
    });
  })()`);
  await pressBackspace();
  assert.equal(await value(), 'ABCDEFGHIJ');
  assert.equal(await cdp.eval('window.__beforeInputCount'), 1);
  assert.equal(await cdp.eval('window.__events.length'), 0);
  assert.doesNotMatch(await noticeText(), /\d글자 삭제/);
});

browserTest('a React-like value tracker recognizes the edit on one input event', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await cdp.eval(`(() => {
    const input = document.getElementById('pw');
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    let tracked = input.value;
    window.__trackerState = input.value;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return native.get.call(this); },
      set(value) { tracked = String(value); native.set.call(this, value); }
    });
    input.addEventListener('input', () => {
      if (tracked !== input.value) {
        tracked = input.value;
        window.__trackerState = input.value;
      }
    });
  })()`);
  await pressBackspace();
  assert.equal(await cdp.eval('window.__trackerState'), await value());
  assert.equal(await cdp.eval('window.__events.length'), 1);
});

browserTest('rapid consecutive presses cause one edit event per press', async () => {
  await fresh();
  await prepare('pw', 'ABCDEFGHIJKLMNOPQRST');
  for (let i = 0; i < 5; i++) await pressBackspace();
  const result = await value();
  assert.ok(result.length >= 5 && result.length <= 15);
  assert.equal(await cdp.eval('window.__events.length'), 5);
});

browserTest('programmatic autofill-like changes are left alone until a backspace', async () => {
  await fresh();
  await cdp.eval(`document.getElementById('pw').value = 'AUTOFILLED';`);
  await pause(100);
  assert.equal(await value(), 'AUTOFILLED');
});

browserTest('same-origin iframe password input is handled', async () => {
  await fresh();
  await cdp.eval(`(() => { const frame = document.getElementById('frame');
    const input = frame.contentDocument.getElementById('frame-pw');
    input.value = 'ABCDEFG'; input.focus(); input.setSelectionRange(7, 7); })()`);
  await pressBackspace();
  const length = await cdp.eval(`document.getElementById('frame').contentDocument.getElementById('frame-pw').value.length`);
  assert.ok(length >= 4 && length <= 6, `length ${length}`);
});

browserTest('open Shadow DOM password input is handled through the composed event path', async () => {
  await fresh();
  await cdp.eval(`(() => {
    const host = document.createElement('div');
    host.id = 'shadow-host';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="shadow-pw" type="password">';
    const input = root.getElementById('shadow-pw');
    input.value = 'ABCDEFGHIJ';
    input.focus();
    input.setSelectionRange(10, 10);
  })()`);
  await pressBackspace();
  const result = await cdp.eval(`document.getElementById('shadow-host')
    .shadowRoot.getElementById('shadow-pw').value`);
  const removed = 10 - result.length;
  assert.ok(removed >= 1 && removed <= 3, `removed ${removed}`);
  assert.match(await noticeText(), new RegExp(`${removed}글자 삭제`));
});

browserTest('cross-origin localhost iframe password input is handled', async () => {
  await fresh();
  await cdp.eval(`(() => {
    window.__frameMessages = [];
    window.addEventListener('message', event => window.__frameMessages.push(event.data));
    const frame = document.createElement('iframe');
    frame.id = 'cross-frame';
    frame.src = ${JSON.stringify(crossUrl)};
    document.body.appendChild(frame);
  })()`);
  await until(() => cdp.eval(`window.__frameMessages.some(message => message.kind === 'ready')`));
  await cdp.eval(`(() => { const frame = document.getElementById('cross-frame');
    frame.focus(); frame.contentWindow.postMessage('focus', '*'); })()`);
  await until(() => cdp.eval(`window.__frameMessages.some(message => message.kind === 'focused')`));
  assert.equal(await cdp.eval(`window.__frameMessages.find(message => message.kind === 'focused').focused`), true);
  await pressBackspace();
  await cdp.eval(`document.getElementById('cross-frame').contentWindow.postMessage('snapshot', '*')`);
  const snapshot = await until(() => cdp.eval(`window.__frameMessages.find(message => message.kind === 'snapshot')`));
  const removed = 10 - snapshot.value.length;
  assert.ok(removed >= 1 && removed <= 3, `removed ${removed}`);
  assert.match(snapshot.notice, new RegExp(`${removed}글자 삭제`));
});

browserTest('popup defaults and OFF setting persist; OFF restores native Backspace', async () => {
  await openPopup();
  const defaults = await cdp.eval(`({ enabled: document.getElementById('enabled').checked,
    showNotice: document.getElementById('showNotice').checked,
    duration: document.getElementById('noticeDuration').value })`);
  assert.deepEqual(defaults, { enabled: true, showNotice: true, duration: '1500' });

  await setPopup('enabled', 'checked', false);
  await openPopup();
  assert.equal(await cdp.eval(`document.getElementById('enabled').checked`), false);
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await cdp.eval(`document.addEventListener('keydown', event => {
    if (event.key === 'Backspace') window.__offPrevented = event.defaultPrevented;
  });`);
  await pressBackspace();
  assert.equal(await value(), 'ABCDEFGHI');
  assert.equal(await cdp.eval('window.__offPrevented'), false);

  await openPopup();
  await setPopup('enabled', 'checked', true);
});

browserTest('popup notice OFF setting persists and suppresses deletion notices', async () => {
  await openPopup();
  await setPopup('showNotice', 'checked', false);
  await openPopup();
  assert.equal(await cdp.eval(`document.getElementById('showNotice').checked`), false);
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await pressBackspace();
  assert.ok((await value()).length >= 7 && (await value()).length <= 9);
  assert.doesNotMatch(await noticeText(), /\d글자 삭제/);

  await openPopup();
  await setPopup('showNotice', 'checked', true);
});

browserTest('popup duration setting persists and the notice expires', async () => {
  await openPopup();
  await setPopup('noticeDuration', 'value', '300');
  await openPopup();
  assert.equal(await cdp.eval(`document.getElementById('noticeDuration').value`), '300');
  await fresh();
  await prepare('pw', 'ABCDEFGHIJ');
  await pressBackspace();
  assert.match(await noticeText(), /\d글자 삭제/);
  await pause(200);
  await pressBackspace();
  await pause(160);
  assert.match(await noticeText(), /\d글자 삭제/, 'second press should refresh the timer');
  await pause(220);
  assert.doesNotMatch(await noticeText(), /\d글자 삭제/);

  await openPopup();
  await setPopup('noticeDuration', 'value', '1500');
});

if (process.env.LIVE_SITE_TESTS === '1') {
  browserTest('Naver login password field handles dummy Backspace without submission', async () => {
    const oldContextCount = cdp.contexts.length;
    await cdp.send('Page.navigate', { url: 'https://nid.naver.com/nidlogin.login' });
    await until(() => cdp.eval(`location.hostname === 'nid.naver.com' &&
      [...document.querySelectorAll('input[type="password"]')]
        .some(input => input.getClientRects().length > 0)`), 20000);
    await until(() => cdp.contexts.slice(oldContextCount).some(context =>
      /chrome-extension:\/\/[a-p]{32}/.test(`${context.origin} ${context.name}`)), 5000);
    await cdp.send('Page.bringToFront');
    await pause(200);
    const original = 'DummyResearch123';
    await cdp.eval(`(() => {
      const input = [...document.querySelectorAll('input[type="password"]')]
        .find(element => element.getClientRects().length > 0);
      window.__naverPasswordInput = input;
      input.value = ${JSON.stringify(original)};
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    })()`);
    const before = await cdp.eval(`(() => { const input = window.__naverPasswordInput;
      return { focused: document.activeElement === input, activeId: document.activeElement?.id,
        type: input.type, readOnly: input.readOnly, disabled: input.disabled,
        start: input.selectionStart, end: input.selectionEnd, length: input.value.length }; })()`);
    assert.equal(before.focused, true, JSON.stringify(before));
    await pressBackspace();
    const remaining = await cdp.eval('window.__naverPasswordInput.value');
    const removed = original.length - remaining.length;
    assert.ok(removed >= 1 && removed <= 3, `removed ${removed}, before ${JSON.stringify(before)}`);
    assert.match(await noticeText(), new RegExp(`${removed}글자 삭제`));
  });
}
