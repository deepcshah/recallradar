import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { initAnalytics } from "./lib/analytics";
import { registerServiceWorker } from "./lib/push";
import App from "./App";
import "./index.css";

/* Before first render, so the initial pageview is not attributed to
 * whatever the app navigates to while booting. */
initAnalytics();

/* Production builds only: a service worker under the dev server outlives the
 * tab and intercepts HMR reloads in ways that are miserable to debug. The
 * worker (public/sw.js) handles push and nothing else — no fetch handler, so
 * it can never serve a stale page; see the comment at its top. Registered
 * after load so it never competes with the app's own boot. A static import:
 * App already imports lib/push, so a dynamic one bought no split, only a
 * build warning. */
if (import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    registerServiceWorker().catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    {/* Both no-op off Vercel, so local dev stays quiet. */}
    <Analytics />
    <SpeedInsights />
  </React.StrictMode>
);
