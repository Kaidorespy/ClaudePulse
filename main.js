const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, screen, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = app.getPath('userData');
const DATA_FILE = path.join(DATA_DIR, 'pulse.json');
const OLD_DATA_FILE = path.join(__dirname, 'data', 'pulse.json');
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WIDGET_H = 46;

let state = null;
let dash = null;
let tray = null;
let quitting = false;
let pollTimer = null;
const widgetWins = new Map();

function defaults() {
  return {
    settings: { pollSeconds: 120, bindDelete: 1, bindDrag: 2, defaultTop: true, launchAtStartup: false },
    widgets: [],
    lastUsage: null,
    prevPercents: {}
  };
}

function loadState() {
  const tryRead = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  let j = tryRead(DATA_FILE);
  if (!j) {
    // keep a copy of a corrupt file instead of silently resetting everything
    try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bad'); } catch (e) {}
    j = tryRead(OLD_DATA_FILE); // migrate from pre-1.1 location inside the app folder
  }
  return Object.assign(defaults(), j || {});
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {}
}

/* ---------- usage fetch ---------- */
function readToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return c.claudeAiOauth && c.claudeAiOauth.accessToken || null;
  } catch (e) {}
  if (process.platform === 'darwin') {
    // macOS Claude Code keeps credentials in the Keychain, not the file
    try {
      const out = require('child_process').execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
      const c = JSON.parse(out.trim());
      return c.claudeAiOauth && c.claudeAiOauth.accessToken || null;
    } catch (e) {}
  }
  return null;
}

function fallbackLimits(d) {
  const out = [];
  if (d.five_hour) out.push({ kind: 'session', percent: Math.round(d.five_hour.utilization), resets_at: d.five_hour.resets_at, severity: 'normal' });
  if (d.seven_day) out.push({ kind: 'weekly_all', percent: Math.round(d.seven_day.utilization), resets_at: d.seven_day.resets_at, severity: 'normal' });
  if (d.seven_day_opus) out.push({ kind: 'weekly_scoped', percent: Math.round(d.seven_day_opus.utilization), resets_at: d.seven_day_opus.resets_at, severity: 'normal', scope: { model: { display_name: 'Top model' } } });
  return out;
}

function labelFor(l) {
  if (l.kind === 'session') return 'Session';
  if (l.kind === 'weekly_all') return 'Weekly · all models';
  if (l.kind === 'weekly_scoped') return 'Weekly · ' + ((l.scope && l.scope.model && l.scope.model.display_name) || 'top model');
  return l.kind;
}

async function fetchUsage() {
  const token = readToken();
  if (!token) {
    broadcast('usage', { status: 'nocreds', fetchedAt: Date.now(), limits: [] });
    return;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { 'Authorization': 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }
    });
    if (!res.ok) {
      const status = res.status === 401 || res.status === 403 ? 'auth' : 'error';
      const stale = state.lastUsage ? { ...state.lastUsage, status, httpStatus: res.status } : { status, httpStatus: res.status, fetchedAt: Date.now(), limits: [] };
      broadcast('usage', stale);
      return;
    }
    const d = await res.json();
    const limits = (Array.isArray(d.limits) && d.limits.length) ? d.limits : fallbackLimits(d);
    const usage = {
      status: 'ok',
      fetchedAt: Date.now(),
      limits: limits.map(l => ({ kind: l.kind, label: labelFor(l), percent: Math.round(l.percent != null ? l.percent : 0), resets_at: l.resets_at, severity: l.severity || 'normal', is_active: l.is_active })),
      extra: d.extra_usage && d.extra_usage.credits_ever_enabled ? {
        utilization: Math.round(d.extra_usage.utilization || 0),
        enabled: d.extra_usage.is_enabled,
        reason: d.extra_usage.disabled_reason
      } : null
    };
    notifyThresholds(usage);
    state.lastUsage = usage;
    saveState();
    broadcast('usage', usage);
    updateTray(usage);
  } catch (e) {
    const stale = state.lastUsage ? { ...state.lastUsage, status: 'offline' } : { status: 'offline', fetchedAt: Date.now(), limits: [] };
    broadcast('usage', stale);
  }
}

