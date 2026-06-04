// Controlador de la interfaz. Orquesta módulos y maneja vistas y eventos.
import { formatMoney, formatPercent, escapeHtml, normalizeTerm } from "./js/utils.js";
import {
  loadSession,
  saveSession,
  loadCachedFile,
  getCachedFileMeta,
  loadTipoCambio,
  saveTipoCambio,
  getDisabledTerms,
  setTermDisabled,
  loadSortPreference,
  saveSortPreference,
  loadSettingsOpen,
  saveSettingsOpen,
} from "./js/storage.js";
import { fetchHealth, analyzeWithFile, fetchMarketSearch, fetchSimilarProducts } from "./js/api.js";
import {
  prepareRows,
  recalcRowStats,
  getSearchTermOptions,
  getSubcategories,
  getCompetitiveness,
  summarize,
  BUCKETS,
} from "./js/model.js";
import {
  renderBreakdown,
  renderOpportunities,
  renderComparison,
  renderHistogram,
} from "./js/charts.js";

/* ---------------------------------------------------------------- Elementos */
const $ = (id) => document.getElementById(id);

const marketBadge = $("market-badge");
const settingsToggle = $("settings-toggle");
const settingsPanel = $("settings-panel");
const form = $("upload-form");
const fileInput = $("excel-file");
const tipoCambioInput = $("tipo-cambio");
const analyzeBtn = $("analyze-btn");
const statusEl = $("status");
const cachedFileHint = $("cached-file-hint");
const marketSearchForm = $("market-search-form");
const marketSearchInput = $("market-search-input");
const marketSearchBtn = $("market-search-btn");
const marketSearchStatus = $("market-search-status");
const marketSearchResultsWrap = $("market-search-results-wrap");
const marketSearchTableBody = document.querySelector("#market-search-table tbody");

const dashboardSection = $("dashboard-section");
const dashboardEmpty = $("dashboard-empty");
const dashboardContent = $("dashboard-content");
const emptyCta = $("empty-cta");
const kpiRow = $("kpi-row");
const chartBreakdown = $("chart-breakdown");
const chartOpportunities = $("chart-opportunities");
const filterInput = $("filter");
const competFiltersEl = $("compet-filters");
const tableBody = document.querySelector("#results-table tbody");

const COMPET_FILTER_OPTIONS = [
  { key: "all", label: "Todos", title: "Mostrar todos los productos" },
  { key: "imbatible", label: "Verde", title: BUCKETS.imbatible.description },
  { key: "competitivo", label: "Azul", title: BUCKETS.competitivo.description },
  {
    key: "encima",
    label: "Rojo",
    title: "Sobre la mediana o por encima del máximo del mercado",
  },
  { key: "sin-datos", label: "Sin datos", title: BUCKETS["sin-datos"].description },
];

let competitivenessFilter = "all";

const detailSection = $("detail-section");
const backBtn = $("back-btn");
const detailTitle = $("detail-title");
const detailMeta = $("detail-meta");
const detailVerdict = $("detail-verdict");
const detailStats = $("detail-stats");
const chartComparison = $("chart-comparison");
const chartHistogram = $("chart-histogram");
const detailTerms = $("detail-terms");
const similarBtn = $("similar-btn");
const detailPublicationsTitle = $("detail-publications-title");
const detailTableBody = document.querySelector("#detail-table tbody");

const similarSection = $("similar-section");
const similarBackBtn = $("similar-back-btn");
const similarTitle = $("similar-title");
const similarMeta = $("similar-meta");
const similarStatus = $("similar-status");
const similarTermsBox = $("similar-terms-box");
const similarTerms = $("similar-terms");
const similarSubcategoryCards = $("similar-subcategory-cards");
const similarSubcategoryTableTitle = $("similar-subcategory-table-title");
const similarTableBody = document.querySelector("#similar-table tbody");

/* -------------------------------------------------------------------- Estado */
let allRows = [];
let sortKey = null;
let sortDir = 1;
let currentDetailCodigo = null;
let currentSimilarRow = null;
let selectedSimilarSubcategoryKey = null;

/* ------------------------------------------------------------------- Formato */
function distanciaClass(value) {
  if (value == null || !Number.isFinite(value)) return "dist-inf";
  if (value > 0) return "dist-pos";
  if (value === 0) return "dist-zero";
  return "dist-neg";
}

