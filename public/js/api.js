// Llamadas al backend.

export async function fetchHealth() {
  const res = await fetch("/api/health");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Mercado no disponible.");
  return data;
}

export async function analyzeWithFile(file, tipoCambio, onProgress) {
  const body = new FormData();
  body.append("file", file);
  body.append("tipoCambio", tipoCambio);

  const res = await fetch("/api/analyze?stream=1", {
    method: "POST",
    body,
    headers: { Accept: "application/x-ndjson" },
  });

  if (!res.ok && !res.body) {
    let message = "Error al analizar el catálogo.";
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let streamError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = JSON.parse(trimmed);
      if (evt.type === "progress" && evt.message) {
        onProgress?.(evt.message);
      } else if (evt.type === "complete") {
        result = evt;
      } else if (evt.type === "error") {
        streamError = evt.error || "Error al analizar el catálogo.";
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const evt = JSON.parse(tail);
    if (evt.type === "progress" && evt.message) onProgress?.(evt.message);
    if (evt.type === "complete") result = evt;
    if (evt.type === "error") streamError = evt.error;
  }

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error("El servidor cerró el análisis sin devolver resultados.");
  if (!res.ok) throw new Error("Error al analizar el catálogo.");
  return result;
}

export async function fetchMarketSearch(query) {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`/api/market-search?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al buscar en el mercado.");
  return data;
}

export async function fetchSimilarProducts({ nombre, precioCuballama }) {
  const res = await fetch("/api/similar-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre, precioCuballama }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al buscar productos similares.");
  return data;
}

export async function fetchSuggestedTag({ nombre, precioCuballama, existingTags }) {
  const res = await fetch("/api/suggest-tag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre, precioCuballama, existingTags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al sugerir etiqueta.");
  return data;
}

export async function reanalyzeProduct(item) {
  const res = await fetch("/api/reanalyze-product", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al reanalizar el producto.");
  return data.row;
}
