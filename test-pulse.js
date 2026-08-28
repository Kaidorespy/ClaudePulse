const fs = require('fs');
async function conn(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    const h = ev => { const m = JSON.parse(ev.data); if (m.id === mid) { ws.removeEventListener('message', h); res(m); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, ws };
}
const evalIn = async (c, expression) => {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result && r.result.result ? r.result.result.value : JSON.stringify(r);
};

(async () => {
  const targets = await fetch('http://127.0.0.1:9223/json').then(r => r.json());
  const dashT = targets.find(t => t.url.includes('dashboard.html'));
  if (!dashT) { console.log('NO DASH'); process.exit(1); }
  const dash = await conn(dashT.webSocketDebuggerUrl);

  console.log('usage status:', await evalIn(dash, 'usage && usage.status'));
  console.log('limits:', await evalIn(dash, 'JSON.stringify(usage && usage.limits.map(l => l.label + "=" + l.percent + "%"))'));
  console.log('bars rendered:', await evalIn(dash, 'document.querySelectorAll(".limitRow").length'));

  const shot = await dash.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '/pulse_dash.png', Buffer.from(shot.result.data, 'base64'));
  console.log('dash screenshot saved');

  // pin a session widget through the real UI path
  console.log('pin:', await evalIn(dash, `(async () => {
    const btn = document.querySelector('.pinBtn[data-kind="session"]');
    if (!btn) return 'NO PIN BUTTON';
    btn.click();
    await new Promise(r => setTimeout(r, 1200));
    return 'clicked';
  })()`));

  const targets2 = await fetch('http://127.0.0.1:9223/json').then(r => r.json());
  const wT = targets2.find(t => t.url.includes('widget.html'));
  if (!wT) { console.log('NO WIDGET WINDOW'); process.exit(1); }
  const wid = await conn(wT.webSocketDebuggerUrl);
  console.log('widget cfg:', await evalIn(wid, 'JSON.stringify({ id: window.pulse.widgetId, kind: cfg && cfg.kind, top: cfg && cfg.top })'));
  console.log('widget shows:', await evalIn(wid, 'document.getElementById("label").textContent + " " + document.getElementById("pct").textContent'));
  console.log('bindings:', await evalIn(wid, 'JSON.stringify({ del: settings.bindDelete, drag: settings.bindDrag })'));

  // exercise move + resize IPC
  console.log('bounds test:', await evalIn(wid, `(async () => {
    const id = window.pulse.widgetId;
    const b0 = await window.pulse.widgetBoundsGet(id);
    await window.pulse.widgetBoundsSet({ id, x: b0.x - 40, y: b0.y + 20 });
    await window.pulse.widgetBoundsSet({ id, w: b0.width + 80 });
    await window.pulse.widgetDragEnd(id);
    const b1 = await window.pulse.widgetBoundsGet(id);
    return (b1.x === b0.x - 40 && b1.y === b0.y + 20 && b1.width === b0.width + 80) ? 'move+resize OK' : 'FAIL ' + JSON.stringify([b0, b1]);
  })()`));

  const wshot = await wid.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '/pulse_widget.png', Buffer.from(wshot.result.data, 'base64'));
  console.log('widget screenshot saved');

  // persistence check
  console.log('persisted:', await evalIn(dash, `(async () => {
    const st = await window.pulse.getState();
    return JSON.stringify(st.widgets.map(w => ({ kind: w.kind, w: w.w, top: w.top })));
  })()`));
  process.exit(0);
})().catch(e => { console.log('ERR', e.message || e); process.exit(1); });