function formatPriceWithGap(precio, distancia, sinPublicaciones) {
  if (sinPublicaciones) {
    return `<span class="price-inf">∞</span>`;
  }
  const gap =
    distancia == null
      ? ""
      : `<span class="dist ${distanciaClass(distancia)}">${
          distancia >= 0 ? "+" : "−"
        }$${Math.abs(distancia).toFixed(2)} vs tú</span>`;
  return `${formatMoney(precio)} ${gap}`;
}

function percentileText(comp) {
  if (comp.percentile == null) return "";
  return `más barato que ${formatPercent(comp.percentile)}`;
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
  statusEl.classList.toggle("status--busy", type !== "error" && type !== "ok" && Boolean(message));
}

function setSimilarStatus(message, type = "") {
  similarStatus.textContent = message;
  similarStatus.className = `status ${type}`.trim();
}

/* -------------------------------------------------------- Términos de búsqueda */
function renderSearchTerms(row) {
  const terms = getSearchTermOptions(row);
  if (!terms.length) {
    return `<div class="search-terms empty-terms">Sin nombres alternativos.</div>`;
  }
  const disabled = getDisabledTerms(row.codigo);
  return `
    <div class="search-terms" aria-label="Nombres alternativos de búsqueda">
      ${terms
        .map(
          (term) => `
        <label class="search-term ${disabled.has(term.value) ? "disabled" : ""}">
          <input
            type="checkbox"
            data-term-toggle="1"
            data-codigo="${escapeHtml(row.codigo || "")}"
            data-term="${escapeHtml(term.value)}"
            ${disabled.has(term.value) ? "" : "checked"}
          />
          <span>${escapeHtml(term.label)}</span>
        </label>`,
        )
        .join("")}
    </div>`;
}

function renderMarketFilters(row) {
  const negativeWords = (row.palabrasNegativas || [])
    .slice(0, 30)
    .map((word) => `<code>${escapeHtml(word)}</code>`)
    .join(", ");
  const f = row.filtroPrecioMercado;
  const priceLabel = f ? `${formatMoney(f.min)} – ${formatMoney(f.max)}` : "sin filtro de precio";
  return `
    <p><strong>Filtro de precio del mercado:</strong> ${priceLabel}</p>
    <p><strong>Palabras negativas:</strong> ${negativeWords || "—"}</p>`;
}

function bindTermToggles(container, resolveRow, afterChange) {
  container.querySelectorAll("[data-term-toggle]").forEach((input) => {
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", () => {
      const row = resolveRow(input);
      if (!row) return;
      setTermDisabled(row.codigo, input.dataset.term, !input.checked);
      recalcRowStats(row);
      afterChange(row);
    });
  });
}

/* ---------------------------------------------------------------- Ordenamiento */
function sortValue(row, key) {
  switch (key) {
    case "nombre":
      return (row.nombre ?? "").toLowerCase();
    case "competitividad":
      return getCompetitiveness(row).percentile ?? -1;
    case "inventario":
      return row.inventario ?? -1;
    case "precioCuballama":
      return row.precioCuballama ?? -Infinity;
    case "distanciaMin":
      return row.sinPublicaciones ? Infinity : row.distanciaMin ?? Infinity;
    case "distanciaMedio":
      return row.sinPublicaciones ? Infinity : row.distanciaMedio ?? Infinity;
    case "cantidadPublicaciones":
      return row.cantidadPublicaciones ?? 0;
    default:
      return 0;
  }
}

function sortedRows(rows) {
  if (!sortKey) return rows;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    if (typeof va === "string") {
      return va.localeCompare(vb, "es", { sensitivity: "base" }) * sortDir;
    }
    return (va - vb) * sortDir;
  });
}

function updateSortIcons() {
  document.querySelectorAll("#results-table th.sortable").forEach((th) => {
    const key = th.dataset.sort;
    const icon = th.querySelector(".sort-icon");
    if (key === sortKey) {
      icon.textContent = sortDir > 0 ? "▲" : "▼";
      th.classList.add("sorted");
      th.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
    } else {
      icon.textContent = "";
      th.classList.remove("sorted");
      th.removeAttribute("aria-sort");
    }
  });
}

