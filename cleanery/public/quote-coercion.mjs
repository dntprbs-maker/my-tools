export function coerceArea(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 && v <= 300 ? v : NaN;
  }
  if (typeof v === 'string') {
    if (v.trim() === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 300 ? n : NaN;
  }
  return NaN;
}

export function coerceNotes(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length <= 1000 ? t : null;
  }
  return null;
}