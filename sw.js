"use strict";

const VERSION = "v5";
const SHELL = "shell-" + VERSION;
const DATA = "data-" + VERSION;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./data.js",
  "./remind.html",
  "./remind.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Data is read live from the GitHub API (data.js); same network-first rule.
  const apiData = url.hostname === "api.github.com" && url.pathname.includes("/contents/") &&
    url.pathname.endsWith(".jsonl") && !req.headers.has("Authorization");
  if (url.origin !== self.location.origin && !apiData) return;

  if (url.pathname.endsWith(".jsonl")) {
    // Network-first so new ideas/presence show; fall back to cache offline.
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  // App shell: cache-first.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.pathname.endsWith(".js") || url.pathname.endsWith(".html") || url.pathname.endsWith(".css") ||
          url.pathname.endsWith(".png") || url.pathname.endsWith(".svg") ||
          url.pathname.endsWith(".webmanifest") || url.pathname.endsWith("/"))) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});

// Reminder notification actions: hand them to an open remind page, or open one.
self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  const scope = self.registration.scope;
  e.waitUntil((async () => {
    if (e.action === "open" || !e.action) {
      return self.clients.openWindow(scope + "index.html?q=" + encodeURIComponent(d.text || ""));
    }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = wins.find((w) => w.url.includes("remind.html"));
    if (page) {
      page.postMessage({ type: "remind-action", action: e.action, id: d.id });
      return page.focus();
    }
    return self.clients.openWindow(scope + "remind.html?act=" + e.action + "&id=" + encodeURIComponent(d.id));
  })());
});