/* --------------------------------------------------------------------- Tabla */
function getSearchFilteredRows() {
  const q = filterInput.value.trim().toLowerCase();
  if (!q) return allRows;
  return allRows.filter(
    (r) =>
      (r.codigo || "").toLowerCase().includes(q) ||
      (r.nombre || "").toLowerCase().includes(q),
  );
}

function rowMatchesCompetFilter(row) {
  if (competitivenessFilter === "all") return true;
  const bucket = getCompetitiveness(row).bucket;
  if (competitivenessFilter === "encima") {
    return bucket === "sobre-media" || bucket === "caro";
  }
  return bucket === competitivenessFilter;
}

function getTableRows() {
  return getSearchFilteredRows().filter(rowMatchesCompetFilter);
}

function countCompetFilterRows(rows) {
  const counts = { all: rows.length, imbatible: 0, competitivo: 0, encima: 0, "sin-datos": 0 };
  for (const row of rows) {
    const bucket = getCompetitiveness(row).bucket;
    if (bucket === "sobre-media" || bucket === "caro") {
      counts.encima += 1;
    } else if (bucket in counts) {
      counts[bucket] += 1;
    }
  }
  return counts;
}

function renderCompetitivenessFilters() {
  const baseRows = getSearchFilteredRows();
  const counts = countCompetFilterRows(baseRows);

  competFiltersEl.innerHTML = COMPET_FILTER_OPTIONS.map((opt) => {
    const active = competitivenessFilter === opt.key ? " is-active" : "";
    const count = counts[opt.key] ?? 0;
    return `
      <button
        type="button"
        class="compet-filter${active}"
        data-filter="${opt.key}"
        title="${escapeHtml(opt.title)}"
        aria-pressed="${competitivenessFilter === opt.key}"
      >
        ${escapeHtml(opt.label)}
        <span class="compet-filter__count">${count}</span>
      </button>`;
  }).join("");

  competFiltersEl.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      competitivenessFilter = btn.dataset.filter;
      renderCompetitivenessFilters();
      renderTable(getTableRows());
    });
  });
}

function renderTable(rows) {
  const data = sortedRows(rows);
  if (!data.length) {
    const emptyMsg =
      competitivenessFilter === "all"
        ? "Sin productos para mostrar."
        : "Ningún producto en este grupo con los filtros actuales.";
    tableBody.innerHTML = `<tr><td colspan="7" class="empty">${emptyMsg}</td></tr>`;
    return;
  }

  tableBody.innerHTML = data
    .map((row) => {
      const comp = getCompetitiveness(row);
      const pct = comp.percentile != null ? `<div class="kpi__sub">${percentileText(comp)}</div>` : "";
      const zeroStock = row.inventario === 0;
      return `
      <tr class="row-clickable${zeroStock ? " row-zero-stock" : ""}" data-codigo="${escapeHtml(row.codigo || "")}" tabindex="0" role="button"
          aria-label="Ver detalle de ${escapeHtml(row.nombre || "")}">
        <td>
          <div class="product-name">${escapeHtml(row.nombre || "—")}</div>
          ${renderSearchTerms(row)}
        </td>
        <td>
          <span class="pill" data-bucket="${comp.bucket}">${BUCKETS[comp.bucket].label}</span>
          ${pct}
        </td>
        <td class="num col-inventario">${
          row.inventario == null ? "—" : row.inventario
        }</td>
        <td class="num">${formatMoney(row.precioCuballama)}</td>
        <td class="num">${formatPriceWithGap(row.precioMin, row.distanciaMin, row.sinPublicaciones)}</td>
        <td class="num">${formatPriceWithGap(row.precioMedio, row.distanciaMedio, row.sinPublicaciones)}</td>
        <td class="num col-pub">${row.cantidadPublicaciones ?? 0}</td>
      </tr>`;
    })
    .join("");

  tableBody.querySelectorAll("tr.row-clickable").forEach((tr) => {
    const open = () => showDetail(tr.dataset.codigo);
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-term-toggle]")) return;
      open();
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });

  bindTermToggles(
    tableBody,
    (input) => allRows.find((r) => r.codigo === input.dataset.codigo),
    () => refreshDashboard(),
  );
}

