/* ============================================================
   VS Performance — Service Worker
   Serve para o app abrir sem internet e carregar mais rápido.

   REGRA DE OURO desta configuração: o index.html é SEMPRE buscado
   na internet primeiro. Só se a internet falhar é que a cópia
   guardada é usada. Assim o app nunca fica preso numa versão
   antiga — que era o problema que a gente tinha.
   ============================================================ */

const VERSAO = 'vsp-v3.1';
const SHELL  = ['./', './index.html', './manifest.json', './icon.svg'];

// ---------- instalação: guarda o essencial ----------
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSAO)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ---------- ativação: apaga versões antigas ----------
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---------- mensagens vindas do app ----------
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // gravações nunca passam pelo cache

  const url = new URL(req.url);

  // Supabase e qualquer API: sempre rede, nunca cache
  if (url.hostname.indexOf('supabase') >= 0 || url.pathname.indexOf('/rest/v1/') >= 0) return;

  // Páginas (o app em si): REDE PRIMEIRO, cache só como salva-vidas
  const ehPagina = req.mode === 'navigate' ||
                   (req.headers.get('accept') || '').indexOf('text/html') >= 0;
  if (ehPagina) {
    e.respondWith(
      fetch(req)
        .then(r => {
          const copia = r.clone();
          caches.open(VERSAO).then(c => c.put('./index.html', copia)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Demais arquivos (ícones, fontes, biblioteca de gráficos):
  // entrega do cache na hora e atualiza por trás
  e.respondWith(
    caches.match(req).then(cache => {
      const rede = fetch(req).then(r => {
        if (r && r.status === 200) {
          const copia = r.clone();
          caches.open(VERSAO).then(c => c.put(req, copia)).catch(() => {});
        }
        return r;
      }).catch(() => cache);
      return cache || rede;
    })
  );
});