function notifyThresholds(usage) {
  for (const l of usage.limits) {
    const prev = state.prevPercents[l.kind] || 0;
    for (const t of [75, 90, 100]) {
      if (prev < t && l.percent >= t) {
        new Notification({
          title: 'ClaudePulse',
          body: `${l.label} hit ${l.percent}%` + (l.resets_at ? ` — resets ${new Date(l.resets_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '')
        }).show();
        break;
      }
    }
    state.prevPercents[l.kind] = l.percent;
  }
}

function updateTray(usage) {
  if (!tray) return;
  const parts = usage.limits.map(l => `${l.label}: ${l.percent}%`);
  tray.setToolTip('ClaudePulse\n' + (parts.join('\n') || 'no data'));
}

function broadcast(ch, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  const s = Math.max(30, state.settings.pollSeconds || 120);
  pollTimer = setInterval(fetchUsage, s * 1000);
  fetchUsage();
}

/* ---------- icon ---------- */
function makeIcon() {
  const s = 32;
  const buf = Buffer.alloc(s * s * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return;
    const i = (y * s + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) set(x, y, 16, 22, 30);
  const bars = [[7, 20, 59, 130, 246], [14, 9, 245, 158, 11], [21, 13, 96, 165, 250]];
  for (const [y0, w, r, g, b] of bars)
    for (let y = y0; y < y0 + 5; y++)
      for (let x = 5; x < 5 + w; x++) set(x, y, r, g, b);
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

/* ---------- windows ---------- */
// pull a window back on-screen if its saved spot no longer exists
// (monitor unplugged, resolution change) — widgets were vanishing this way
function ensureVisible(b) {
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    const ix = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const iy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    if (ix >= Math.min(60, b.width) && iy >= 20) return { x: b.x, y: b.y };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width)),
    y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height))
  };
}

function reclampAll() {
  for (const w of state.widgets) {
    const win = widgetWins.get(w.id);
    if (!win || win.isDestroyed()) continue;
    const width = Math.max(160, w.w || 320);
    const pos = ensureVisible({ x: w.x, y: w.y, width, height: WIDGET_H });
    win.setBounds({ x: pos.x, y: pos.y, width, height: WIDGET_H });
    if (w.top) win.setAlwaysOnTop(true, 'screen-saver');
    if (!win.isVisible()) win.showInactive();
  }
}

let reclampTimer = null;
function scheduleReclamp() {
  clearTimeout(reclampTimer);
  reclampTimer = setTimeout(reclampAll, 1000);
}

function createDash() {
  const wa = screen.getPrimaryDisplay().workArea;
  dash = new BrowserWindow({
    width: 460, height: Math.min(880, wa.height - 40), minWidth: 380, minHeight: 420,
    frame: false, backgroundColor: '#0b0f14', icon: makeIcon(),
    title: 'ClaudePulse',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  dash.setMenuBarVisibility(false);
  dash.loadFile('dashboard.html');
  dash.on('close', e => { if (!quitting) { e.preventDefault(); dash.hide(); } });
  dash.webContents.on('render-process-gone', () => { if (dash && !dash.isDestroyed()) dash.reload(); });
}

function createWidget(w) {
  const width = Math.max(160, w.w || 320);
  const pos = ensureVisible({ x: w.x, y: w.y, width, height: WIDGET_H });
  const win = new BrowserWindow({
    x: pos.x, y: pos.y, width, height: WIDGET_H,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: !!w.top, hasShadow: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--pulse-widget-id=' + w.id]
    }
  });
  win.setMenuBarVisibility(false);
  if (w.top) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('widget.html');
  // a crashed renderer leaves a transparent window invisible — reload instead
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
  win.on('closed', () => widgetWins.delete(w.id));
  widgetWins.set(w.id, win);
  return win;
}

function showDash() {
  if (!dash || dash.isDestroyed()) createDash();
  if (dash.isMinimized()) dash.restore();
  dash.show();
  dash.focus();
}

/* ---------- app ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showDash);
  app.whenReady().then(() => {
    app.setAppUserModelId('com.casey.claudepulse');
    state = loadState();
    createDash();
    if (process.argv.includes('--tray')) dash.hide();
    for (const w of state.widgets) createWidget(w);
    tray = new Tray(makeIcon());
    tray.setToolTip('ClaudePulse');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Dashboard', click: showDash },
      { label: 'Refresh now', click: fetchUsage },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showDash);
    screen.on('display-added', scheduleReclamp);
    screen.on('display-removed', scheduleReclamp);
    screen.on('display-metrics-changed', scheduleReclamp);
    powerMonitor.on('resume', scheduleReclamp);
    powerMonitor.on('unlock-screen', scheduleReclamp);
    startPolling();
  });
}
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { quitting = true; saveState(); });

/* ---------- IPC ---------- */
ipcMain.handle('get-state', () => ({ usage: state.lastUsage, settings: state.settings, widgets: state.widgets }));
ipcMain.handle('refresh', () => fetchUsage());
ipcMain.handle('open-usage-page', () => shell.openExternal('https://claude.ai/settings/usage'));

ipcMain.handle('set-settings', (e, s) => {
  const oldPoll = state.settings.pollSeconds;
  Object.assign(state.settings, s);
  saveState();
  if (s.pollSeconds && s.pollSeconds !== oldPoll) startPolling();
  if ('launchAtStartup' in s) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!s.launchAtStartup, path: process.execPath, args: [path.resolve(__dirname), '--tray'] });
    } catch (err) {}
  }
  broadcast('settings', state.settings);
  return state.settings;
});

ipcMain.handle('pin-widget', (e, kind) => {
  const wa = screen.getPrimaryDisplay().workArea;
  const n = state.widgets.length;
  const w = {
    id: 'w' + Date.now().toString(36),
    kind,
    x: wa.x + wa.width - 360, y: wa.y + 16 + (n % 8) * (WIDGET_H + 10),
    w: 340, top: !!state.settings.defaultTop
  };
  state.widgets.push(w);
  saveState();
  createWidget(w);
  return state.widgets;
});

ipcMain.handle('widget-config', (e, id) => {
  const w = state.widgets.find(x => x.id === id);
  return { widget: w, settings: state.settings, usage: state.lastUsage };
});

ipcMain.handle('widget-close', (e, id) => {
  state.widgets = state.widgets.filter(x => x.id !== id);
  saveState();
  const win = widgetWins.get(id);
  if (win && !win.isDestroyed()) win.close();
  broadcast('widgets', state.widgets);
  return state.widgets;
});

ipcMain.handle('widget-bounds-get', (e, id) => {
  const win = widgetWins.get(id);
  return win && !win.isDestroyed() ? win.getBounds() : null;
});

ipcMain.handle('widget-bounds-set', (e, { id, x, y, w }) => {
  const win = widgetWins.get(id);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds({
    x: x != null ? Math.round(x) : b.x,
    y: y != null ? Math.round(y) : b.y,
    width: w != null ? Math.min(900, Math.max(160, Math.round(w))) : b.width,
    height: WIDGET_H
  });
});

ipcMain.handle('widget-drag-end', (e, id) => {
  const win = widgetWins.get(id);
  const w = state.widgets.find(x => x.id === id);
  if (win && !win.isDestroyed() && w) {
    const b = win.getBounds();
    // don't let a drag save a fully off-screen position
    const pos = ensureVisible(b);
    if (pos.x !== b.x || pos.y !== b.y) win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: WIDGET_H });
    w.x = pos.x; w.y = pos.y; w.w = b.width;
    saveState();
  }
});

ipcMain.handle('widget-top', (e, { id, top }) => {
  const w = state.widgets.find(x => x.id === id);
  const win = widgetWins.get(id);
  if (w) { w.top = !!top; saveState(); }
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!top, 'screen-saver');
  broadcast('widgets', state.widgets);
  return !!top;
});

ipcMain.handle('dash-min', () => dash && dash.minimize());
ipcMain.handle('dash-close', () => dash && dash.hide());
