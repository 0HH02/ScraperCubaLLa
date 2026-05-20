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

La base de datos local por defecto es `cuballama_market.db` (no se versiona).

## Uso

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
