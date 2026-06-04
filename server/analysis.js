import { queryAll } from "./db.js";
import { getCatalogSearchNames, getSimilarProductNames } from "./gemini.js";

const COMBO_PATTERN = /\bcombo\b/i;
const MARGIN_FACTOR = 1.4;
const MIN_NOMBRE_BUSQUEDA = 4;
const PRICE_MIN_FACTOR = 0.25;
const PRICE_MAX_FACTOR = 4;
const STOP_WORDS = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "y",
  "con",
  "para",
  "en",
  "del",
  "al",
]);
const GENERAL_NEGATIVE_TERMS = [
  "accesorio",
  "accesorios",
  "repuesto",
  "repuestos",
  "pieza",
  "piezas",
  "parte",
  "partes",
  "kit",
  "manguera",
  "filtro",
  "tapa",
  "cable",
  "cargador",
  "adaptador",
  "forro",
  "funda",
  "protector",
  "mica",
  "control",
  "control remoto",
  "soporte",
  "base",
  "bomba",
  "motor",
];
const CATEGORY_NEGATIVE_RULES = [
  {
    triggers: ["lavadora", "lavarropa", "lavarropas", "secadora"],
    terms: [
      "correa",
      "timer",
      "temporizador",
      "tarjeta",
      "placa",
      "valvula",
      "presostato",
      "agitador",
      "tambor",
      "sello",
      "reten",
    ],
  },
  {
    triggers: ["refrigerador", "refrigeradora", "nevera", "congelador", "freezer"],
    terms: [
      "compresor",
      "termostato",
      "gas",
      "goma",
      "junta",
      "bandeja",
      "puerta",
      "sensor",
      "evaporador",
      "condensador",
    ],
  },
  {
    triggers: ["televisor", "television", "tv", "monitor"],
    terms: [
      "mando",
      "remoto",
      "pantalla",
      "display",
      "tira led",
      "led",
      "mainboard",
      "fuente",
      "tarjeta",
      "placa",
    ],
  },
  {
    triggers: ["telefono", "celular", "iphone", "samsung", "xiaomi", "tablet"],
    terms: [
      "cristal",
      "display",
      "pantalla",
      "bateria",
      "batería",
      "modulo",
      "modulo pantalla",
      "carcasa",
      "mica",
      "cover",
    ],
  },
  {
    triggers: ["laptop", "computadora", "pc", "notebook"],
    terms: [
      "teclado",
      "mouse",
      "raton",
      "bateria",
      "batería",
      "pantalla",
      "display",
      "disco",
      "ram",
      "memoria",
      "ssd",
      "hdd",
    ],
  },
  {
    triggers: ["bicicleta", "bici", "moto", "scooter", "triciclo", "motorina"],
    terms: [
      "casco",
      "goma",
      "llanta",
      "neumatico",
      "neumático",
      "bateria",
      "batería",
      "cadena",
      "freno",
      "pedal",
      "rin",
      "aro",
    ],
  },
  {
    triggers: ["aire acondicionado", "split", "clima"],
    terms: [
      "tuberia",
      "tubería",
      "capacitor",
      "compresor",
      "gas",
      "evaporador",
      "condensador",
      "fan",
      "ventilador",
    ],
  },
  {
    triggers: ["cocina", "estufa", "horno", "freidora"],
    terms: [
      "regulador",
      "valvula",
      "quemador",
      "perilla",
      "resistencia",
      "bandeja",
      "cesta",
      "molde",
    ],
  },
];

