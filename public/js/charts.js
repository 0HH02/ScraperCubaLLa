// Gráficas con ApexCharts (cargada por CDN como global window.ApexCharts).
import { formatMoney } from "./utils.js";
import { BUCKETS, BUCKET_ORDER, getCompetitiveness } from "./model.js";

const SERIES = {
  yo: "#388bfd",
  min: "#3fb950",
  mediana: "#d29922",
  max: "#f85149",
  neutral: "#6e7d90",
};

const instances = new Map();

export function chartsReady() {
  return typeof window !== "undefined" && typeof window.ApexCharts !== "undefined";
}

function destroy(el) {
  const prev = instances.get(el.id);
  if (prev) {
    prev.destroy();
    instances.delete(el.id);
  }
}

function showFallback(el, message) {
  el.innerHTML = `<p class="chart-fallback">${message}</p>`;
}

function baseOptions() {
  return {
    chart: {
      background: "transparent",
      foreColor: "#9fb0c3",
      fontFamily: "inherit",
      toolbar: { show: false },
      animations: { speed: 320 },
    },
    theme: { mode: "dark" },
    grid: { borderColor: "rgba(154,168,188,0.16)", strokeDashArray: 4 },
    dataLabels: { enabled: false },
    tooltip: { theme: "dark" },
    legend: { labels: { colors: "#9fb0c3" } },
    noData: { text: "Sin datos para graficar", style: { color: "#9fb0c3" } },
  };
}

function mount(el, options) {
  if (!chartsReady()) {
    showFallback(el, "Las gráficas necesitan conexión para cargar la librería.");
    return null;
  }
  destroy(el);
  el.innerHTML = "";
  const chart = new window.ApexCharts(el, options);
  chart.render();
  instances.set(el.id, chart);
  return chart;
}

export function renderBreakdown(el, summary) {
  const keys = BUCKET_ORDER.filter((key) => summary.counts[key] > 0);
  if (!keys.length) {
    showFallback(el, "Analiza un catálogo para ver la distribución.");
    return;
  }

  mount(el, {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "donut", height: 280 },
    series: keys.map((key) => summary.counts[key]),
    labels: keys.map((key) => BUCKETS[key].label),
    colors: keys.map((key) => BUCKETS[key].color),
    stroke: { width: 0 },
    legend: { position: "bottom", labels: { colors: "#9fb0c3" } },
    plotOptions: {
      pie: {
        donut: {
          size: "68%",
          labels: {
            show: true,
            total: {
              show: true,
              label: "Productos",
              color: "#9fb0c3",
              formatter: () => String(summary.total),
            },
          },
        },
      },
    },
    tooltip: {
      theme: "dark",
      y: { formatter: (val) => `${val} producto(s)` },
    },
  });
}

export function renderOpportunities(el, rows, limit = 12) {
  const items = rows
    .map((row) => ({ row, comp: getCompetitiveness(row) }))
    .filter(({ comp }) => comp.gapMedian != null)
    .sort((a, b) => Math.abs(b.comp.gapMedian) - Math.abs(a.comp.gapMedian))
    .slice(0, limit)
    .reverse();

  if (!items.length) {
    showFallback(el, "Sin brechas calculables todavía.");
    return;
  }

  mount(el, {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "bar", height: Math.max(220, items.length * 34) },
    series: [{ name: "Brecha vs mediana", data: items.map(({ comp }) => comp.gapMedian) }],
    plotOptions: {
      bar: {
        horizontal: true,
        borderRadius: 4,
        barHeight: "62%",
        colors: {
          ranges: [
            { from: -1e9, to: -0.0001, color: SERIES.min },
            { from: 0, to: 1e9, color: SERIES.max },
          ],
        },
      },
    },
    xaxis: {
      title: { text: "USD vs mediana (− más barato · + más caro)", style: { color: "#9fb0c3" } },
      labels: { formatter: (val) => `$${Number(val).toFixed(0)}` },
    },
    yaxis: {
      labels: {
        formatter: (val) => {
          const s = String(val ?? "");
          return s.length > 26 ? `${s.slice(0, 25)}…` : s;
        },
      },
    },
    tooltip: {
      theme: "dark",
      y: { formatter: (val) => `${val >= 0 ? "+" : "−"}$${Math.abs(val).toFixed(2)}` },
    },
    labels: items.map(({ row }) => row.nombre),
  });
}

