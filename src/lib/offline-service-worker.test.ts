import assert from "node:assert/strict";
import test from "node:test";

import { createOfflineServiceWorkerSource } from "./offline-service-worker.ts";

test("オフライン用ファイルを重複なく並べて埋め込む", () => {
  const source = createOfflineServiceWorkerSource([
    "/assets/app-b.js",
    "/",
    "/assets/app-a.css",
    "/assets/app-b.js",
  ]);

  assert.match(
    source,
    /const PRECACHE_URLS = \["\/","\/assets\/app-a\.css","\/assets\/app-b\.js"\];/,
  );
});

test("Service Worker自身とソースマップは事前保存の対象外にする", () => {
  const source = createOfflineServiceWorkerSource([
    "/",
    "/sw.js",
    "/assets/app.js.map",
    "/assets/app.js",
  ]);

  const precacheDeclaration = source.match(/const PRECACHE_URLS = ([^;]+);/)?.[1] ?? "";
  assert.equal(precacheDeclaration, '["/","/assets/app.js"]');
});

test("アプリ内容が変わるとキャッシュ名も変わる", () => {
  const first = createOfflineServiceWorkerSource(["/", "/assets/app-a.js"]);
  const second = createOfflineServiceWorkerSource(["/", "/assets/app-b.js"]);
  const cacheName = (source: string) => source.match(/const CACHE_NAME = "([^"]+)";/)?.[1];

  assert.notEqual(cacheName(first), cacheName(second));
});

test("API通信はキャッシュしない", () => {
  const source = createOfflineServiceWorkerSource(["/", "/assets/app.js"]);

  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
});
