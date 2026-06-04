// Funciones puras de formato y cálculo. Sin estado ni acceso al DOM.

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function mean(values) {
  if (!values.length) return null;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

export function formatMoney(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${Number(value).toFixed(2)}`;
}

export function formatSignedMoney(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function formatPercent(fraction, decimals = 0) {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function normalizeTerm(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