export function renderComparison(el, row) {
  if (row.sinPublicaciones) {
    showFallback(el, "Sin publicaciones comparables para este producto.");
    return;
  }

  const data = [
    { x: "Tu precio", y: row.precioCuballama, fill: SERIES.yo },
    { x: "Mínimo", y: row.precioMin, fill: SERIES.min },
    { x: "Mediana", y: row.precioMedio, fill: SERIES.mediana },
    { x: "Máximo", y: row.precioMax, fill: SERIES.max },
  ].filter((d) => d.y != null);

  mount(el, {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "bar", height: 260 },
    series: [{ name: "USD", data: data.map((d) => ({ x: d.x, y: d.y, fillColor: d.fill })) }],
    plotOptions: { bar: { borderRadius: 6, columnWidth: "52%", distributed: true } },
    colors: data.map((d) => d.fill),
    legend: { show: false },
    dataLabels: {
      enabled: true,
      formatter: (val) => formatMoney(val),
      style: { colors: ["#f0f4f9"], fontWeight: 600 },
      offsetY: -18,
    },
    xaxis: { labels: { style: { colors: "#9fb0c3" } } },
    yaxis: { labels: { formatter: (val) => `$${Number(val).toFixed(0)}` } },
    annotations: {
      yaxis:
        row.precioCuballama != null
          ? [
              {
                y: row.precioCuballama,
                borderColor: SERIES.yo,
                strokeDashArray: 5,
                label: {
                  text: `Tu precio ${formatMoney(row.precioCuballama)}`,
                  style: { background: SERIES.yo, color: "#0d1117" },
                },
              },
            ]
          : [],
    },
    tooltip: { theme: "dark", y: { formatter: (val) => formatMoney(val) } },
  });
}

export function renderHistogram(el, publicaciones, myPrice, binCount = 10) {
  const prices = (publicaciones || []).map((p) => p.precio).filter((n) => Number.isFinite(n));
  if (!prices.length) {
    showFallback(el, "Sin publicaciones para la distribución.");
    return;
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const step = span / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * step,
    to: min + (i + 1) * step,
    count: 0,
  }));

  for (const price of prices) {
    const idx = Math.min(binCount - 1, Math.floor((price - min) / step));
    bins[idx].count += 1;
  }
  const myBin =
    myPrice == null ? -1 : Math.min(binCount - 1, Math.max(0, Math.floor((myPrice - min) / step)));

  mount(el, {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "bar", height: 240 },
    series: [{ name: "Publicaciones", data: bins.map((b) => b.count) }],
    plotOptions: {
      bar: {
        borderRadius: 3,
        columnWidth: "92%",
        distributed: true,
      },
    },
    legend: { show: false },
    colors: bins.map((_, i) => (i === myBin ? SERIES.yo : SERIES.neutral)),
    xaxis: {
      categories: bins.map((b) => `$${b.from.toFixed(0)}`),
      tickAmount: Math.min(binCount, 6),
      labels: { rotate: 0, style: { colors: "#9fb0c3" } },
    },
    yaxis: { labels: { formatter: (val) => String(Math.round(val)) } },
    tooltip: {
      theme: "dark",
      custom: ({ dataPointIndex }) => {
        const b = bins[dataPointIndex];
        const here = dataPointIndex === myBin ? "<br/><strong>Aquí cae tu precio</strong>" : "";
        return `<div class="apex-tip">$${b.from.toFixed(0)} – $${b.to.toFixed(0)}<br/>${b.count} publicación(es)${here}</div>`;
      },
    },
  });
}

export function destroyAll() {
  for (const chart of instances.values()) chart.destroy();
  instances.clear();
}
