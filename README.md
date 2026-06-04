# Cuballama — Mercado

Monorepo con dos partes:

| Carpeta | Tecnología | Descripción |
|---------|------------|-------------|
| `scraper/` | Python + Playwright | Extrae tiendas y productos de Cuballama hacia la BD |
| *(raíz)* | Node.js + Express | Web para analizar precios de tu catálogo vs. el mercado |

La base de datos compartida es **`cuballama_market.db`** en la raíz del repositorio.

## Analizador web (Node)

### Requisitos

- Node.js 18+
- `cuballama_market.db` en la raíz (generada por el scraper)

### Instalación y ejecución

Si un `npm install` anterior falló (p. ej. con `better-sqlite3`), borra primero `node_modules` y `package-lock.json`.

```bash
npm install
npm start
```

La BD se lee con **sql.js** (JavaScript puro, sin compilar módulos nativos ni Visual Studio).

Abre [http://localhost:3000](http://localhost:3000).

### Excel de entrada

Compatible con el formato **Inventrio** (`CODIGO`, `MERCANCIA`, `P.Venta`, `CANTIDAD` en una fila de encabezados, aunque haya filas previas de título) y con columnas genéricas (`código`, `nombre`, `precio de venta`, `cantidad` / `stock` / `inventario`).

**Precio en Cuballama (USD):** `(P.Venta ÷ tipo de cambio USD) × 1.4`

### Criterio de búsqueda en el mercado

Para cada producto del Excel se buscan publicaciones en Cuballama cuyo **nombre contiene el nombre del producto del catálogo** (sin distinguir mayúsculas ni acentos). Se excluyen anuncios con «combo» en el título.

Las **publicaciones semejantes** son las que además superan un umbral de similitud por coincidencia de palabras.

Las distancias en USD se comparan con tu precio Cuballama (verde = mercado más caro, rojo = más barato).

### Scraper

Ver documentación en [`scraper/README.md`](scraper/README.md).

En Windows: doble clic en `scraper/Iniciar_Scraper.bat`.
