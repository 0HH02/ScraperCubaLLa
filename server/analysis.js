import { ensureFreshDatabase, getDbVersion, hasColumn, queryAll } from "./db.js";
import { getCatalogSearchNames, getSimilarProductNames } from "./gemini.js";
import { parsePriceText, toUsd, USD } from "./price.js";

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

let marketCache = null;
let marketCacheKey = "";

/** El importe convertido a USD, prefiriendo el que ya normalizó el scraper. */
function resolveListingUsd(row, rates) {
  const valor = Number(row.precioValor);
  if (Number.isFinite(valor) && valor > 0) {
    return toUsd({ amount: valor, currency: row.precioMoneda || USD }, rates);
  }
  return toUsd(parsePriceText(row.precio), rates);
}

function buildTokenIndex(products) {
  const byToken = new Map();
  for (const product of products) {
    for (const token of product.tokens) {
      let bucket = byToken.get(token);
      if (!bucket) {
        bucket = [];
        byToken.set(token, bucket);
      }
      bucket.push(product);
    }
  }
  return byToken;
}

function loadMarketProducts(rates = {}) {
  ensureFreshDatabase();

  const key = `${getDbVersion()}|${rates.cupPerUsd ?? ""}|${rates.usdPerEur ?? ""}`;
  if (marketCache && marketCacheKey === key) return marketCache;

  const soloActivos = hasColumn("Producto", "Activo");
  const tienePrecioValor = hasColumn("Producto", "Precio_Valor");
  const columnasPrecio = tienePrecioValor
    ? "p.Precio_Valor AS precioValor, p.Precio_Moneda AS precioMoneda,"
    : "NULL AS precioValor, NULL AS precioMoneda,";

  const rows = queryAll(`
    SELECT p.ID AS id, p.Nombre AS nombre, p.Link AS link,
           ${columnasPrecio}
           p.Precio AS precio, t.Nombre AS tienda
    FROM Producto p
    JOIN Tienda t ON t.ID = p.ID_tienda
    WHERE p.Nombre IS NOT NULL AND TRIM(p.Nombre) != ''
      ${soloActivos ? "AND p.Activo = 1" : ""}
  `);

  const products = [];
  for (const row of rows) {
    if (isComboListing(row.nombre)) continue;
    const precio = resolveListingUsd(row, rates);
    if (precio == null || precio <= 0) continue;

    products.push({
      id: row.id,
      nombre: row.nombre,
      link: row.link,
      nombreNorm: normalizeText(row.nombre),
      tokens: new Set(tokenize(row.nombre)),
      precio: round2(precio),
      tienda: row.tienda,
    });
  }

  marketCache = buildTokenIndex(products);
  marketCacheKey = key;
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

function listingHasNormalizedTerm(product, norm, termTokens) {
  if (!norm || termTokens.length === 0) return false;
  if (termTokens.length === 1) return product.tokens.has(termTokens[0]);

  return (
    product.nombreNorm.includes(norm) ||
    termTokens.every((token) => product.tokens.has(token))
  );
}

function listingHasTerm(product, term) {
  const normalized = normalizeText(term);
  return listingHasNormalizedTerm(product, normalized, normalizedTermTokens(normalized));
}

/** Deja un término listo para comparar muchas veces sin re-normalizarlo. */
function compileTerm(term) {
  const norm = normalizeText(term);
  return { norm, tokens: normalizedTermTokens(norm) };
}

function compileTerms(terms) {
  return terms.map(compileTerm).filter((t) => t.tokens.length > 0);
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

function isNegativeListing(product, compiledNegatives) {
  return compiledNegatives.some((term) =>
    listingHasNormalizedTerm(product, term.norm, term.tokens),
  );
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

/**
 * Reduce el mercado a las publicaciones que pueden coincidir. Recorrer las
 * 30.000+ publicaciones por cada producto del catálogo era el cuello de botella.
 *
 * Por término se toman tres grupos, uno por cada forma de coincidir: el token
 * menos frecuente cubre "todas las palabras presentes"; la primera y la última
 * palabra cubren la coincidencia por subcadena ("televisor smart" dentro de
 * "Televisor SmartTV", "spaguetis 500g" dentro de "Espaguetis 500g").
 */
function collectCandidates(byToken, searchTerms) {
  const candidates = new Set();

  const addBucket = (bucket) => {
    if (!bucket) return;
    for (const product of bucket) candidates.add(product);
  };

  for (const term of searchTerms) {
    let smallest = null;
    for (const token of term.tokens) {
      const bucket = byToken.get(token);
      if (!bucket) {
        smallest = null;
        break;
      }
      if (!smallest || bucket.length < smallest.length) smallest = bucket;
    }
    addBucket(smallest);

    if (term.tokens.length > 1) {
      addBucket(byToken.get(term.tokens[0]));
      addBucket(byToken.get(term.tokens[term.tokens.length - 1]));
    }
  }

  return candidates;
}

function matchingSearchTerm(product, searchTerms) {
  for (const term of searchTerms) {
    if (listingHasNormalizedTerm(product, term.norm, term.tokens)) return term.norm;
  }
  return null;
}

function scoreSimilarity(nameInfo, product) {
  if (nameInfo.tokens.length === 0) return 0;

  let hits = 0;
  for (const token of nameInfo.tokens) {
    if (product.tokens.has(token)) hits += 1;
  }
  let score = hits / nameInfo.tokens.length;

  if (listingHasNormalizedTerm(product, nameInfo.norm, nameInfo.tokens)) {
    score += 0.25;
    if (nameInfo.norm.length / product.nombreNorm.length >= 0.35) {
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

  const searchTerms = compileTerms(searchNamesNorm);
  if (searchTerms.length === 0) {
    return [];
  }

  const index = loadMarketProducts(options.rates);
  const negativeTerms = compileTerms(getNegativeTerms(catalogName));
  const priceFilter = buildPriceFilter(options.precioCuballama);
  const scoringNames = [compileTerm(catalogName), ...searchTerms].filter(
    (name) => name.tokens.length > 0,
  );
  const matched = [];

  for (const product of collectCandidates(index, searchTerms)) {
    const terminoBusqueda = matchingSearchTerm(product, searchTerms);
    if (!terminoBusqueda) continue;
    if (!isPriceComparable(product, priceFilter)) continue;
    if (isNegativeListing(product, negativeTerms)) continue;

    let similitud = 0;
    for (const name of scoringNames) {
      const score = scoreSimilarity(name, product);
      if (score > similitud) similitud = score;
    }

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

  if (count === 0) {
    return {
      cantidadPublicaciones: 0,
      cantidadSemejantes: 0,
      baseEstadisticas: null,
      precioMin: null,
      precioMedio: null,
      distanciaMin: null,
      distanciaMedio: null,
      sinPublicaciones: true,
    };
  }

  // Una coincidencia floja y barata hundía el mínimo y la mediana. Cuando hay
  // publicaciones realmente semejantes, la comparación se hace solo con ellas.
  const base = semejantes.length > 0 ? semejantes : publicaciones;
  const precios = base.map((p) => p.precio);

  const precioMin = Math.min(...precios);
  const precioMedio = median(precios);
  const distanciaMin =
    precioCuballama != null ? round2(precioMin - precioCuballama) : null;
  const distanciaMedio =
    precioCuballama != null ? round2(precioMedio - precioCuballama) : null;

  return {
    cantidadPublicaciones: count,
    cantidadSemejantes: semejantes.length,
    baseEstadisticas: semejantes.length > 0 ? "semejantes" : "todas",
    precioMin: round2(precioMin),
    precioMedio: round2(precioMedio),
    distanciaMin,
    distanciaMedio,
    sinPublicaciones: false,
  };
}

/**
 * El tipo de cambio del catálogo (moneda local por dólar) es también el que
 * permite llevar a USD los anuncios publicados en CUP.
 */
function ratesFor(tipoCambio) {
  return { cupPerUsd: Number(tipoCambio) };
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
    rates: ratesFor(tipoCambio),
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
  loadMarketProducts(ratesFor(tipoCambio));

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

export async function analyzeSimilarProducts({ nombre, precioCuballama, tipoCambio }) {
  const searchInfo = await getSimilarProductNames({ nombre, precioCuballama });
  const publicaciones = findPublications(nombre, searchInfo.nombres, {
    includeCatalogName: false,
    precioCuballama,
    rates: ratesFor(tipoCambio),
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
  marketCache = null;
  marketCacheKey = "";
}
