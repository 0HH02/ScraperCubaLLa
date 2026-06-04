// Capa de persistencia: localStorage, sessionStorage e IndexedDB.

const STORAGE_TIPO_CAMBIO = "cuballama.tipoCambio";
const STORAGE_SORT = "cuballama.sort";
const STORAGE_TERM_FILTERS = "cuballama.termFilters";
const STORAGE_SETTINGS_OPEN = "cuballama.settingsOpen";
const IDB_NAME = "cuballama-cache";
const IDB_STORE = "session";
const IDB_KEY = "last";

let termFilters = loadTermFilters();
let cachedFileMeta = null;

function loadTermFilters() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_TERM_FILTERS) || "{}");
  } catch {
    return {};
  }
}

export function getDisabledTerms(codigo) {
  if (!codigo) return new Set();
  return new Set(termFilters[codigo] || []);
}

export function setTermDisabled(codigo, termValue, disabled) {
  if (!codigo) return;
  const current = getDisabledTerms(codigo);
  if (disabled) {
    current.add(termValue);
  } else {
    current.delete(termValue);
  }
  const values = [...current];
  if (values.length) {
    termFilters[codigo] = values;
  } else {
    delete termFilters[codigo];
  }
  localStorage.setItem(STORAGE_TERM_FILTERS, JSON.stringify(termFilters));
}

export function loadSortPreference() {
  try {
    const raw = sessionStorage.getItem(STORAGE_SORT);
    if (!raw) return null;
    const { key, dir } = JSON.parse(raw);
    return key ? { key, dir: dir === -1 ? -1 : 1 } : null;
  } catch {
    return null;
  }
}

export function saveSortPreference(key, dir) {
  if (!key) {
    sessionStorage.removeItem(STORAGE_SORT);
    return;
  }
  sessionStorage.setItem(STORAGE_SORT, JSON.stringify({ key, dir }));
}

export function saveTipoCambio(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed) localStorage.setItem(STORAGE_TIPO_CAMBIO, trimmed);
}

export function loadTipoCambio() {
  return localStorage.getItem(STORAGE_TIPO_CAMBIO) || "";
}

export function saveSettingsOpen(open) {
  localStorage.setItem(STORAGE_SETTINGS_OPEN, open ? "1" : "0");
}

export function loadSettingsOpen() {
  return localStorage.getItem(STORAGE_SETTINGS_OPEN) !== "0";
}

export function getCachedFileMeta() {
  return cachedFileMeta;
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  });
}

export async function saveSession({ file, tipoCambio, rows, uploadedFile }) {
  saveTipoCambio(tipoCambio);
  const buffer = await file.arrayBuffer();
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      cachedFileMeta = { fileName: file.name, fileType: file.type, buffer };
      resolve();
    };
    tx.objectStore(IDB_STORE).put(
      {
        fileName: file.name,
        fileType: file.type,
        buffer,
        uploadedFile,
        rows,
        tipoCambio,
        savedAt: Date.now(),
      },
      IDB_KEY,
    );
  });
}

export async function loadCachedFile() {
  if (!cachedFileMeta?.buffer) return null;
  const type =
    cachedFileMeta.fileType ||
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new File([cachedFileMeta.buffer], cachedFileMeta.fileName, { type });
}

export async function loadSession() {
  try {
    const db = await openCacheDb();
    const session = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result ?? null);
    });

    if (!session?.buffer) return null;
    cachedFileMeta = {
      fileName: session.fileName,
      fileType: session.fileType,
      buffer: session.buffer,
    };
    return session;
  } catch {
    return null;
  }
}
