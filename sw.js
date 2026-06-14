/* ═══════════════════════════════════════════════════════════════
   NeonTrace — Service Worker
   ───────────────────────────────────────────────────────────────
   Stratégies :
   • App shell  → Cache-first  (HTML + Leaflet CSS/JS)
   • Tiles carto → Network-first avec mise en cache locale (≤ MAX_TILES)
                   → fallback cache si hors-ligne
   • Reste       → Network-first, pas de cache

   Le cache des tiles permet d'utiliser la carte hors-ligne sur
   les zones déjà visitées, ce qui est l'usage principal.
═══════════════════════════════════════════════════════════════ */

const APP_VER    = 'neontrace-app-v3';
const TILE_VER   = 'neontrace-tiles-v1';
const MAX_TILES  = 1500;   // ~30 MB sur AVIF/WebP, ~60 MB sur PNG

/* Ressources pré-cachées à l'installation */
const APP_SHELL = [
    './neontrace_v3.html',
    './manifest.json',
    './icon.svg',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

/* ─── INSTALL ─────────────────────────────────────────────── */
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(APP_VER)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())   // active immédiatement
    );
});

/* ─── ACTIVATE : nettoyage des anciens caches ─────────────── */
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(k => k !== APP_VER && k !== TILE_VER)
                    .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

/* ─── FETCH ───────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
    const url = event.request.url;

    /* 1. Tuiles CartoDB → Network-first + cache avec éviction FIFO */
    if (isTile(url)) {
        event.respondWith(fetchTile(event.request));
        return;
    }

    /* 2. App shell → Cache-first */
    if (isShell(url)) {
        event.respondWith(
            caches.match(event.request)
                .then(cached => cached || fetch(event.request))
        );
        return;
    }

    /* 3. Tout le reste → Network-first, pas de cache */
    /* (IndexedDB géré directement dans la page, pas via SW) */
});

/* ─── Helpers ──────────────────────────────────────────────── */

function isTile(url) {
    return url.includes('cartocdn.com') ||
           url.includes('basemaps.cartocdn') ||
           url.includes('openstreetmap.org/tiles');
}

function isShell(url) {
    return APP_SHELL.some(s => url.endsWith(s.replace('./', '')))
        || url.includes('leaflet@1.9.4');
}

async function fetchTile(request) {
    const cache = await caches.open(TILE_VER);

    try {
        /* Tenter le réseau en premier */
        const response = await fetch(request);

        if (response.ok) {
            /* Éviction FIFO si la limite est atteinte */
            const keys = await cache.keys();
            if (keys.length >= MAX_TILES) {
                /* Supprimer les 10 plus anciens d'un coup (moins de transactions) */
                await Promise.all(keys.slice(0, 10).map(k => cache.delete(k)));
            }
            cache.put(request, response.clone());
        }

        return response;
    } catch {
        /* Hors-ligne → tenter le cache local */
        const cached = await cache.match(request);
        if (cached) return cached;

        /* Tile absente du cache : tuile transparente 1×1 */
        return new Response(
            new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,
                            0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,
                            11,73,68,65,84,120,156,98,0,1,0,0,5,0,1,13,10,
                            45,180,0,0,0,0,73,69,78,68,174,66,96,130]),
            { status: 200, headers: { 'Content-Type': 'image/png' } }
        );
    }
}
