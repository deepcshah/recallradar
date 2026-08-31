import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { initAnalytics } from "./lib/analytics";
import App from "./App";
import "./index.css";

/* Before first render, so the initial pageview is not attributed to
 * whatever the app navigates to while booting. */
initAnalytics();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    {/* Both no-op off Vercel, so local dev stays quiet. */}
    <Analytics />
    <SpeedInsights />
  </React.StrictMode>
);
