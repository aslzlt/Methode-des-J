"use strict";

/* ==========================================================================
   MÉTHODE DES J — Service Worker
   - Rend l'app installable et utilisable hors-ligne (cache de l'app shell)
   - Affiche des notifications locales (via registration.showNotification)
   - Vérifie les révisions du jour :
       * à la demande (message CHECK_NOW envoyé par la page)
       * en tâche de fond via l'API Periodic Background Sync
         (Android/Chrome uniquement — voir le README pour les limites,
         notamment sur iOS/Safari)
   ========================================================================== */

var CACHE_NAME = "methode-j-shell-v1";
var META_CACHE = "methode-j-meta-v1";
var APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

/* ---------- Supabase (mêmes identifiants que dans index.html) ---------- */
var SUPABASE_URL = "https://omnvpdvarfdczchocgro.supabase.co";
var SUPABASE_KEY = "sb_publishable_XJre9CQNKmbQmsanYluLrw_1plZVxQ9";
var TABLE_NAME = "revisions";

/* ==========================================================================
   1. Cycle de vie : install / activate / fetch (app shell hors-ligne)
   ========================================================================== */
self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE_NAME && k !== META_CACHE; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  // Ne jamais mettre en cache les appels à l'API Supabase : on veut toujours
  // les données fraîches quand le réseau est disponible.
  if (event.request.url.indexOf(SUPABASE_URL) === 0) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request).catch(function () {
        return caches.match("./index.html");
      });
    })
  );
});

/* ==========================================================================
   2. Petit stockage clé/valeur basé sur Cache Storage
      (utilisé pour retenir la date de la dernière notification envoyée)
   ========================================================================== */
function metaGet(key) {
  return caches.open(META_CACHE).then(function (cache) {
    return cache.match(key).then(function (res) { return res ? res.text() : null; });
  });
}
function metaSet(key, value) {
  return caches.open(META_CACHE).then(function (cache) {
    return cache.put(key, new Response(value));
  });
}

/* ==========================================================================
   3. Dates (mêmes règles que dans index.html — heure locale)
   ========================================================================== */
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function toISO(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayISO() { return toISO(new Date()); }

/* ==========================================================================
   4. Vérification des révisions du jour + notification
   ========================================================================== */
function fetchRevisions() {
  var url = SUPABASE_URL + "/rest/v1/" + TABLE_NAME + "?select=schedule";
  return fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
  }).then(function (res) {
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    return res.json();
  });
}

function countDueAndLate(rows, t) {
  var due = 0, late = 0;
  for (var i = 0; i < rows.length; i++) {
    var schedule = rows[i] && rows[i].schedule;
    if (!Array.isArray(schedule)) continue;
    for (var j = 0; j < schedule.length; j++) {
      var r = schedule[j];
      if (!r || r.offset === 0 || r.done) continue;
      if (r.date === t) due++;
      else if (r.date < t) late++;
    }
  }
  return { due: due, late: late };
}

/**
 * Vérifie s'il y a des révisions à faire aujourd'hui et affiche
 * une notification (au maximum une par jour).
 * @param {boolean} force - ignore le garde-fou "une fois par jour" (debug/CHECK_NOW)
 */
function checkDueReviewsAndNotify(force) {
  var t = todayISO();
  return metaGet("lastNotifDay").then(function (last) {
    if (!force && last === t) return false; // déjà notifié aujourd'hui
    return fetchRevisions().then(function (rows) {
      var counts = countDueAndLate(rows, t);
      if (!counts.due && !counts.late) return false;
      var msg = counts.due > 0
        ? counts.due + (counts.due > 1 ? " révisions" : " révision") + " à faire aujourd'hui" +
          (counts.late ? " · " + counts.late + " en retard" : "") + "."
        : "Aucune révision restante aujourd'hui · " + counts.late + " en retard.";
      return self.registration.showNotification("📚 Révisions du jour", {
        body: msg,
        tag: "methode-j-daily",
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        lang: "fr",
        data: { url: "./index.html" }
      }).then(function () {
        return metaSet("lastNotifDay", t).then(function () { return true; });
      });
    });
  }).catch(function () {
    return false; // pas de réseau / erreur Supabase : on abandonne silencieusement
  });
}

/* ==========================================================================
   5. Déclencheurs
   ========================================================================== */

// Vérification à la demande, envoyée par la page (ouverture de l'app, etc.)
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "CHECK_NOW") {
    event.waitUntil(checkDueReviewsAndNotify(!!event.data.force));
  }
});

// Vérification périodique en tâche de fond — Android/Chrome uniquement.
// Le navigateur choisit lui-même le moment exact (pas d'heure garantie),
// et seulement si l'app est installée et suffisamment utilisée.
self.addEventListener("periodicsync", function (event) {
  if (event.tag === "daily-revisions-check") {
    event.waitUntil(checkDueReviewsAndNotify(false));
  }
});

// Compatibilité : certains navigateurs Android proposent un "one-off sync"
// quand la connexion revient — on en profite pour vérifier aussi.
self.addEventListener("sync", function (event) {
  if (event.tag === "revisions-check-once") {
    event.waitUntil(checkDueReviewsAndNotify(false));
  }
});

// Clic sur la notification : ouvre (ou remet au premier plan) l'application.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
