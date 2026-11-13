# Inscryption Wiki MCP

Servidor MCP **de solo lectura** para consultar y exportar el contenido público de
[Inscryption Wiki (Fandom)](https://inscryption.fandom.com/wiki/Inscryption_Wiki).
Usa el **SDK oficial MCP v2**, la **MediaWiki Action API** (`api.php`) y Node.js 22+.
No requiere claves de API ni navegador automatizado.

> **Importante:** Fandom aplica protecciones y puede rechazar ciertas solicitudes con
> HTTP 403. El proyecto respeta esos bloqueos; no intenta eludir restricciones.
> La conexión real con esta wiki depende de que Fandom permita el acceso a su API.

## Instalación

Necesitás **Node.js 22+** y **pnpm 10+**:

```bash
pnpm install
cp .env.example .env
pnpm test
pnpm start
```

En Windows (CMD), reemplazá `cp` por `copy .env.example .env`.

`pnpm start` **no imprime nada útil en una terminal normal**: un servidor MCP
utiliza `stdin` y `stdout` para el protocolo. Conectalo a tu cliente MCP.
Los errores y registros internos se envían a `stderr`.

El archivo `.env` se carga automáticamente desde la raíz del proyecto,
aunque el cliente MCP ejecute el comando desde otro directorio.

## Configuración MCP en Claude Code / clientes compatibles

En el `.mcp.json` de tu proyecto, añadí lo siguiente y **cambiá la ruta** por
la ubicación real donde descomprimiste este proyecto:

```json
{
  "mcpServers": {
    "inscryption-wiki": {
      "command": "node",
      "args": ["C:/Users/User/Desktop/inscryption-wiki-mcp/src/index.js"],
      "env": {
        "WIKI_BASE_URL": "https://inscryption.fandom.com",
        "WIKI_EXPORT_DIR": "C:/Users/User/Desktop/inscryption-wiki-mcp/data/inscryption-wiki"
      }
    }
  }
}
```

Para otras rutas, usá el mismo esquema con la ruta absoluta a `src/index.js`.
El archivo `examples/.mcp.json` contiene una plantilla editable.

Comprobación opcional con MCP Inspector:

```bash
pnpm dlx @modelcontextprotocol/inspector node src/index.js
```

## Herramientas MCP

| Herramienta | Función |
| --- | --- |
| `wiki_info` | Estadísticas, namespaces, propiedades y datos de licencia del sitio |
| `search_pages` | Búsqueda de texto completo con paginación |
| `list_pages` | Todas las páginas por namespace, incluidas plantillas y módulos |
| `get_page` | Página completa: wikitext, metadatos y relaciones, HTML opcional |
| `parse_page` | HTML renderizado y secciones del artículo |
| `list_categories` | Inventario de categorías |
| `category_members` | Miembros de una categoría, incluidas subcategorías |
| `list_files` | Inventario de imágenes/archivos con URL y metadatos |
| `get_file` | Metadatos ampliados y atribución cuando está publicada |
| `backlinks` | Páginas que enlazan a otra página |
| `list_revisions` | Historial paginado de una página, contenido opcional |
| `get_revision` | Contenido histórico público por ID de revisión |
| `export_batch` | Exportación masiva reanudable; ejecutar hasta `complete=true` |
| `export_status` | Estado local de la exportación |
| `download_media_batch` | Descarga lotes de archivos binarios públicos tras exportar |
| `media_status` | Estado de descarga de archivos |

**Recursos MCP:** `wiki://inscryption/siteinfo` y
`wiki://inscryption/page/{title}`.

La mayoría de las herramientas de inventario aceptan `limit` y `cursor`.
Pasá `nextCursor` de la respuesta anterior como `cursor` de la siguiente
consulta para recorrer todo el resultado. Los tokens son opacos.

Ejemplos de pedidos a tu agente MCP:

- "Buscá páginas relacionadas con las cartas y listá los resultados".
- "Extraé el wikitext de `Stoat`, incluyendo categorías, plantillas e imágenes".
- "Listá todas las páginas del namespace 10 (plantillas)".
- "Ejecutá `export_batch` y continuá con nuevos lotes hasta que esté completo".

## Exportar toda la wiki (CLI)

Por defecto se exportan **todos los namespaces públicos con ID no negativo**
(artículos, archivos, plantillas, categorías, módulos, etc.), con contenido
wikitext, metadatos y relaciones. Además, se guardan inventarios independientes
de archivos y categorías.

```bash
pnpm export:wiki
```

Para incluir también **HTML renderizado y todas las revisiones públicas**
(puede multiplicar considerablemente las solicitudes y el tamaño del resultado):

```bash
pnpm export:wiki --html --history
```

Opciones de la CLI:

| Opción | Descripción |
| --- | --- |
| `--html` | Incluye el HTML renderizado de cada página |
| `--history` | Incluye el contenido de todas las revisiones públicas |
| `--no-relations` | Omite categorías, links, plantillas e imágenes de las páginas |
| `--no-files` | Omite el inventario adicional de archivos |
| `--no-categories` | Omite el inventario adicional de categorías |
| `--main-only` | Exporta únicamente namespace 0 (artículos) |

Para un backup completo, **no uses `--main-only`**. El historial de ediciones
no se incluye por defecto por motivos de tiempo y volumen.

Al reiniciar `pnpm export:wiki` con **las mismas opciones**, retoma el trabajo
desde el archivo `checkpoint.json`. Si querés una nueva exportación con otros
parámetros, configurá otro `WIKI_EXPORT_DIR` o mové la carpeta anterior.

### Descargar imágenes y otros archivos binarios (opcional)

Una vez completada `pnpm export:wiki`:

```bash
pnpm download:media
```

Se guardan los archivos bajo `data/inscryption-wiki/media/`, con nombres
SHA-256 de los títulos originales y extensiones conservadas. El subdirectorio
`media/index/` guarda la correspondencia entre nombre local, nombre original y
URL de origen. Las URL y nombres originales también permanecen en `files.jsonl`. Para evitar descargas
incontroladas, cada archivo tiene un límite de **20 MiB** y solo se admiten
CDN HTTPS conocidos de Fandom; las redirecciones se validan. Si algún archivo
falla, corregí el problema y ejecutá el comando de nuevo para reanudar.
No se descargan medios por defecto.

## Archivos generados

```text
data/inscryption-wiki/
├── siteinfo.json           # Datos generales y licencia del sitio
├── checkpoint.json         # Avance y estado para reanudar
├── pages/                  # Un JSON por página
├── pages.jsonl             # Todas las páginas (una por línea)
├── files/                  # Metadatos individuales de archivos
├── files.jsonl             # Inventario de archivos
├── categories/             # Metadatos individuales de categorías
├── categories.jsonl        # Inventario de categorías
├── history/                # Revisiones (si se usa --history)
├── manifest.json           # Resumen y recuentos finales
└── media/                  # Descargas binarias opcionales
    ├── checkpoint.json
    └── index/               # Correspondencia de nombres y URLs
```

Los archivos JSONL consolidados y `manifest.json` se generan cuando termina
la exportación. Los archivos individuales y `checkpoint.json` aparecen antes.

## Variables de entorno

| Variable | Predeterminado | Función |
| --- | --- | --- |
| `WIKI_BASE_URL` | `https://inscryption.fandom.com` | Dominio fuente |
| `WIKI_API_URL` | `https://inscryption.fandom.com/api.php` | API de acciones |
| `WIKI_USER_AGENT` | `InscryptionWikiMCP/1.0 (...)` | Identificador del cliente; se recomienda contacto |
| `WIKI_MIN_DELAY_MS` | `1000` | Pausa mínima entre solicitudes API |
| `WIKI_REQUEST_TIMEOUT_MS` | `20000` | Timeout de solicitudes |
| `WIKI_MAX_RETRIES` | `3` | Reintentos con backoff, incl. HTTP 429 |
| `WIKI_EXPORT_DIR` | `./data/inscryption-wiki` | Carpeta de exportación |

Para ejecutar con clientes MCP en diferentes directorios, conviene definir
`WIKI_EXPORT_DIR` como ruta **absoluta**.

## Desarrollo y pruebas

```bash
pnpm check
pnpm test
pnpm dev
```

La suite usa respuestas HTTP simuladas y directorios temporales: no consulta
la wiki real ni consume su cuota. La API de Fandom se debe comprobar por
separado en una computadora que tenga acceso a Internet.

## Límites y uso responsable

- Se extrae lo **público y accesible** por la API: no páginas eliminadas,
  historiales privados, información interna ni contenidos que la API o Fandom
  bloqueen. No es una copia de la base de datos interna de Fandom.
- Los binarios se descargan solo cuando se solicita expresamente.
- `--history` incluye las revisiones a las que la API concede acceso, pero
  nunca las revisiones borradas/restringidas.
- `--html` puede ser muy costoso si la wiki es grande; probá primero sin él.
- No se pretende eludir robots, Cloudflare, accesos privados o límites 403/429.
- **Licencia:** el software de este repositorio es MIT. El texto y los archivos
  de la wiki conservan **sus propias licencias**. Atribuí el contenido y
  comprobá las condiciones de cada archivo antes de redistribuirlo;
  las imágenes de Fandom no tienen necesariamente la misma licencia que el texto.

Referencias de implementación:
[SDK oficial MCP](https://ts.sdk.modelcontextprotocol.io/v2/),
[API de MediaWiki](https://www.mediawiki.org/wiki/API:Main_page),
[guía de copyright de Fandom](https://community.fandom.com/wiki/Copyright).
