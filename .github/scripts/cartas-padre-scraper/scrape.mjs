import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Scraper de Cartas/Mensajes del Padre — ver README.md de esta carpeta para el contexto completo
// (por qué existe, qué reemplaza). Recorre la página "hub" de cartas pastorales/mensajes del
// Prelado en cada idioma soportado por la app, clasifica cada ítem como carta o mensaje por su
// slug, y para los ítems nuevos visita el detalle para sacar el link de descarga (cartas) o el
// texto completo (mensajes). Publica manifest.json con el mismo shape que usa
// CartasPadreManifest.kt en la app, para que esta lo lea vía HTTP en vez de depender de un
// manifiesto fijo compilado en Kotlin.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUT_PATH = process.argv[2] || 'manifest.json';

// clave de idioma = IdiomaApp.claveContenidoPadre (ver i18n/IdiomaApp.kt). "es" siempre debe
// existir: es la variante de respaldo cuando falta traducción (ver CartaPadreManifiestoItem.variante()).
const LANGS = [
  { key: 'es', hubUrl: 'https://opusdei.org/es-mx/page/cartas-pastorales/' },
  { key: 'en', hubUrl: 'https://opusdei.org/en-us/article/pastoral-letters-prelate-fernando-ocariz-collected' },
  { key: 'fr', hubUrl: 'https://opusdei.org/fr-fr/page/lettres-pastorales/' },
  { key: 'de', hubUrl: 'https://opusdei.org/de-de/page/pastoralbriefe-und-botschaften/' },
  { key: 'it', hubUrl: 'https://opusdei.org/it-it/page/lettere-pastorali/' },
  { key: 'nl', hubUrl: 'https://opusdei.org/nl/page/pastorale-brieven-berichten/' },
  { key: 'pt-br', hubUrl: 'https://opusdei.org/pt-pt/page/cartas-pastorais-e-mensagens/' },
  // Cobertura parcial: opusdei.org no tiene un hub polaco tan completo como el resto (ver
  // README). Lo que no se encuentre aquí cae al fallback "es" en la app, igual que hoy.
  { key: 'pl', hubUrl: 'https://opusdei.org/pl-pl/page/listy-pasterskie-fernando-ocariza/' },
];

// Palabras que identifican el slug de una carta pastoral larga (o una recopilación "selección de
// textos") vs. un mensaje corto, en cada idioma. Mismo criterio informal que ya usa
// CartasPadreManifest.kt (mirar los nombres de archivo curados a mano).
const CARTA_RE = /\/(carta|letter|lettre|brief|lettera|list|selecci|selection|selecao|selezione)/i;
const MENSAJE_RE = /\/(mensaje|message|botschaft|bericht|messaggio|slowo)/i;

const MESES = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
  'pt-br': ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  pl: ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'],
};

function normalizarFecha(tituloOTexto, langKey) {
  const meses = MESES[langKey] || MESES.es;
  const patron = new RegExp(`(\\d{1,2})\\.?\\s*(?:de\\s+)?(${meses.join('|')})\\.?,?\\s*(?:de\\s+)?(\\d{4})`, 'i');
  const m = tituloOTexto.match(patron);
  if (!m) return null;
  const dia = m[1].padStart(2, '0');
  const mes = String(meses.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) + 1).padStart(2, '0');
  const anio = m[3];
  if (mes === '00') return null;
  return `${anio}-${mes}-${dia}`;
}

function limpiarTitulo(pageTitle) {
  return pageTitle.replace(/\s*[-|]\s*Opus Dei\s*$/i, '').trim();
}

function extraerCuerpoMensaje(articleText) {
  const inicio = articleText.indexOf('ePUB');
  let resto = inicio === -1 ? articleText : articleText.slice(inicio + 'ePUB'.length);
  const finIdx = resto.search(/\n\s*FB\s*\n/);
  if (finIdx !== -1) resto = resto.slice(0, finIdx);

  // Algunos mensajes tienen un bloque promocional ("📖 Lee y comparte...", "Descargar ePub ·
  // Descargar PDF · Apple Books...") antes del cuerpo real — se descartan las líneas cortas de
  // ese tipo hasta encontrar la primera línea que parece prosa real.
  const lineasRuido = /^(📖|lee y comparte|descargar |apple books|google play books?)/i;
  const lineas = resto.split('\n');
  let desde = 0;
  while (desde < lineas.length && (lineas[desde].trim() === '' || lineasRuido.test(lineas[desde].trim()) || lineas[desde].trim().length < 40)) {
    desde++;
  }
  return lineas.slice(desde).join('\n').trim();
}

async function nuevaPagina(browser) {
  return browser.newPage({ userAgent: UA });
}

async function irA(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
}

