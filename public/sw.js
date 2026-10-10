/* Yanked service worker — push notifications, and deliberately nothing else.
 *
 * There is NO fetch handler, and that is the decision this file exists to
 * record. The usual PWA service worker caches the app shell so it opens
 * offline; for this app that is the wrong trade on every axis:
 *
 *   - Staleness is the product's failure mode. A cached index.html pins the
 *     hashed bundles it names, so a user can sit on last week's build — and
 *     last week's copy of /feeds/index.json — for as long as the worker does
 *     not update, with nothing on screen saying so. A recall list that is
 *     quietly old is worse than one that fails to load, because a missing
 *     recall reads as "nothing to worry about". The README's rule that an
 *     empty result must say what was checked cannot survive a cache that
 *     answers for the network without saying when it last heard from it.
 *   - The answers need the network anyway. Stores come from /api/stores,
 *     geocoding from Zippopotam/Nominatim, live recalls from the agencies.
 *     An offline shell would open onto spinners.
 *   - Installability no longer needs one. Chromium dropped the "must have a
 *     fetch handler" install criterion, and iOS never had it; a manifest and
 *     a registered worker are enough.
 *   - A no-op `fetch` listener is not free: it forces every navigation and
 *     subresource through the worker's thread, which browsers warn about.
 *
 * So the network, and the HTTP cache headers Vercel already sends, stay the
 * only source of truth. If offline support is ever wanted, the one thing
 * worth caching is /feeds/index.json, network-first with the fetched-at time
 * surfaced in the UI — never the HTML, never /api/*.
 *
 * Push payloads are JSON written by api/_lib/alerts-engine.js (pushPayloadFor),
 * the same engine that writes the alert emails:
 *   { title, body, url, tag?, recallId? }
 * Tags: "yanked-digest" (weekly, replaces an unread older one),
 * "yanked-<id>" (one new recall), "yanked-u-<id>" (an update to a followed
 * recall), "yanked-urgent" (a summary).
 * `url` is always same-origin ("/" or "/?r=<id>&st=<ST>"); anything else is
 * ignored in favour of "/" so a payload can never open a foreign page.
 */

self.addEventListener("install", () => {
  // Nothing to precache, so nothing to wait for.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function sameOriginPath(url) {
  try {
    const u = new URL(url || "/", self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : "/";
  } catch (_) {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    // A plain-text payload (e.g. a test push from DevTools) still shows.
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Yanked";
  const options = {
    body: data.body || "New recall notices for your area.",
    icon: "/icons/icon-192.png",
    badge: "/icons/maskable-192.png",
    // One tag per kind: a newer weekly digest replaces an unread older one
    // instead of stacking, while each urgent recall keeps its own.
    tag: data.tag || "yanked",
    renotify: Boolean(data.tag && data.tag !== "yanked-digest"),
    data: { url: sameOriginPath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Reuse an open Yanked tab rather than stacking a new one per tap.
    for (const client of all) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        if ("navigate" in client && client.url !== target) await client.navigate(target);
      } catch (_) { /* uncontrolled client — focusing it is still better than nothing */ }
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

/* The push service can rotate a subscription (expiry, key rotation). The
 * worker cannot read localStorage, where the reader's state, follows,
 * followed recalls and preferences live,
 * so it re-subscribes and asks the server to carry the stored preferences
 * over from the old endpoint to the new one. If that fails, the next app
 * open re-syncs through src/lib/push.js. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription;
      const options = (old && old.options) || null;
      const sub = event.newSubscription ||
        (options ? await self.registration.pushManager.subscribe(options) : null);
      if (!sub) return;
      await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), replaces: old ? old.endpoint : undefined }),
      });
    } catch (_) { /* best effort */ }
  })());
});