/* ------------------------------------------------------------------ Dashboard */
function renderKpis(summary) {
  const cards = [
    {
      label: "Productos analizados",
      value: summary.total,
      sub: `${summary.conDatos} con datos · ${summary.sinDatos} sin datos`,
      color: "var(--border-strong)",
    },
    {
      label: "Competitivos",
      value: summary.competitivos,
      sub:
        summary.tasaCompetitiva != null
          ? `${formatPercent(summary.tasaCompetitiva)} de los que tienen datos`
          : "—",
      color: "var(--ok)",
    },
    {
      label: "Por encima del mercado",
      value: summary.porEncima,
      sub: "más caros que la mediana o el máximo",
      color: "var(--bad)",
    },
    {
      label: "Posición típica",
      value: summary.medianPercentile != null ? formatPercent(summary.medianPercentile) : "—",
      sub: "más barato que ese % del mercado (mediana)",
      color: "var(--accent)",
    },
  ];

  kpiRow.innerHTML = cards
    .map(
      (c) => `
      <div class="kpi" style="--kpi-accent:${c.color}">
        <span class="kpi__label">${c.label}</span>
        <span class="kpi__value">${c.value}</span>
        <span class="kpi__sub">${c.sub}</span>
      </div>`,
    )
    .join("");
}

function refreshDashboard() {
  const summary = summarize(allRows);
  renderKpis(summary);
  renderBreakdown(chartBreakdown, summary);
  renderOpportunities(chartOpportunities, allRows);
  renderCompetitivenessFilters();
  renderTable(getTableRows());
}

