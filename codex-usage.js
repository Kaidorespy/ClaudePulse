const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function codexExecutable() {
  if (process.env.PULSE_CODEX_PATH) return process.env.PULSE_CODEX_PATH;
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return fs.existsSync(installed) ? installed : process.platform === 'win32' ? 'codex.exe' : 'codex';
}

// A short-lived, read-only app-server connection lets Codex own authentication.
// No prompts, threads, credential copies or model calls are needed.
function readRateLimits({ executable = codexExecutable(), timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    });
    let buffer = '', done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out')), timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', err => finish(err));
    child.stdin.on('error', err => finish(err));
    child.on('exit', () => { if (!done) finish(new Error('Codex app-server exited before returning limits')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.error && (m.id === 1 || m.id === 2)) { finish(new Error(m.error.message)); return; }
        if (m.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read' });
        }
        if (m.id === 2) { finish(null, m.result); return; }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pulse', version: '2.0.0' } } });
  });
}

function normalizeCodex(data) {
  const buckets = { ...(data.rateLimitsByLimitId || {}) };
  if (data.rateLimits) {
    const id = data.rateLimits.limitId || 'codex';
    if (!buckets[id]) buckets[id] = data.rateLimits;
  }
  const limits = [];
  for (const [id, bucket] of Object.entries(buckets)) {
    if (!bucket) continue;
    for (const slot of ['primary', 'secondary']) {
      const w = bucket[slot];
      if (!w || !Number.isFinite(w.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const window = mins === 10080 ? 'Weekly' : mins === 300 ? '5h' : mins ? `${mins / 60}h` : slot;
      const name = bucket.limitName || (id === 'codex' ? '' : id);
      const used = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
      limits.push({ kind: `codex:${id}:${slot}`, provider: 'codex',
        label: `${name ? name + ' · ' : ''}${window} limit`, percent: used,
        remaining: 100 - used,
        resets_at: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null });
    }
  }
  return { status: 'ok', fetchedAt: Date.now(), limits };
}

module.exports = { readRateLimits, normalizeCodex };
