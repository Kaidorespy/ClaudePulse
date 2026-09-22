const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, screen, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readRateLimits, normalizeCodex } = require('./codex-usage');
const Percent = require('./percent');
app.setName('Pulse');
// Keep the existing profile and single-instance lock when upgrading.
app.setPath('userData', process.env.PULSE_PROFILE_DIR || path.join(app.getPath('appData'), 'claude-pulse'));
const DATA_DIR = process.env.PULSE_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pulse.json');
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WIDGET_H = 46;

let state = null;
let dash = null;
let tray = null;
let quitting = false;
let pollTimer = null;
let topTimer = null;
let fetching = null;
const widgetWins = new Map();

function defaults() {
  return {
    settings: { pollSeconds: 120, bindDelete: 1, bindDrag: 2, defaultTop: true, launchAtStartup: false, percentMode: 'original' },
    widgets: [],
    lastUsage: null,
    codexUsage: null,
    prevPercents: {}
  };
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...defaults(), ...j, settings: { ...defaults().settings, ...j.settings } };
  } catch (e) {
    return defaults();
  }
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
  } catch (e) {
    return null;
  }
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

async function fetchClaudeUsage() {
  const token = readToken();
  if (!token) {
    publishClaude( { status: 'nocreds', fetchedAt: Date.now(), limits: [] });
    return;
  }
  try {
    const res = await fetch(USAGE_URL, {
      signal: AbortSignal.timeout(20000),
      headers: { 'Authorization': 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }
    });
    if (!res.ok) {
      const status = res.status === 401 || res.status === 403 ? 'auth' : 'error';
      const stale = state.lastUsage ? { ...state.lastUsage, status, httpStatus: res.status } : { status, httpStatus: res.status, fetchedAt: Date.now(), limits: [] };
      publishClaude( stale);
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
    publishClaude( usage);

  } catch (e) {
    const stale = state.lastUsage ? { ...state.lastUsage, status: 'offline' } : { status: 'offline', fetchedAt: Date.now(), limits: [] };
    publishClaude( stale);
  }
}

function combinedUsage() {
  const claude = state.lastUsage || { status: 'loading', limits: [] };
  const codex = state.codexUsage || { status: 'loading', limits: [] };
  return { status: 'ok', fetchedAt: Math.max(claude.fetchedAt || 0, codex.fetchedAt || 0),
    providers: { claude, codex }, extra: claude.extra,
    limits: [...claude.limits.map(l => ({ ...l, provider: 'claude' })), ...codex.limits] };
}
function publish() {
  const usage = combinedUsage();
  broadcast('usage', usage);
  updateTray(usage);
}
function publishClaude(usage) { state.lastUsage = usage; saveState(); publish(); }
async function fetchCodexUsage() {
  try {
    const usage = normalizeCodex(await readRateLimits());
    notifyThresholds(usage);
    state.codexUsage = usage;
  } catch (e) {
    const status = e.code === 'ENOENT' ? 'nocreds' : /auth|sign|log.?in|token|401/i.test(e.message) ? 'auth' : 'offline';
    state.codexUsage = { ...(state.codexUsage || { limits: [] }), status };
  }
  saveState(); publish();
}
function fetchUsage() {
  if (!fetching) fetching = Promise.allSettled([fetchClaudeUsage(), fetchCodexUsage()]).finally(() => { fetching = null; });
  return fetching;
}

function notifyThresholds(usage) {
  for (const l of usage.limits) {
    const prev = state.prevPercents[l.kind] || 0;
    for (const t of [75, 90, 100]) {
      if (prev < t && l.percent >= t) {
        new Notification({
          title: 'Pulse',
          body: `${l.provider === 'codex' ? 'Codex \u00b7 ' : 'Claude \u00b7 '}${l.label} ${Percent.notice(l, state.settings.percentMode)}` + (l.resets_at ? ` — resets ${new Date(l.resets_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '')
        }).show();
        break;
      }
    }
    state.prevPercents[l.kind] = l.percent;
  }
}

function updateTray(usage) {
  if (!tray) return;
  const parts = usage.limits.map(l => `${l.provider === 'codex' ? 'Codex' : 'Claude'} ${l.label}: ${Percent.text(l, state.settings.percentMode)}`);
  tray.setToolTip(('Pulse\n' + (parts.join('\n') || 'no data')).slice(0, 127));
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
function createDash() {
  dash = new BrowserWindow({
    width: 560, height: 820, minWidth: 460, minHeight: 420,
    frame: false, backgroundColor: '#0b0f14', icon: makeIcon(),
    title: 'Pulse',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  dash.setMenuBarVisibility(false);
  dash.loadFile('dashboard.html');
  dash.on('close', e => { if (!quitting) { e.preventDefault(); dash.hide(); } });
}

function createWidget(w) {
  const win = new BrowserWindow({
    x: w.x, y: w.y, width: Math.max(160, w.w || 320), height: WIDGET_H,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    show: false, focusable: false,
    alwaysOnTop: !!w.top, hasShadow: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--pulse-widget-id=' + w.id]
    }
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => { win.showInactive(); enforceTop(win, w); });
  win.on('show', () => enforceTop(win, w));
  win.loadFile('widget.html');
  win.on('closed', () => widgetWins.delete(w.id));
  widgetWins.set(w.id, win);
  return win;
}

function enforceTop(win, config) {
  if (win.isDestroyed() || !config.top || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop(); // Restore z-order without activating the widget or stealing focus.
}
function restorePinnedWidgets() {
  for (const w of state.widgets) {
    const win = widgetWins.get(w.id);
    if (win) enforceTop(win, w);
  }
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
    tray.setToolTip('Pulse');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Dashboard', click: showDash },
      { label: 'Refresh now', click: fetchUsage },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showDash);
    startPolling();
    topTimer = setInterval(restorePinnedWidgets, 5000);
    powerMonitor.on('resume', () => { restorePinnedWidgets(); fetchUsage(); });
    powerMonitor.on('unlock-screen', restorePinnedWidgets);
    screen.on('display-metrics-changed', restorePinnedWidgets);
  });
}
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { quitting = true; clearInterval(pollTimer); clearInterval(topTimer); if (state) saveState(); });

/* ---------- IPC ---------- */
ipcMain.handle('get-state', () => ({ usage: combinedUsage(), settings: state.settings, widgets: state.widgets }));
ipcMain.handle('refresh', () => fetchUsage());
ipcMain.handle('open-usage-page', (e, provider) => shell.openExternal(provider === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : 'https://claude.ai/settings/usage'));

ipcMain.handle('set-settings', (e, s) => {
  const oldPoll = state.settings.pollSeconds;
  Object.assign(state.settings, s);
  state.settings.percentMode = Percent.normalize(state.settings.percentMode);
  saveState();
  if (s.pollSeconds && s.pollSeconds !== oldPoll) startPolling();
  if ('percentMode' in s) updateTray(combinedUsage());
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
  return { widget: w, settings: state.settings, usage: combinedUsage() };
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
    w.x = b.x; w.y = b.y; w.w = b.width;
    saveState();
  }
});

ipcMain.handle('widget-top', (e, { id, top }) => {
  const w = state.widgets.find(x => x.id === id);
  const win = widgetWins.get(id);
  if (w) { w.top = !!top; saveState(); }
  if (win && !win.isDestroyed()) { win.setAlwaysOnTop(!!top, 'screen-saver'); if (top) enforceTop(win, w); }
  broadcast('widgets', state.widgets);
  return !!top;
});

ipcMain.handle('dash-min', () => dash && dash.minimize());
ipcMain.handle('dash-close', () => dash && dash.hide());