/* ------------------------------------------------------- Publicaciones / subcategorías */
function renderPublicationRows(publicaciones) {
  return publicaciones
    .map(
      (p) => `
      <tr class="${p.esSemejante ? "row-semejante" : ""}">
        <td>${escapeHtml(p.nombre)}</td>
        <td class="num">${formatMoney(p.precio)}</td>
        <td>${
          p.link
            ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer">Abrir</a>`
            : "—"
        }</td>
      </tr>`,
    )
    .join("");
}

function renderAllPublicationsTable(row) {
  const publicaciones = [...(row.publicaciones || [])].sort((a, b) => a.precio - b.precio);
  const count = publicaciones.length;
  detailPublicationsTitle.textContent =
    count === 0 ? "Publicaciones encontradas" : `Publicaciones encontradas (${count})`;
  detailTableBody.innerHTML =
    count === 0
      ? `<tr><td colspan="3" class="empty">Sin publicaciones.</td></tr>`
      : renderPublicationRows(publicaciones);
}

function renderSubcategoryTable(subcategory, tableTitleEl, tableBodyEl) {
  if (!subcategory) {
    tableTitleEl.textContent = "Publicaciones de la subcategoría";
    tableBodyEl.innerHTML = `<tr><td colspan="3" class="empty">Selecciona una subcategoría.</td></tr>`;
    return;
  }
  tableTitleEl.textContent = `Publicaciones: ${subcategory.nombre}`;
  tableBodyEl.innerHTML = !subcategory.publicaciones.length
    ? `<tr><td colspan="3" class="empty">Sin publicaciones.</td></tr>`
    : renderPublicationRows(subcategory.publicaciones);
}

function renderSubcategories(row, refs) {
  const subcategories = getSubcategories(row);
  if (!subcategories.length) {
    refs.cards.innerHTML = `<div class="empty-subcategories">Sin subcategorías con publicaciones activas.</div>`;
    refs.setSelectedKey(null);
    renderSubcategoryTable(null, refs.tableTitle, refs.tableBody);
    return;
  }

  let selectedKey = refs.getSelectedKey();
  if (!subcategories.some((g) => g.key === selectedKey)) {
    selectedKey = subcategories[0].key;
    refs.setSelectedKey(selectedKey);
  }

  refs.cards.innerHTML = subcategories
    .map(
      (group) => `
      <button type="button" class="subcategory-card ${group.key === selectedKey ? "selected" : ""}"
        data-subcategory="${escapeHtml(group.key)}">
        <span class="subcategory-card-head">
          <strong>${escapeHtml(group.nombre)}</strong>
          <span>${formatMoney(group.precioMin)} – ${formatMoney(group.precioMax)}</span>
        </span>
        <span class="subcategory-card-foot">${group.publicaciones.length} publicación(es)</span>
      </button>`,
    )
    .join("");

  refs.cards.querySelectorAll("[data-subcategory]").forEach((card) => {
    card.addEventListener("click", () => {
      refs.setSelectedKey(card.dataset.subcategory);
      renderSubcategories(row, refs);
    });
  });

  renderSubcategoryTable(
    subcategories.find((g) => g.key === selectedKey) || subcategories[0],
    refs.tableTitle,
    refs.tableBody,
  );
}

function similarRefs() {
  return {
    cards: similarSubcategoryCards,
    tableTitle: similarSubcategoryTableTitle,
    tableBody: similarTableBody,
    getSelectedKey: () => selectedSimilarSubcategoryKey,
    setSelectedKey: (key) => {
      selectedSimilarSubcategoryKey = key;
    },
  };
}

/* ---------------------------------------------------------------- Navegación */
function setView(name) {
  dashboardSection.classList.toggle("hidden", name !== "dashboard");
  detailSection.classList.toggle("hidden", name !== "detail");
  similarSection.classList.toggle("hidden", name !== "similar");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showResults(rows, message, type = "ok") {
  allRows = prepareRows(rows);
  currentSimilarRow = null;
  filterInput.value = "";
  competitivenessFilter = "all";
  dashboardEmpty.classList.add("hidden");
  dashboardContent.classList.remove("hidden");
  updateSortIcons();
  refreshDashboard();
  setView("dashboard");
  setStatus(message, type);
}

function showDetail(codigo) {
  const row = allRows.find((r) => r.codigo === codigo);
  if (!row) return;
  currentDetailCodigo = codigo;
  renderDetail(row);
  setView("detail");
}

function renderDetail(row) {
  const comp = getCompetitiveness(row);
  detailTitle.textContent = row.nombre;
  const formula = row.marcadoRojo ? "producto rojo: × 1.4" : `÷ ${row.tipoCambio} × 1.4`;
  detailMeta.textContent = `${row.codigo || "—"} · Precio venta: ${formatMoney(
    row.precioVenta,
  )} · Cuballama: ${formatMoney(row.precioCuballama)} (${formula})`;

  detailVerdict.className = "pill";
  detailVerdict.setAttribute("data-bucket", comp.bucket);
  detailVerdict.textContent =
    BUCKETS[comp.bucket].label + (comp.percentile != null ? ` · ${percentileText(comp)}` : "");

  const sc = row.sinPublicaciones;
  detailStats.innerHTML = `
    <div class="stat-card"><span>Tu precio (Cuballama)</span><strong>${formatMoney(row.precioCuballama)}</strong></div>
    <div class="stat-card"><span>Mínimo mercado</span><strong>${sc ? "∞" : formatMoney(row.precioMin)}</strong></div>
    <div class="stat-card"><span>Mediana mercado</span><strong>${sc ? "∞" : formatMoney(row.precioMedio)}</strong></div>
    <div class="stat-card"><span>Máximo mercado</span><strong>${sc ? "∞" : formatMoney(row.precioMax)}</strong></div>
    <div class="stat-card"><span>Publicaciones</span><strong>${row.cantidadPublicaciones}</strong></div>
    <div class="stat-card"><span>Semejantes</span><strong>${row.cantidadSemejantes}</strong></div>`;

  renderComparison(chartComparison, row);
  renderHistogram(chartHistogram, row.publicaciones, row.precioCuballama);

  detailTerms.innerHTML = `
    <p><strong>Criterio:</strong> nombres generados por IA (${escapeHtml(
      row.fuenteNombresBusqueda || "fallback",
    )}) buscados en las publicaciones de Cuballama (sin combos ni accesorios).</p>
    <p><strong>Original:</strong> <code>${escapeHtml(row.nombre)}</code></p>
    ${renderSearchTerms(row)}
    ${renderMarketFilters(row)}`;

  bindTermToggles(
    detailTerms,
    () => row,
    () => {
      renderDetail(row);
      refreshDashboard();
    },
  );

  renderAllPublicationsTable(row);
}

/* -------------------------------------------------------- Productos similares */
function renderSimilarPanel(row) {
  const comp = getCompetitiveness(row);
  similarMeta.textContent = `Precio Cuballama: ${formatMoney(
    row.precioCuballama,
  )} · IA: ${row.fuenteNombresBusqueda || "fallback"} · ${row.cantidadPublicaciones} publicación(es)`;

  similarTermsBox.classList.remove("hidden");
  similarTerms.innerHTML = `
    <p><strong>Veredicto:</strong> <span class="pill" data-bucket="${comp.bucket}">${
      BUCKETS[comp.bucket].label
    }</span></p>
    <p><strong>Nombres de productos parecidos buscados:</strong></p>
    ${renderSearchTerms(row)}
    ${renderMarketFilters(row)}`;

  bindTermToggles(
    similarTerms,
    () => row,
    () => {
      selectedSimilarSubcategoryKey = null;
      renderSimilarPanel(row);
    },
  );

  renderSubcategories(row, similarRefs());
}

async function showSimilarProducts() {
  const row = allRows.find((r) => r.codigo === currentDetailCodigo);
  if (!row) return;

  setView("similar");
  selectedSimilarSubcategoryKey = null;
  similarTitle.textContent = `Productos similares a ${row.nombre}`;
  similarMeta.textContent = `Precio Cuballama: ${formatMoney(row.precioCuballama)} · Buscando por función, uso y rango`;
  similarTerms.innerHTML = "";
  similarTermsBox.classList.add("hidden");
  similarSubcategoryCards.innerHTML = "";
  renderSubcategoryTable(null, similarSubcategoryTableTitle, similarTableBody);
  setSimilarStatus("Consultando IA y buscando publicaciones similares…");
  similarBtn.disabled = true;

  try {
    const data = await fetchSimilarProducts({
      nombre: row.nombre,
      precioCuballama: row.precioCuballama,
    });
    const similarRow = recalcRowStats({
      codigo: `similar:${row.codigo || normalizeTerm(row.nombre)}`,
      nombre: row.nombre,
      precioCuballama: row.precioCuballama,
      fuenteNombresBusqueda: data.fuenteNombresBusqueda || "fallback",
      nombresBusqueda: data.nombresBusqueda || [],
      palabrasNegativas: data.palabrasNegativas || [],
      filtroPrecioMercado: data.filtroPrecioMercado || null,
      publicaciones: data.publicaciones || [],
    });
    currentSimilarRow = similarRow;
    renderSimilarPanel(currentSimilarRow);
    setSimilarStatus(`Listo: ${similarRow.nombresBusqueda.length} término(s) similares.`, "ok");
  } catch (err) {
    currentSimilarRow = null;
    similarTermsBox.classList.add("hidden");
    similarSubcategoryCards.innerHTML = "";
    renderSubcategoryTable(null, similarSubcategoryTableTitle, similarTableBody);
    setSimilarStatus(err.message, "error");
  } finally {
    similarBtn.disabled = false;
  }
}

/* ------------------------------------------------------------- Configuración */
function setSettingsOpen(open) {
  settingsPanel.classList.toggle("hidden", !open);
  settingsToggle.setAttribute("aria-expanded", String(open));
  saveSettingsOpen(open);
}

function updateCachedFileHint() {
  const meta = getCachedFileMeta();
  if (!meta?.fileName) {
    cachedFileHint.classList.add("hidden");
    return;
  }
  cachedFileHint.textContent = `Inventario guardado: ${meta.fileName}`;
  cachedFileHint.classList.remove("hidden");
}

/* -------------------------------------------------------- Búsqueda manual BD */
function setMarketSearchStatus(message, type = "") {
  marketSearchStatus.textContent = message;
  marketSearchStatus.className = `status ${type}`.trim();
}

function formatMarketListingPrice(item) {
  if (item.precio != null) return formatMoney(item.precio);
  if (item.precioTexto) return escapeHtml(String(item.precioTexto));
  return "—";
}

function renderMarketSearchResults(productos) {
  if (!productos.length) {
    marketSearchResultsWrap.classList.add("hidden");
    marketSearchTableBody.innerHTML = "";
    return;
  }

  marketSearchResultsWrap.classList.remove("hidden");
  marketSearchTableBody.innerHTML = productos
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.nombre)}</td>
        <td class="num">${formatMarketListingPrice(p)}</td>
        <td>${escapeHtml(p.tienda || "—")}</td>
        <td>${
          p.link
            ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer">Abrir</a>`
            : "—"
        }</td>
      </tr>`,
    )
    .join("");
}

async function runMarketSearch() {
  const query = marketSearchInput.value.trim();
  if (!query) {
    setMarketSearchStatus("Escribe al menos una palabra para buscar.", "error");
    marketSearchResultsWrap.classList.add("hidden");
    return;
  }

  marketSearchBtn.disabled = true;
  setMarketSearchStatus("Buscando…");

  try {
    const data = await fetchMarketSearch(query);
    renderMarketSearchResults(data.productos);
    const words = (data.tokens || []).join(", ");
    if (data.total === 0) {
      setMarketSearchStatus(`Sin resultados que contengan: ${words}.`, "error");
    } else {
      const capped = data.total >= 100 ? " (máx. 100)" : "";
      setMarketSearchStatus(`${data.total} resultado(s)${capped} · palabras: ${words}`, "ok");
    }
  } catch (err) {
    renderMarketSearchResults([]);
    setMarketSearchStatus(err.message, "error");
  } finally {
    marketSearchBtn.disabled = false;
  }
}

/* -------------------------------------------------------------------- Eventos */
settingsToggle.addEventListener("click", () =>
  setSettingsOpen(settingsPanel.classList.contains("hidden")),
);

emptyCta.addEventListener("click", () => {
  setSettingsOpen(true);
  fileInput.focus();
});

backBtn.addEventListener("click", () => setView("dashboard"));
similarBackBtn.addEventListener("click", () => showDetail(currentDetailCodigo));
similarBtn.addEventListener("click", showSimilarProducts);

filterInput.addEventListener("input", () => {
  renderCompetitivenessFilters();
  renderTable(getTableRows());
});

tipoCambioInput.addEventListener("change", () => saveTipoCambio(tipoCambioInput.value));

marketSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runMarketSearch();
});

document.querySelectorAll("#results-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir *= -1;
    } else {
      sortKey = key;
      sortDir = 1;
    }
    saveSortPreference(sortKey, sortDir);
    updateSortIcons();
    renderTable(getTableRows());
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0] || (await loadCachedFile());
  const tipoCambio = tipoCambioInput.value.trim();

  if (!file) {
    setStatus("Selecciona un archivo Excel o usa el inventario guardado.", "error");
    return;
  }
  if (!tipoCambio) {
    setStatus("Indica el tipo de cambio a USD.", "error");
    return;
  }

  analyzeBtn.disabled = true;
  setStatus("Enviando inventario al servidor…");

  try {
    const data = await analyzeWithFile(file, tipoCambio, (message) => setStatus(message));
    await saveSession({ file, tipoCambio, rows: data.rows, uploadedFile: data.uploadedFile });
    updateCachedFileHint();
    showResults(data.rows, `Listo: ${data.total} producto(s) desde «${data.uploadedFile}».`, "ok");
    setSettingsOpen(false);
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    analyzeBtn.disabled = false;
  }
});

/* ----------------------------------------------------------------- Arranque */
async function loadMarketInfo() {
  try {
    const data = await fetchHealth();
    marketBadge.textContent = `${data.productos.toLocaleString("es")} productos · ${data.tiendas.toLocaleString(
      "es",
    )} tiendas`;
  } catch {
    marketBadge.textContent = "BD no disponible";
  }
}

async function restoreSession() {
  const session = await loadSession();
  if (!session) return;
  updateCachedFileHint();
  if (session.tipoCambio) {
    tipoCambioInput.value = String(session.tipoCambio);
    saveTipoCambio(session.tipoCambio);
  }
  if (Array.isArray(session.rows) && session.rows.length) {
    showResults(
      session.rows,
      `Resultados restaurados: ${session.rows.length} producto(s) desde «${
        session.uploadedFile || session.fileName
      }».`,
      "ok",
    );
    setSettingsOpen(false);
  }
}

function init() {
  const pref = loadSortPreference();
  if (pref) {
    sortKey = pref.key;
    sortDir = pref.dir;
  }
  tipoCambioInput.value = loadTipoCambio();
  setSettingsOpen(loadSettingsOpen());
  loadMarketInfo();
  restoreSession();
}

init();