async function listarItemsDelHub(browser, lang) {
  const page = await nuevaPagina(browser);
  await irA(page, lang.hubUrl);
  const links = await page.$$eval('a[href*="/article/"]', as => [...new Set(as.map(a => a.href.split('#')[0]))]);
  await page.close();

  const items = [];
  for (const href of links) {
    if (/\/(pdf|epub)\/?$/.test(href)) continue; // links de descarga directa del propio hub, no un artículo
    let tipo = null;
    if (CARTA_RE.test(href)) tipo = 'carta';
    else if (MENSAJE_RE.test(href)) tipo = 'mensaje';
    if (tipo) items.push({ href, tipo });
  }
  return items;
}

async function extraerDetalleCarta(browser, href) {
  const page = await nuevaPagina(browser);
  try {
    await irA(page, href);
    const title = limpiarTitulo(await page.title());
    const descargas = await page.$$eval('a[href*="multimedia.opusdei.org"], a[href*="odnmedia.s3.amazonaws.com"]', as =>
      as.map(a => a.href).filter(h => /\.(epub|pdf)(\?|$)/i.test(h))
    );
    if (descargas.length === 0) return null;
    const urlDescarga = descargas.find(u => /\.epub/i.test(u)) || descargas[0];
    const extension = /\.epub/i.test(urlDescarga) ? 'epub' : 'pdf';
    return { titulo: title, urlDescarga, extension };
  } catch (e) {
    console.error('  ! error en detalle carta', href, e.message.split('\n')[0]);
    return null;
  } finally {
    await page.close();
  }
}

async function extraerDetalleMensaje(browser, href, langKey) {
  const page = await nuevaPagina(browser);
  try {
    await irA(page, href);
    const title = limpiarTitulo(await page.title());
    const articleText = await page.$eval('article', el => el.innerText).catch(() => '');
    const fecha = normalizarFecha(title, langKey) || normalizarFecha(articleText, langKey);
    const contenido = extraerCuerpoMensaje(articleText);
    if (!fecha || !contenido) return null;
    return { titulo: title, fecha, contenido };
  } catch (e) {
    console.error('  ! error en detalle mensaje', href, e.message.split('\n')[0]);
    return null;
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // grupos: Map<"tipo|fecha", { tipo, fecha, variantesPorIdioma: Map<langKey, {href, titulo, ...}> }>
  const grupos = new Map();

  for (const lang of LANGS) {
    console.log(`\n=== ${lang.key}: listando ${lang.hubUrl} ===`);
    let items;
    try {
      items = await listarItemsDelHub(browser, lang);
    } catch (e) {
      console.error(`  ! no se pudo leer el hub de ${lang.key}:`, e.message.split('\n')[0]);
      continue;
    }
    console.log(`  ${items.length} ítems candidatos (cartas+mensajes)`);

    for (const item of items) {
      const detalle = item.tipo === 'carta'
        ? await extraerDetalleCarta(browser, item.href)
        : await extraerDetalleMensaje(browser, item.href, lang.key);
      if (!detalle) continue;

      const fecha = item.tipo === 'mensaje' ? detalle.fecha : normalizarFecha(detalle.titulo, lang.key);
      if (!fecha) {
        console.error(`  ! no se pudo determinar fecha para ${item.href}, se omite`);
        continue;
      }
      const claveGrupo = `${item.tipo}|${fecha}`;
      if (!grupos.has(claveGrupo)) grupos.set(claveGrupo, { tipo: item.tipo, fecha, variantes: new Map() });
      grupos.get(claveGrupo).variantes.set(lang.key, { href: item.href, ...detalle });
      console.log(`  [${lang.key}] ${item.tipo} ${fecha} — ${detalle.titulo}`);
    }
  }

  await browser.close();

  const cartas = [];
  const mensajes = [];
  for (const grupo of grupos.values()) {
    const claveBase = grupo.variantes.get('es')?.href || [...grupo.variantes.values()][0].href;
    if (grupo.tipo === 'carta') {
      const variantes = {};
      for (const [langKey, v] of grupo.variantes) variantes[langKey] = { titulo: v.titulo, urlDescarga: v.urlDescarga, extension: v.extension };
      cartas.push({ clave: claveBase, asignarCarpeta: true, variantes });
    } else {
      const variantes = {};
      for (const [langKey, v] of grupo.variantes) variantes[langKey] = { titulo: v.titulo, fecha: v.fecha, contenido: v.contenido };
      mensajes.push({ clave: claveBase, variantes });
    }
  }

  // Más recientes primero, igual que el orden ya usado en CartasPadreManifest.kt (el sync lee
  // este orden como recencia explícita — ver CartasPadreSyncManager.sincronizar()).
  cartas.sort((a, b) => (a.clave < b.clave ? 1 : -1));
  mensajes.sort((a, b) => (a.clave < b.clave ? 1 : -1));

  const manifest = { generatedAt: new Date().toISOString(), cartas, mensajes };
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nEscrito ${OUT_PATH}: ${cartas.length} cartas, ${mensajes.length} mensajes.`);
}

main();