function parseMarketPrice(text) {
  if (text == null || text === "") return null;
  const match = String(text).match(/[\d]+(?:[.,]\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(name) {
  return normalizeText(name)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function isComboListing(nombre) {
  return COMBO_PATTERN.test(nombre);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function calcPrecioCuballama(precioVenta, tipoCambio, marcadoRojo) {
  if (precioVenta == null || !Number.isFinite(tipoCambio) || tipoCambio <= 0) {
    return null;
  }
  if (marcadoRojo) {
    return round2(precioVenta * MARGIN_FACTOR);
  }
  return round2((precioVenta / tipoCambio) * MARGIN_FACTOR);
}

let marketCache;

function loadMarketProducts() {
  if (marketCache) return marketCache;

  const rows = queryAll(`
    SELECT p.ID AS id, p.Nombre AS nombre, p.Link AS link, p.Precio AS precio, t.Nombre AS tienda
    FROM Producto p
    JOIN Tienda t ON t.ID = p.ID_tienda
    WHERE p.Precio IS NOT NULL AND TRIM(p.Precio) != ''
  `);

  marketCache = rows
    .map((row) => ({
      id: row.id,
      nombre: row.nombre,
      link: row.link,
      nombreNorm: normalizeText(row.nombre),
      tokens: new Set(tokenize(row.nombre)),
      precio: parseMarketPrice(row.precio),
      tienda: row.tienda,
    }))
    .filter((row) => row.precio != null && !isComboListing(row.nombre));

  return marketCache;
}

function normalizeSearchNames(catalogName, searchNames, includeCatalogName = true) {
  const names = [
    ...(includeCatalogName ? [catalogName] : []),
    ...(searchNames ?? []),
  ]
    .map((name) => normalizeText(name))
    .filter((name) => name.length >= MIN_NOMBRE_BUSQUEDA);
  return [...new Set(names)];
}

function normalizedTermTokens(term) {
  return normalizeText(term)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function listingHasTerm(product, term) {
  const normalized = normalizeText(term);
  if (!normalized) return false;

  const termTokens = normalizedTermTokens(normalized);
  if (termTokens.length === 0) return false;
  if (termTokens.length === 1) return product.tokens.has(termTokens[0]);

  return (
    product.nombreNorm.includes(normalized) ||
    termTokens.every((token) => product.tokens.has(token))
  );
}

function getNegativeTerms(catalogName) {
  const catalogNorm = normalizeText(catalogName);
  const catalogTokens = new Set(tokenize(catalogName));
  const terms = new Set(GENERAL_NEGATIVE_TERMS.map((term) => normalizeText(term)));

  for (const rule of CATEGORY_NEGATIVE_RULES) {
    if (rule.triggers.some((trigger) => listingHasTerm({ nombreNorm: catalogNorm, tokens: catalogTokens }, trigger))) {
      for (const term of rule.terms) {
        terms.add(normalizeText(term));
      }
    }
  }

  // Si el inventario ya es un accesorio/repuesto, no lo excluimos por su propio nombre.
  return [...terms].filter((term) => {
    const termTokens = normalizedTermTokens(term);
    return termTokens.length > 0 && !termTokens.every((token) => catalogTokens.has(token));
  });
}

function isNegativeListing(product, negativeTerms) {
  return negativeTerms.some((term) => listingHasTerm(product, term));
}

function buildPriceFilter(precioCuballama) {
  if (precioCuballama == null || !Number.isFinite(precioCuballama) || precioCuballama <= 0) {
    return null;
  }

  return {
    min: round2(precioCuballama * PRICE_MIN_FACTOR),
    max: round2(precioCuballama * PRICE_MAX_FACTOR),
    minFactor: PRICE_MIN_FACTOR,
    maxFactor: PRICE_MAX_FACTOR,
  };
}

function isPriceComparable(product, priceFilter) {
  if (!priceFilter) return true;
  return product.precio >= priceFilter.min && product.precio <= priceFilter.max;
}

/** Alguno de los nombres generados debe aparecer dentro de la publicación. */
function searchNameInListing(searchNamesNorm, product) {
  return searchNamesNorm.find((name) => listingHasTerm(product, name)) ?? null;
}

function scoreSimilarity(catalogName, product) {
  const catalogTokens = tokenize(catalogName);
  const catalogNorm = normalizeText(catalogName);
  if (catalogTokens.length === 0) return 0;

  let hits = 0;
  for (const token of catalogTokens) {
    if (product.tokens.has(token)) hits += 1;
  }
  let score = hits / catalogTokens.length;

  if (listingHasTerm(product, catalogNorm)) {
    score += 0.25;
    if (catalogNorm.length / product.nombreNorm.length >= 0.35) {
      score += 0.2;
    }
  }

  return Math.min(score, 1.5);
}

function findPublications(catalogName, searchNames, options = {}) {
  const searchNamesNorm = normalizeSearchNames(
    catalogName,
    searchNames,
    options.includeCatalogName ?? true,
  );
  if (searchNamesNorm.length === 0) {
    return [];
  }

  const products = loadMarketProducts();
  const matched = [];
  const negativeTerms = getNegativeTerms(catalogName);
  const priceFilter = buildPriceFilter(options.precioCuballama);

  for (const product of products) {
    if (isNegativeListing(product, negativeTerms)) continue;
    if (!isPriceComparable(product, priceFilter)) continue;

    const terminoBusqueda = searchNameInListing(searchNamesNorm, product);
    if (!terminoBusqueda) continue;

    const similitud = Math.max(
      scoreSimilarity(catalogName, product),
      ...searchNamesNorm.map((name) => scoreSimilarity(name, product)),
    );
    matched.push({
      id: product.id,
      nombre: product.nombre,
      precio: product.precio,
      link: product.link,
      tienda: product.tienda,
      terminoBusqueda,
      similitud: round2(similitud),
      esSemejante: similitud >= 0.65,
    });
  }

  return matched.sort((a, b) => b.similitud - a.similitud || a.precio - b.precio);
}

function buildPriceStats(publicaciones, precioCuballama) {
  const count = publicaciones.length;
  const semejantes = publicaciones.filter((p) => p.esSemejante);
  const precios = publicaciones.map((p) => p.precio);

  if (count === 0) {
    return {
      cantidadPublicaciones: 0,
      cantidadSemejantes: 0,
      precioMin: null,
      precioMedio: null,
      distanciaMin: null,
      distanciaMedio: null,
      sinPublicaciones: true,
    };
  }

  const precioMin = Math.min(...precios);
  const precioMedio = median(precios);
  const distanciaMin =
    precioCuballama != null ? round2(precioMin - precioCuballama) : null;
  const distanciaMedio =
    precioCuballama != null ? round2(precioMedio - precioCuballama) : null;

  return {
    cantidadPublicaciones: count,
    cantidadSemejantes: semejantes.length,
    precioMin: round2(precioMin),
    precioMedio: round2(precioMedio),
    distanciaMin,
    distanciaMedio,
    sinPublicaciones: false,
  };
}

export function analyzeProduct(item, tipoCambio, searchInfo) {
  const precioCuballama = calcPrecioCuballama(
    item.precioVenta,
    tipoCambio,
    item.marcadoRojo,
  );
  const nombresBusqueda = searchInfo?.nombres ?? [];
  const publicaciones = findPublications(item.nombre, nombresBusqueda, {
    precioCuballama,
  });
  const stats = buildPriceStats(publicaciones, precioCuballama);

  return {
    id: item.codigo,
    codigo: item.codigo,
    nombre: item.nombre,
    precioVenta: item.precioVenta,
    inventario: item.inventario ?? null,
    marcadoRojo: Boolean(item.marcadoRojo),
    formulaPrecioCuballama: item.marcadoRojo
      ? "precio_venta_x_1_4"
      : "precio_venta_div_tipo_cambio_x_1_4",
    tipoCambio,
    precioCuballama,
    criterioBusqueda: "nombres_ia_en_publicacion",
    fuenteNombresBusqueda: searchInfo?.source ?? "fallback",
    nombresBusqueda,
    palabrasNegativas: getNegativeTerms(item.nombre),
    filtroPrecioMercado: buildPriceFilter(precioCuballama),
    ...stats,
    publicaciones,
    publicacionesSemejantes: publicaciones.filter((p) => p.esSemejante),
  };
}

export async function analyzeCatalog(items, tipoCambio, onProgress) {
  onProgress?.("Generando términos de búsqueda para cada producto…");
  const searchNamesByCode = await getCatalogSearchNames(items, onProgress);

  onProgress?.("Cargando publicaciones del mercado Cuballama en memoria…");
  loadMarketProducts();

  const total = items.length;
  onProgress?.(`Comparando precios de ${total} producto(s) con el mercado…`);

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    rows.push(analyzeProduct(item, tipoCambio, searchNamesByCode.get(item.codigo)));
    const n = i + 1;
    if (n === 1 || n === total || n % 25 === 0) {
      onProgress?.(`Comparando con el mercado (${n}/${total})…`);
    }
  }

  onProgress?.("Análisis completado.");
  return rows;
}

export async function analyzeSimilarProducts({ nombre, precioCuballama }) {
  const searchInfo = await getSimilarProductNames({ nombre, precioCuballama });
  const publicaciones = findPublications(nombre, searchInfo.nombres, {
    includeCatalogName: false,
    precioCuballama,
  });

  return {
    nombre,
    precioCuballama,
    fuenteNombresBusqueda: searchInfo.source,
    nombresBusqueda: searchInfo.nombres,
    palabrasNegativas: getNegativeTerms(nombre),
    filtroPrecioMercado: buildPriceFilter(precioCuballama),
    publicaciones,
  };
}

export function clearMarketCache() {
  marketCache = undefined;
}
