# Scraper de Cartas/Mensajes del Padre

Objetivo: detectar automáticamente cartas y mensajes nuevos del Prelado en opusdei.org
sin depender de que alguien edite a mano `CartasPadreManifest.kt` y publique una nueva
versión de la app.

`curl` y otros clientes HTTP simples reciben 403 "Just a moment..." de Cloudflare en
listado, artículos, feed y sitemap, en todos los idiomas (ver comentario en
`CartasPadreManifest.kt`). Un navegador real (Playwright/Chromium) sí pasa ese challenge.

(Se probó antes con un workflow desechable que un runner de GitHub Actions sí pasa el
challenge de Cloudflare igual que una máquina normal — confirmado, por eso existe lo
de abajo en vez de quedarse en la limitación original de `CartasPadreManifest.kt`.)

`scrape.mjs` es el scraper real, programado diario vía `cartas-padre-scraper.yml`:

- Visita la página "hub" de cartas pastorales/mensajes en cada idioma soportado (la URL
  de cada hub se descubrió a mano una vez — buscando en Google/el nav lateral del sitio —
  y vive hardcodeada en `LANGS` dentro de `scrape.mjs`; si Opus Dei reestructura esas URLs
  habrá que repetir esa búsqueda).
- Clasifica cada link como "carta" (larga, con PDF/EPUB) o "mensaje" (corto, solo texto)
  por palabras clave en el slug.
- Agrupa por (tipo, fecha) — la fecha se extrae del título del artículo, no del slug — para
  correlacionar la misma carta/mensaje entre idiomas sin depender de que la URL siga un
  patrón común entre ellos (no lo hace: cada idioma tiene su propio slug).
- Usa como `clave` la URL en español si existe (mismo esquema que ya usaba
  `CartasPadreManifest.kt` a mano), para que los ítems históricos no se vuelvan a
  descargar al fusionar con el manifiesto estático compilado en la app.
- Publica `cartas_padre_manifest.json` en la raíz de este repo (faro-tutoriales, público), commiteado a `main`
  por el propio workflow — la app lo lee vía `raw.githubusercontent.com` (no bloqueado
  por Cloudflare, a diferencia de opusdei.org) en `CartasPadreManifestRemoto.kt`.

Limitaciones conocidas: cobertura de polaco parcial (opusdei.org no tiene un hub tan
completo en ese idioma como en el resto); cualquier ítem remoto sin variante "es" se
descarta al fusionar (la app depende de "es" como fallback universal). Ninguna de las
dos rompe nada — simplemente ese contenido no se detecta automáticamente y sigue
dependiendo de una actualización manual del manifiesto estático, como antes de esto.
