/* PostHog wiring.
 *
 * Yanked has no accounts and no login, so every visitor is anonymous and
 * stays that way — nothing here ever calls `identify`. That shapes two of
 * the settings below (`person_profiles`, `persistence`) and it is the
 * reason the event properties are written the way they are.
 *
 * WHAT DELIBERATELY NEVER LEAVES THE BROWSER
 *
 * This app knows where its user is standing. That is the most sensitive
 * thing it holds, and none of it is sent:
 *
 *   - no latitude or longitude, at any precision
 *   - no ZIP, address, or city — not the text typed into the box, and not
 *     the label geocoding resolved it to
 *   - no store names or addresses from a nearby-store result
 *
 * What is sent instead is the two-letter state, which is the granularity
 * the recall feeds themselves are scoped to and the coarsest thing that
 * still answers "is this working outside California?". Everything else is
 * a count, a duration bucket, or an outcome word.
 *
 * Scanned barcodes ARE sent. A UPC identifies a product, not a person, and
 * "which products are people scanning" is the single most useful thing
 * this app can learn — it is the only measure of whether the barcode
 * coverage problem described in lib/upc.js is actually biting.
 *
 * SESSION REPLAY is on with text and inputs masked (see `session_recording`
 * below), which keeps a typed ZIP and a resolved city out of the recording
 * at the cost of making replays read as grey boxes. The comment there says
 * exactly what to loosen if that trade stops being worth it.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY;

/* Default to the same-origin proxy declared in vercel.json. Ad blockers
 * drop requests to posthog.com outright, and they drop them for a biased
 * slice of the audience, so the numbers are wrong in a direction you
 * cannot see. Overridable for a preview deploy that has no rewrite. */
const HOST = import.meta.env.VITE_POSTHOG_HOST || "/ingest";

/* Only used to build links out to the PostHog UI (toolbar, "view in
 * PostHog"). EU projects want https://eu.posthog.com. */
const UI_HOST = import.meta.env.VITE_POSTHOG_UI_HOST || "https://us.posthog.com";

/* Dev traffic in the production project is noise that never washes out, so
 * `npm run dev` stays silent even when a key is present in .env.local. Set
 * VITE_POSTHOG_DEV=1 to check that instrumentation actually fires.
 *
 * Note what this does *not* gate: `import.meta.env.DEV` is true only under
 * the dev server, so every `vite build` — preview deploys included — is
 * live as soon as the key is scoped to that environment. That is the right
 * default (a preview you cannot measure is a preview you cannot test), but
 * it means preview traffic reaches the same project as production, which
 * is what VERCEL_ENV below exists to separate. */
const ENABLED = Boolean(KEY) && (!import.meta.env.DEV || import.meta.env.VITE_POSTHOG_DEV === "1");

/* Which deployment this is: "production", "preview", or "development".
 *
 * Vercel sets this for Vite builds on its own — no dashboard entry, no
 * config — as long as the project's "Automatically expose System
 * Environment Variables" is on, which it is by default.
 *
 * Without it a branch deploy, a PR preview and whatever automation wanders
 * into a preview URL all land in the same funnels as real users, and
 * nothing on the event says which was which. With it, `environment =
 * production` is one filter, and the honest baseline for any number worth
 * acting on. */
const VERCEL_ENV = import.meta.env.VITE_VERCEL_ENV || "unknown";

/* posthog-js is ~90kB gzipped — two thirds the size of everything else on
 * this page put together. Imported statically it lands in the main chunk
 * and delays the first render of a page whose whole job is to answer a
 * question quickly, which is precisely what the Speed Insights numbers
 * next door would then report.
 *
 * So it is fetched as its own chunk, started immediately rather than on
 * idle: the request goes out in parallel with the app's own boot instead
 * of blocking it, and analytics is live within a few hundred ms. Events
 * fired before it lands are queued rather than dropped, so the early ones
 * that matter most — a scan opened straight off a cold load — survive.
 */
let ph = null;
let started = false;
let failed = false;
const pending = [];
const PENDING_MAX = 50;

export function initAnalytics() {
  if (started || !ENABLED) return;
  started = true;

  import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: HOST,
        ui_host: UI_HOST,
        defaults: "2026-08-30",

        /* Anonymous app: a person profile per visitor would bill for
         * millions of rows that answer nothing, since no two sessions are
         * ever known to be the same human. Events still carry properties
         * and still power every funnel and trend below. */
        person_profiles: "identified_only",

        /* Clicks, submits and pageviews with no instrumentation — the
         * point is to see what people reach for before we have guessed
         * what to measure. The explicit events elsewhere cover what
         * autocapture structurally cannot see: outcomes, counts, and why
         * something failed. */
        autocapture: true,
        capture_pageview: "history_change",

        session_recording: {
          /* Masked hard on purpose. The location field holds a real ZIP or
           * street address, and the header chip holds the city it resolved
           * to, so a replay of the flow worth watching is exactly the
           * replay that would carry it.
           *
           * To trade privacy for legibility later: drop `maskTextSelector`
           * and keep `maskAllInputs`, which un-greys the UI while still
           * keeping typed text out. Then mark the location chip and any
           * element rendering `loc.label` with class `ph-no-capture`. Do
           * that deliberately, not by accident. */
          maskAllInputs: true,
          maskTextSelector: "*",
        },
      });
      /* A super property, not a per-call one: it has to ride on autocapture
       * and $pageview too, and neither goes through track(). */
      posthog.register({ environment: VERCEL_ENV });
      ph = posthog;
      for (const [event, props] of pending.splice(0)) posthog.capture(event, props);
    })
    .catch(() => {
      /* Blocked by an extension, offline, or a stale deploy 404ing the
       * chunk. Give up for the session rather than holding events that
       * now have nowhere to go. */
      failed = true;
      pending.length = 0;
    });
}

/** Send an event. A no-op when PostHog is not configured or not enabled. */
export function track(event, props) {
  if (!ENABLED || failed) return;
  if (ph) {
    try {
      ph.capture(event, props);
    } catch (_) {
      /* Analytics must never be able to break the page it is measuring. */
    }
    return;
  }
  if (pending.length < PENDING_MAX) pending.push([event, props]);
}

/** Metres to whole miles, for radius properties. */
export function miles(m) {
  return Math.round((m / 1609.34) * 10) / 10;
}

/* Browser geolocation failures, reduced to a handful of buckets. The raw
 * message is a per-browser string that would shatter the breakdown into
 * dozens of one-off rows, and it can name the platform's own wording for
 * the user's setup. The distinction that matters is refused vs. broken. */
export function geoFailureReason(err) {
  const m = String((err && err.message) || "").toLowerCase();
  if (/denied|permission/.test(m)) return "permission_denied";
  if (/unsupported|not supported/.test(m)) return "unsupported";
  if (/timeout|timed out/.test(m)) return "timeout";
  if (/unavailable|position/.test(m)) return "position_unavailable";
  return "error";
}
