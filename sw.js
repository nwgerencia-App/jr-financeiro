// Service worker do Financeiro: abre mesmo sem internet, pega atualizações e mostra avisos de vencimento.
const CACHE = 'financeiro-v4';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return; // nunca guardar respostas de API

  // Páginas: tenta a rede primeiro (pega versão nova), cai no cache se estiver offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Demais arquivos: cache primeiro, atualiza em segundo plano
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

// ===== Avisos de vencimento (Android, app instalado, com o app fechado) =====
function idbOpen() { return new Promise((res, rej) => { const r = indexedDB.open('fin_notif', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbGet(k) { return idbOpen().then(db => new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); }
function idbSet(k, v) { return idbOpen().then(db => new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); })); }
function dataLocal() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function diasEntre(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); }

function montarAviso(d, hoje) {
  if (!d || !d.ativo) return null;
  const c = { ap: 0, hp: 0, pp: 0, ar: 0, hr: 0, pr: 0 };
  (d.items || []).forEach(i => {
    const df = diasEntre(hoje, i.venc), p = i.t === 'p';
    if (df < 0) p ? c.ap++ : c.ar++;
    else if (df === 0) p ? c.hp++ : c.hr++;
    else if (df <= d.dias) p ? c.pp++ : c.pr++;
  });
  const L = [], s = n => n > 1 ? 's' : '', dd = d.dias + (d.dias === 1 ? ' dia' : ' dias');
  if (c.ap) L.push('🔴 ' + c.ap + ' conta' + s(c.ap) + ' a pagar em atraso');
  if (c.hp) L.push('🟠 ' + c.hp + ' conta' + s(c.hp) + ' a pagar ' + (c.hp > 1 ? 'vencem' : 'vence') + ' hoje');
  if (c.pp) L.push('🟡 ' + c.pp + ' conta' + s(c.pp) + ' a pagar nos próximos ' + dd);
  if (c.ar) L.push('🔴 ' + c.ar + ' recebimento' + s(c.ar) + ' em atraso');
  if (c.hr) L.push('🟢 ' + c.hr + ' recebimento' + s(c.hr) + ' previsto' + s(c.hr) + ' para hoje');
  if (c.pr) L.push('🔵 ' + c.pr + ' recebimento' + s(c.pr) + ' nos próximos ' + dd);
  return L.length ? { title: 'Vencimentos – Financeiro', body: L.join('\n') } : null;
}

async function avisoPeriodico() {
  const dados = await idbGet('dados').catch(() => null);
  const hoje = dataLocal();
  const av = montarAviso(dados, hoje);
  if (!av) return;
  if ((await idbGet('ultimo').catch(() => null)) === hoje) return; // no máximo um aviso por dia
  await self.registration.showNotification(av.title, { body: av.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'vencimentos', renotify: true });
  await idbSet('ultimo', hoje).catch(() => {});
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'vencimentos') e.waitUntil(avisoPeriodico());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
