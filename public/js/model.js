// Transformaciones de datos, scoring de competitividad y agregados.
import { round2, median, normalizeTerm } from "./utils.js";
import { getDisabledTerms } from "./storage.js";

// Catálogo de niveles de competitividad. El orden define la jerarquía visual.
// Los colores cumplen contraste >= 3:1 sobre la superficie oscura (uso gráfico).
export const BUCKETS = {
  imbatible: {
    key: "imbatible",
    label: "Imbatible",
    short: "Imbatible",
    color: "#3fb950",
    description: "Tu precio iguala o mejora al más barato del mercado.",
  },
  competitivo: {
    key: "competitivo",
    label: "Competitivo",
    short: "Competitivo",
    color: "#58a6ff",
    description: "Estás por debajo o en la mediana del mercado.",
  },
  "sobre-media": {
    key: "sobre-media",
    label: "Sobre la mediana",
    short: "Sobre media",
    color: "#d29922",
    description: "Estás por encima de la mediana pero dentro del rango.",
  },
  caro: {
    key: "caro",
    label: "Por encima del mercado",
    short: "Caro",
    color: "#f85149",
    description: "Eres más caro que cualquier publicación encontrada.",
  },
  "sin-datos": {
    key: "sin-datos",
    label: "Sin datos",
    short: "Sin datos",
    color: "#6e7d90",
    description: "No hay publicaciones comparables en el mercado.",
  },
};

export const BUCKET_ORDER = [
  "imbatible",
  "competitivo",
  "sobre-media",
  "caro",
  "sin-datos",
];

export function getSearchTermOptions(row) {
  const seen = new Set([normalizeTerm(row.nombre)]);
  return (row.nombresBusqueda || [])
    .map((name) => ({ label: String(name).trim(), value: normalizeTerm(name) }))
    .filter((term) => {
      if (!term.label || !term.value || seen.has(term.value)) return false;
      seen.add(term.value);
      return true;
    });
}

function getActiveTermSet(row) {
  const disabled = getDisabledTerms(row.codigo);
  const active = new Set([normalizeTerm(row.nombre)]);
  for (const term of getSearchTermOptions(row)) {
    if (!disabled.has(term.value)) active.add(term.value);
  }
  return active;
}

export function getActivePublications(row) {
  const activeTerms = getActiveTermSet(row);
  return (row.publicacionesOriginales || row.publicaciones || []).filter((pub) => {
    const termino = normalizeTerm(pub.terminoBusqueda);
    return !termino || activeTerms.has(termino);
  });
}

export function recalcRowStats(row) {
  if (!row.publicacionesOriginales) {
    row.publicacionesOriginales = row.publicaciones || [];
  }

  const publicaciones = getActivePublications(row);
  row.publicaciones = publicaciones;
  row.publicacionesSemejantes = publicaciones.filter((p) => p.esSemejante);
  row.cantidadPublicaciones = publicaciones.length;
  row.cantidadSemejantes = row.publicacionesSemejantes.length;

  if (!publicaciones.length) {
    row.precioMin = null;
    row.precioMedio = null;
    row.precioMax = null;
    row.distanciaMin = null;
    row.distanciaMedio = null;
    row.sinPublicaciones = true;
    return row;
  }

  const precios = publicaciones.map((p) => p.precio);
  row.precioMin = round2(Math.min(...precios));
  row.precioMedio = round2(median(precios));
  row.precioMax = round2(Math.max(...precios));
  row.distanciaMin =
    row.precioCuballama != null ? round2(row.precioMin - row.precioCuballama) : null;
  row.distanciaMedio =
    row.precioCuballama != null ? round2(row.precioMedio - row.precioCuballama) : null;
  row.sinPublicaciones = false;
  return row;
}

export function prepareRows(rows) {
  return rows.map((row) => {
    if (!row.publicacionesOriginales) row.publicacionesOriginales = row.publicaciones || [];
    return recalcRowStats(row);
  });
}

/**
 * Evalúa la competitividad de un producto frente al mercado.
 * percentile = fracción de publicaciones más caras que tú (1 = más barato que todas).
 */
export function getCompetitiveness(row) {
  const my = row.precioCuballama;
  const publicaciones = row.publicaciones || [];

  if (row.sinPublicaciones || my == null || !publicaciones.length) {
    return { bucket: "sin-datos", percentile: null, gapMin: null, gapMedian: null };
  }

  const pricier = publicaciones.filter((p) => p.precio >= my).length;
  const percentile = pricier / publicaciones.length;
  const gapMin = round2(my - row.precioMin);
  const gapMedian = round2(my - row.precioMedio);

  let bucket;
  if (my <= row.precioMin) bucket = "imbatible";
  else if (my <= row.precioMedio) bucket = "competitivo";
  else if (my <= row.precioMax) bucket = "sobre-media";
  else bucket = "caro";

  return { bucket, percentile, gapMin, gapMedian };
}

export function summarize(rows) {
  const counts = Object.fromEntries(BUCKET_ORDER.map((key) => [key, 0]));
  const percentiles = [];
  let gapMedianTotal = 0;
  let conDatos = 0;

  for (const row of rows) {
    const { bucket, percentile, gapMedian } = getCompetitiveness(row);
    counts[bucket] += 1;
    if (bucket !== "sin-datos") {
      conDatos += 1;
      if (percentile != null) percentiles.push(percentile);
      if (gapMedian != null) gapMedianTotal += gapMedian;
    }
  }

  const competitivos = counts.imbatible + counts.competitivo;
  return {
    total: rows.length,
    conDatos,
    sinDatos: counts["sin-datos"],
    counts,
    competitivos,
    porEncima: counts["sobre-media"] + counts.caro,
    medianPercentile: median(percentiles),
    tasaCompetitiva: conDatos ? competitivos / conDatos : null,
    gapMedianPromedio: conDatos ? round2(gapMedianTotal / conDatos) : null,
  };
}

export function getSubcategories(row) {
  const groups = new Map();
  for (const pub of row.publicaciones || []) {
    const key = normalizeTerm(pub.terminoBusqueda) || normalizeTerm(row.nombre);
    if (!groups.has(key)) {
      groups.set(key, { key, nombre: getTermLabel(row, key), publicaciones: [] });
    }
    groups.get(key).publicaciones.push(pub);
  }

  return [...groups.values()]
    .map((group) => {
      const precios = group.publicaciones.map((p) => p.precio);
      return {
        ...group,
        publicaciones: group.publicaciones.sort((a, b) => a.precio - b.precio),
        precioMin: Math.min(...precios),
        precioMax: Math.max(...precios),
      };
    })
    .sort(
      (a, b) =>
        a.precioMin - b.precioMin ||
        b.publicaciones.length - a.publicaciones.length ||
        a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }),
    );
}

export function getTermLabel(row, termValue) {
  const original = normalizeTerm(row.nombre);
  if (!termValue || termValue === original) return "Nombre original";
  const option = getSearchTermOptions(row).find((term) => term.value === termValue);
  return option?.label || termValue;
}
