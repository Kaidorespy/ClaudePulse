// Percent display for Pulse. Shared by the main process (tray tooltip,
// notifications) and both renderers (dashboard rows, widget pills).
//
// Claude's own /status reports percent USED. Codex's reports percent LEFT.
// "original" keeps each provider's native convention; the other modes make
// every bar read the same way.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PulsePercent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = ['original', 'used', 'left', 'both'];
  const LABELS = {
    original: 'Original · Claude % used, Codex % left',
    used: '% used everywhere',
    left: '% left everywhere',
    both: 'Both · % used and % left'
  };
  const clamp = n => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
  const normalize = mode => MODES.includes(mode) ? mode : 'original';
  const used = l => clamp(l.percent);
  const left = l => Number.isFinite(l.remaining) ? clamp(l.remaining) : 100 - used(l);

  // True when this limit reads as "% left" in the given mode.
  function showsLeft(l, mode) {
    mode = normalize(mode);
    return mode === 'left' || (mode === 'original' && l.provider === 'codex');
  }

  // What the bar fills with. In "both" the bar follows % used.
  function bar(l, mode) {
    return showsLeft(l, mode) ? left(l) : used(l);
  }

  // The number next to the bar. compact = widget pill, where Claude's
  // original look is a bare "43%".
  function text(l, mode, compact) {
    mode = normalize(mode);
    if (mode === 'both') return `${used(l)}% used · ${left(l)}% left`;
    if (showsLeft(l, mode)) return `${left(l)}% left`;
    if (mode === 'original' && compact) return `${used(l)}%`;
    return `${used(l)}% used`;
  }

  // Threshold notification wording: thresholds are crossed on % used, but the
  // sentence should read the way the user sees the number.
  function notice(l, mode) {
    return showsLeft(l, mode) ? `down to ${left(l)}% left` : `hit ${used(l)}% used`;
  }

  return { MODES, LABELS, normalize, used, left, showsLeft, bar, text, notice };
});
