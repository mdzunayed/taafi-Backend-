// Minimal raw-CDP step runner. The Flutter app renders to a canvas (no DOM),
// so interaction is coordinate-based: screenshot → look → click → screenshot.
const WebSocket = require('ws');
const fs = require('fs');

const OUT = process.env.OUT_DIR || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const s of steps) {
    try {
      if (s.navigate) {
        await send('Page.navigate', { url: s.navigate });
        await sleep(s.wait || 9000);
      } else if (s.resize) {
        await send('Emulation.setDeviceMetricsOverride', {
          width: s.resize[0], height: s.resize[1],
          deviceScaleFactor: 1, mobile: s.mobile !== false,
        });
        await sleep(s.wait || 1200);
      } else if (s.click) {
        const [x, y] = s.click;
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await sleep(60);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
        await sleep(s.wait || 1200);
      } else if (s.type !== undefined) {
        for (const ch of s.type) {
          await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
          await sleep(28);
        }
        await sleep(s.wait || 400);
      } else if (s.key) {
        const map = { Enter: 13, Tab: 9, Backspace: 8 };
        await send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', windowsVirtualKeyCode: map[s.key], key: s.key,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', windowsVirtualKeyCode: map[s.key], key: s.key,
        });
        await sleep(s.wait || 600);
      } else if (s.scroll) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: s.at ? s.at[0] : 215, y: s.at ? s.at[1] : 450,
          deltaX: 0, deltaY: s.scroll,
        });
        await sleep(s.wait || 900);
      } else if (s.eval) {
        const r = await send('Runtime.evaluate', {
          expression: s.eval, returnByValue: true, awaitPromise: true,
        });
        console.log('EVAL:', JSON.stringify(r.result?.value));
        await sleep(s.wait || 300);
      } else if (s.sleep) {
        await sleep(s.sleep);
      } else if (s.shot) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${OUT}/${s.shot}.png`, Buffer.from(data, 'base64'));
        console.log('shot →', s.shot);
      }
    } catch (e) {
      console.error('step failed', JSON.stringify(s), e.message);
    }
  }
  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
