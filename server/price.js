/**
 * Interpretación de precios del mercado.
 *
 * Los anuncios llegan como texto libre ("$12.99 USD", "1.299,00 CUP", "€10").
 * Tratar todos los importes como USD falseaba las métricas, así que aquí se
 * separan importe y moneda, y la conversión a USD es explícita.
 */

export const USD = "USD";

const CURRENCY_PATTERNS = [
  [/\bCUP\b|\bMN\b|\bmoneda\s+nacional\b/i, "CUP"],
  [/\bMLC\b/i, "MLC"],
  [/\bEUR\b|€/i, "EUR"],
  [/\bUSD\b|\bUS\$|\bdólares?\b|\bdolares?\b/i, USD],
];

const AMOUNT_RE = /\d[\d.,\u00a0\s]*\d|\d/;

function detectCurrency(text) {
  for (const [pattern, currency] of CURRENCY_PATTERNS) {
    if (pattern.test(text)) return currency;
  }
  // "$" sin más contexto es dólar en el mercado de Cuballama.
  return /\$/.test(text) ? USD : null;
}

/**
 * Convierte "1.299,00" o "1,299.00" al número 1299.
 * Con un único separador se decide por la cantidad de dígitos que le siguen:
 * tres dígitos indican millares, uno o dos indican decimales.
 */
function parseAmount(raw) {
  const cleaned = raw.replace(/[\s\u00a0]/g, "");
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized;

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    normalized = cleaned
      .split(thousandSep)
      .join("")
      .replace(decimalSep, ".");
  } else {
    const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
    if (sep === null) {
      normalized = cleaned;
    } else {
      const parts = cleaned.split(sep);
      const decimals = parts[parts.length - 1];
      const isThousands = parts.length > 2 || decimals.length === 3;
      normalized = isThousands ? parts.join("") : `${parts.slice(0, -1).join("")}.${decimals}`;
    }
  }

  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extrae importe y moneda de un texto de precio.
 * Devuelve null cuando no hay ningún importe reconocible.
 */
export function parsePriceText(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;

  const match = raw.match(AMOUNT_RE);
  if (!match) return null;

  const amount = parseAmount(match[0]);
  if (amount == null || amount < 0) return null;

  return { amount, currency: detectCurrency(raw), raw };
}

/**
 * Lleva un precio a USD. Devuelve null si la moneda no se puede convertir,
 * para que el importe quede fuera de la comparación en vez de distorsionarla.
 */
export function toUsd(price, rates = {}) {
  if (!price || price.amount == null) return null;

  const currency = price.currency ?? USD;
  if (currency === USD) return price.amount;

  if (currency === "MLC") {
    // El MLC cotiza a la par del dólar dentro del mercado formal.
    return price.amount;
  }

  if (currency === "CUP") {
    const cupPerUsd = Number(rates.cupPerUsd);
    if (!Number.isFinite(cupPerUsd) || cupPerUsd <= 0) return null;
    return price.amount / cupPerUsd;
  }

  if (currency === "EUR") {
    const usdPerEur = Number(rates.usdPerEur);
    if (!Number.isFinite(usdPerEur) || usdPerEur <= 0) return null;
    return price.amount * usdPerEur;
  }

  return null;
}

/** Atajo para las rutas que solo necesitan el importe en USD. */
export function parsePriceUsd(text, rates = {}) {
  return toUsd(parsePriceText(text), rates);
}
