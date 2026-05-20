# ScraperCubaLLa

Scraper del mercado de [Cuballama](https://www.cuballama.com/mercado/inicio) con Playwright y SQLite. Extrae tiendas de la sección «Todos los negocios» y los productos de cada tienda.

## Requisitos

- Python 3.11+
- [Playwright](https://playwright.dev/python/) (Chromium)

```bash
pip install -r requirements.txt
playwright install chromium
```

## Estructura del proyecto

| Archivo | Descripción |
|---------|-------------|
| `run_scraper.py` | Punto de entrada: scraping completo o por fases |
| `cuballama_scraper.py` | Lógica de navegación y extracción con Playwright |
| `db.py` | Esquema SQLite y operaciones de persistencia |
| `settings.py` | URLs, timeouts y rutas por defecto |
| `discover_stores.py` | Herramienta de exploración (navegador visible) para listar tiendas |
| `import_stores.py` | Importa tiendas desde `discovered_stores.json` a la BD |
| `run_pipeline.py` | Pipeline automático completo (dependencias → scrape → GitHub) |
| `Iniciar_Scraper.bat` | Lanzador para doble clic en Windows |

La base de datos local por defecto es `cuballama_market.db` y se versiona en Git cuando usas el pipeline automático.

## Ejecución rápida (doble clic)

En Windows, haz **doble clic** en `Iniciar_Scraper.bat`. El pipeline hará lo siguiente, mostrando el progreso en la terminal:

1. **Dependencias** — Comprueba Python 3.11+, instala `requirements.txt` y Chromium de Playwright si faltan.
2. **Base de datos** — Crea `cuballama_market.db` si no existe; si ya existe, muestra resumen (tiendas, productos, pendientes).
3. **Tiendas** — Ejecuta el scraper de tiendas con navegador visible (`--solo-tiendas --headed`).
4. **Productos** — Ejecuta el scraper de productos con navegador visible (`--solo-productos --headed`).
5. **GitHub** — Hace commit y `git push` de todos los cambios, **incluida la base de datos**.

Requisitos adicionales para el paso 5: tener [Git](https://git-scm.com/) instalado y acceso configurado al remoto (`git push` sin pedir credenciales, o un gestor de credenciales ya configurado).

```bash
# Equivalente manual desde la terminal
python run_pipeline.py
```

## Uso manual por fases

Scraping completo (tiendas + productos pendientes):

```bash
python run_scraper.py
```

Solo tiendas:

```bash
python run_scraper.py --solo-tiendas
```

Solo productos de tiendas ya en la BD:

```bash
python run_scraper.py --solo-productos
```

Depuración con navegador visible:

```bash
python run_scraper.py --headed -v
```

Descubrir tiendas manualmente (genera `discovered_stores.json`):

```bash
python discover_stores.py
```

Importar ese JSON a la base de datos:

```bash
python import_stores.py --json discovered_stores.json
```

## Licencia

Uso personal / educativo. Respeta los términos del sitio web objetivo.
