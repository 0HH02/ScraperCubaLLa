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

Si el scraper reescribe `cuballama_market.db` mientras el servidor está en marcha, la web recoge los datos nuevos sola: **no hace falta reiniciar Node**.

### Configuración (`.env`)

Copia `.env.example` a `.env` y ajusta lo que necesites:

| Variable | Para qué sirve |
|----------|----------------|
| `GEMINI_API_KEY` | Genera los términos de búsqueda con IA. Sin ella la app funciona con términos automáticos. |
| `GEMINI_MODEL` | Modelo a usar (por defecto `gemini-2.0-flash`). |
| `GEMINI_TIMEOUT_MS` | Tiempo máximo por llamada (por defecto 20000). |
| `GEMINI_MAX_RETRIES` | Reintentos ante 429 o errores 5xx (por defecto 2). |
| `PORT` | Puerto del servidor (por defecto 3000). |
| `HOST` | Interfaz de escucha. Por defecto `127.0.0.1`: la app **no tiene contraseña**, así que solo se abre en tu equipo. Cámbialo únicamente si necesitas verla desde otro dispositivo. |

Nunca subas tu `.env` al repositorio: ya está en `.gitignore`.

### Cuando Gemini no responde

Ante un límite de cuota (429), un corte de red o una clave inválida, la app **no se cae**: reintenta con espera creciente y, si aun así falla, genera términos de búsqueda automáticos. El motivo concreto se muestra junto a la etiqueta sugerida, para que sepas que esa sugerencia no vino de la IA. Los fallos temporales no se guardan en caché, así que el siguiente intento vuelve a probar con Gemini.

### Pruebas

```bash
npm test
```

### Excel de entrada

Compatible con el formato **Inventrio** (`CODIGO`, `MERCANCIA`, `P.Venta`, `CANTIDAD` en una fila de encabezados, aunque haya filas previas de título) y con columnas genéricas (`código`, `nombre`, `precio de venta`, `cantidad` / `stock` / `inventario`).

**Precio en Cuballama (USD):** `(P.Venta ÷ tipo de cambio USD) × 1.4`

### Criterio de búsqueda en el mercado

Para cada producto del Excel se buscan publicaciones en Cuballama cuyo **nombre contiene el nombre del producto del catálogo** (sin distinguir mayúsculas ni acentos). Se excluyen anuncios con «combo» en el título, los accesorios y repuestos, y los anuncios que el scraper ya marcó como retirados.

Las **publicaciones semejantes** son las que además superan un umbral de similitud por coincidencia de palabras. **El mínimo y la mediana se calculan solo con ellas** cuando existen, para que una coincidencia floja y barata no hunda la comparación; si no hay ninguna semejante se usan todas las encontradas. El campo `baseEstadisticas` de la respuesta indica cuál de los dos casos se aplicó.

Puedes añadir etiquetas de búsqueda a mano o pedir una sugerencia a la IA desde el panel de detalle; la comparativa se recalcula al instante.

Las distancias en USD se comparan con tu precio Cuballama (verde = mercado más caro, rojo = más barato).

### Monedas

Los anuncios se comparan **en USD**. El importe y la moneda se leen por separado, respetando separadores de millares (`$1,299.00` y `1.299,00` valen 1299). Los precios en CUP se convierten con el tipo de cambio que indicas al analizar; el MLC se toma a la par del dólar. Un anuncio en una moneda que no se puede convertir queda **fuera** de la comparación en lugar de contarse como si fueran dólares.

### Scraper

Ver documentación en [`scraper/README.md`](scraper/README.md).

En Windows: doble clic en `scraper/Iniciar_Scraper.bat`.
