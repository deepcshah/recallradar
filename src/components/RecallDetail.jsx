import { useEffect, useState } from "react";
import {
  ArrowUpRight, BellRing, Check, CircleHelp, History, MapPin, MapPinOff, Megaphone, Plus, Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import StateMap from "@/components/StateMap";
import WatchButton from "@/components/WatchButton";
import RecallThumb from "@/components/RecallThumb";
import RecallAssist from "@/components/RecallAssist";
import { AnnouncedBadge, ClassBadge, agencyOf, followTermFor } from "@/components/VerdictCard";
import { fmtAsOf } from "@/components/FreshnessLine";
import { verdictFor, coverageOf, resolveLoc, VERDICTS, isAnnounced } from "@/lib/verdict";
import { coverageLine } from "@/lib/coverage-line";
import { classInfo } from "@/lib/classification";
import { plainHeadline, whatToDo, hazardLabel } from "@/lib/digest";
import { officialImage } from "@/lib/official-image";
import { categoryFor } from "@/lib/category";
import { recallUpcs, lookupProduct } from "@/lib/upc";
import { shareRecall } from "@/lib/share";
import { addFollow, removeFollow, getFollows, FOLLOWS_EVENT } from "@/lib/follows";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * ONE RECALL, OPENED
 *
 * The bottom sheet on a phone, a centred dialog on a desktop. Read top to
 * bottom it is the order a worried person checks things in:
 *
 *   [photo or category tile]         only a real photo, labelled by source
 *   Wheat kernel contamination: …    plainHeadline, the title
 *   United Sugar Producers           the firm
 *   [Class II ⓘ] [FDA Food]
 *   ┌ Not reported in New York ─────┐ the verdict, one plain block, ink —
 *   │ Sent to IA, IL, IN … Distrib… │ never green: a shipping list is not
 *   └───────────────────────────────┘ an all-clear
 *   Where it went                     the notice's words, quoted, + the map
 *   What happened                     the hazard; the class, explained
 *   What to do                        whatToDo — generic, never invented
 *   Get help                          the assistant (RecallAssist), products
 *                                     and devices only
 *   How to identify it                description, codes, barcodes
 *   Dates · Notify me · Follow
 *   ( Share )( Notify me )( Official notice ↗ )   floating action bar,
 *                                    Share primary —
 *                                    Notify me only while the recall is
 *                                    announced and waiting on details
 *
 * Photos: the agency's own (CPSC, https on cpsc.gov), or — only here, only
 * when the record carries a barcode, fetched when the sheet opens and cached
 * for the session — Open Food Facts' community photo, captioned "the
 * recalled lot may look different". Otherwise the category tile. Nothing
 * else, ever.
 * ───────────────────────────────────────────────────────────────────────── */

const VERDICT_ICON = {
  [VERDICTS.IN_AREA]: MapPin,
  [VERDICTS.NOT_LISTED]: MapPinOff,
  [VERDICTS.UNSTATED]: CircleHelp,
  [VERDICTS.ENDED]: History,
  [VERDICTS.NEEDS_LOCATION]: MapPin,
  [VERDICTS.ANNOUNCED]: Megaphone,
};

const OUR_PLACEHOLDERS = /^(?:region not stated|)$/i;

function freshKey(source) {
  const s = String(source || "");
  if (s.startsWith("FDA")) return "FDA";
  if (s.startsWith("USDA")) return "USDA FSIS";
  return s === "CPSC" ? "CPSC" : null;
}

function fmtDay(iso) {
  if (!iso) return "";
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (isNaN(t)) return "";
  return t.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/* "Dairy & eggs", "Medication" — the tile's kind, in words, for the line
 * beside it. */
function kindLabel(r) {
  const l = categoryFor(r || {}).label || "";
  return l.charAt(0).toUpperCase() + l.slice(1);
}

const clipped = (t) => /…$/.test(String(t || "").trim());
const unclip = (t) => String(t || "").trim().replace(/…$/, "").trim();

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}

/* ───────────────────────────── the photo ───────────────────────────────── */

/** The agency's photo, or Open Food Facts' for a recall that prints a
 *  barcode — fetched once the sheet is open, never for a list. */
function usePhoto(recall) {
  const official = officialImage(recall && recall.image, recall && recall.source);
  const [off, setOff] = useState(null);
  useEffect(() => {
    setOff(null);
    if (!recall || official) return undefined;
    const codes = (Array.isArray(recall.upcs) && recall.upcs.length ? recall.upcs : recallUpcs(recall));
    const code = codes && codes[0];
    if (!code) return undefined;
    let live = true;
    lookupProduct(code)
      .then((p) => { if (live && p && (p.imageLarge || p.image)) setOff({ src: p.imageLarge || p.image, name: p.name || "" }); })
      .catch(() => {});
    return () => { live = false; };
  }, [recall, official]);
  if (official) return { src: official, kind: "agency", caption: `Photo: ${agencyOf(recall.source)}` };
  if (off) return { src: off.src, kind: "off", caption: "Photo: Open Food Facts — the recalled lot may look different" };
  return null;
}

function Hero({ recall, photo }) {
  const [failed, setFailed] = useState(null);
  if (photo && failed !== photo.src) {
    return (
      <figure className="m-0">
        <div className="overflow-hidden rounded-[22px] bg-white shadow-[inset_0_0_0_1px_var(--rr-line)]">
          <img
            src={photo.src}
            alt={unclip(recall.product)}
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(photo.src)}
            className="mx-auto block h-52 w-full object-contain sm:h-60"
          />
        </div>
        <figcaption className="mt-2 text-[12px] leading-snug text-subtle">{photo.caption}</figcaption>
      </figure>
    );
  }
  return <RecallThumb recall={recall} size="lg" />;
}

/* ───────────────────────────── pieces ──────────────────────────────────── */

function Section({ title, children, className }) {
  return (
    <section className={cn("border-t border-line pt-5", className)}>
      <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-paper">{title}</h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Quote({ who, children }) {
  return (
    <blockquote className="m-0 rounded-2xl bg-sunken px-4 py-3">
      <p className="text-[14px] leading-relaxed text-paper [overflow-wrap:anywhere]">“{children}”</p>
      {who && <p className="mt-1 text-[12px] text-subtle">{who}</p>}
    </blockquote>
  );
}

function sameTerm(a, b) {
  const f = (s) => String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  return f(a) === f(b);
}

function useFollowing(term) {
  const [on, setOn] = useState(() => !!term && getFollows().some((f) => sameTerm(f, term)));
  useEffect(() => {
    if (!term) return undefined;
    const sync = () => setOn(getFollows().some((f) => sameTerm(f, term)));
    sync();
    window.addEventListener(FOLLOWS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FOLLOWS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [term]);
  return on;
}

function FollowRow({ term }) {
  const on = useFollowing(term);
  if (!term) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => (on ? removeFollow(term) : addFollow(term))}
      className="press flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-fog">
        {on ? <BellRing aria-hidden="true" className="size-[18px]" /> : <Plus aria-hidden="true" className="size-[18px]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-paper">{on ? `Following ${term}` : `Follow ${term}`}</span>
        <span className="block text-[12.5px] text-subtle">{on ? "New recalls naming it show in Alerts" : "Get told about new recalls naming it"}</span>
      </span>
    </button>
  );
}

/* ───────────────────────────── action bar ──────────────────────────────── */

/* Notify me earns a place in the bar only while there is something still to
 * hear: a company's announcement the agency hasn't classified or given a
 * distribution for yet. Otherwise the notice is complete and Notify me waits
 * as a row at the foot of the sheet. */
function watchInBar(recall) {
  return isAnnounced(recall) || !recall.url;
}

/** The floating bar at the foot of the sheet: Share — the primary action —
 *  Notify me while the recall is pending, and the official notice. */
export function RecallActionBar({ recall, loc }) {
  const L = resolveLoc(loc);
  const stateAbbr = L && L.stateAbbr;
  const watch = watchInBar(recall);
  const crowded = watch && !!recall.url;
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!said) return undefined;
    const t = setTimeout(() => setSaid(""), 2200);
    return () => clearTimeout(t);
  }, [said]);
  return (
    <div className="glass flex items-center gap-2 rounded-full p-1.5 shadow-[var(--rr-shadow-3),inset_0_0_0_1px_var(--rr-glass-line)]">
      <button
        type="button"
        onClick={async () => {
          const out = await shareRecall(recall, stateAbbr);
          track("share_clicked", {
            outcome: out,
            verdict: verdictFor(recall, stateAbbr ? { stateAbbr } : null).verdict,
            source: recall.source || null,
          });
          if (out === "copied") setSaid("Link copied");
          else if (out === "shared") setSaid("Shared");
        }}
        className="inline-flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-mint px-5 text-[15px] font-semibold text-mint-ink shadow-[var(--rr-shadow-2)] transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rr-surface)]"
      >
        {said ? <Check aria-hidden="true" className="size-[18px] shrink-0" /> : <Share2 aria-hidden="true" className="size-[18px] shrink-0" />}
        <span aria-live="polite" className="truncate">{said || "Share"}</span>
      </button>
      {watch && <WatchButton recall={recall} variant="bar" className="min-w-0 shrink-0" />}
      {recall.url && (
        <a
          href={recall.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track("official_notice_clicked", { source: recall.source || null, from: "bar" })}
          className={cn(
            "inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-panel-2 text-[15px] font-semibold text-paper shadow-[var(--rr-shadow-1),inset_0_0_0_1px_var(--rr-line)] transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint",
            crowded ? "px-4 sm:px-5" : "px-5",
          )}
        >
          {crowded ? (
            <span className="truncate"><span className="sm:hidden">Notice</span><span className="hidden sm:inline">Official notice</span></span>
          ) : (
            <span className="truncate">Official notice</span>
          )}
          <ArrowUpRight aria-hidden="true" className={cn("size-[18px] shrink-0", crowded && "hidden sm:block")} />
          <span className="sr-only"> (opens {hostOf(recall.url) || agencyOf(recall.source)})</span>
        </a>
      )}
    </div>
  );
}

/* ───────────────────────────── the sheet body ──────────────────────────── */

/**
 * @param {object}   props.recall
 * @param {object}   [props.loc]               { state, stateAbbr } or null
 * @param {string}   [props.eyebrow]           "Shared with you"
 * @param {object[]} [props.freshness]         freshnessOf() entries
 * @param {Function} [props.onRequestLocation] () => void
 */
export default function RecallDetail({ recall, loc, eyebrow, freshness, onRequestLocation }) {
  const L = resolveLoc(loc);
  const v = verdictFor(recall, L);
  const cov = coverageOf(recall);
  const agency = agencyOf(recall.source);
  const Icon = VERDICT_ICON[v.verdict] || CircleHelp;
  const needsLoc = v.verdict === VERDICTS.NEEDS_LOCATION;
  const announced = isAnnounced(recall);
  const where = coverageLine(recall);
  const verdictHead = needsLoc ? where : v.headline;
  const fresh = (freshness || []).find((e) => e.source === freshKey(recall.source));
  const asOf = fresh && fresh.asOf ? fmtAsOf(fresh.asOf) : "";
  const evidence = OUR_PLACEHOLDERS.test(String(v.evidence || "").trim()) ? "" : v.evidence;
  const info = classInfo(recall);
  const todo = whatToDo(recall);
  const term = followTermFor(recall);
  const photo = usePhoto(recall);
  const ended = v.verdict === VERDICTS.ENDED;
  const serious = recall.severity === "high" && !ended && !announced;
  const upcs = (Array.isArray(recall.upcs) && recall.upcs.length ? recall.upcs : recallUpcs(recall)).slice(0, 8);
  const hazard = hazardLabel(recall);
  const headline = plainHeadline(recall) || unclip(recall.product) || "Recall notice";

  const dates = [
    recall.posted && ["Published", fmtDay(recall.posted)],
    recall.date && fmtDay(recall.date) !== fmtDay(recall.posted) && ["Recall started", fmtDay(recall.date)],
    recall.endDate && ["Ended", fmtDay(recall.endDate)],
  ].filter(Boolean);
  if (!dates.length && recall.date) dates.push(["Date", fmtDay(recall.date)]);

  return (
    <article className="px-5 pb-32 pt-2 sm:px-7 sm:pt-7" aria-labelledby="recall-title">
      {/* A real photo gets the top of the sheet. Without one, a category tile
          is recognition, not information, so it stays small and the title and
          the verdict move up into the first screen. */}
      {photo ? (
        <>
          <Hero recall={recall} photo={photo} />
          {eyebrow && <p className="mt-5 text-[13px] font-semibold text-mint">{eyebrow}</p>}
        </>
      ) : (
        <div className="flex min-h-11 items-center gap-3 pr-12">
          <RecallThumb recall={recall} size="sm" />
          <p className="min-w-0 text-[13px] font-medium leading-snug text-fog">
            {eyebrow && <span className="block font-semibold text-mint">{eyebrow}</span>}
            {kindLabel(recall)} · {agency}
          </p>
        </div>
      )}
      <h2 id="recall-title" className={cn("title-1 text-paper", photo && eyebrow ? "mt-1" : "mt-4")}>{headline}</h2>
      {recall.firm && <p className="mt-1.5 text-[15px] leading-snug text-fog">{recall.firm}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {serious && (
          <span className="inline-flex items-center rounded-full bg-alert-soft px-2.5 py-0.5 text-[12px] font-semibold text-alert shadow-[inset_0_0_0_1px_var(--rr-alert-line)]">
            Serious
          </span>
        )}
        {announced ? <AnnouncedBadge /> : <ClassBadge recall={recall} />}
        {ended && <Badge variant="scope">Ended</Badge>}
        <Badge variant="source">{recall.source}</Badge>
      </div>

      {/* The verdict: one plain block, in ink. */}
      <div className="mt-5 rounded-3xl bg-sunken p-4 sm:p-5" role="group" aria-label="For your state">
        <p className="flex items-start gap-2.5 text-[17px] font-semibold leading-snug text-paper">
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fog" />
          <span className="verdict-line">{verdictHead}</span>
        </p>
        {!needsLoc && (
          <p className="mt-1.5 pl-[30px] text-[14.5px] leading-relaxed text-fog">{v.detail}</p>
        )}
        {v.note && <p className="mt-1.5 pl-[30px] text-[13px] leading-snug text-subtle">{v.note}</p>}
        {v.verdict === VERDICTS.NOT_LISTED && (
          <p className="mt-1.5 pl-[30px] text-[12.5px] leading-snug text-subtle">
            Distribution as published by {agency}{asOf ? <>; data as of <span className="whitespace-nowrap">{asOf}.</span></> : "."}
          </p>
        )}
        {needsLoc && onRequestLocation && (
          <div className="mt-2 pl-[30px]">
            <Button type="button" size="sm" variant="secondary" onClick={onRequestLocation}>
              <MapPin aria-hidden="true" /> Check your state
            </Button>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <Section title="Where it went">
          {evidence ? (
            <Quote who={agency === "CPSC" ? "Where the CPSC notice says it was sold" : `Distribution, as the ${agency} notice gives it`}>
              {evidence}
            </Quote>
          ) : (
            <p className="text-[14px] leading-relaxed text-fog">The {agency} notice gives no distribution at all.</p>
          )}
          {agency === "CPSC" && (
            <p className="mt-2 text-[12.5px] leading-snug text-subtle">
              CPSC recalls products sold across the country and never limits a notice to particular states.
            </p>
          )}
          <StateMap className="mt-4" kind={cov.kind} states={cov.states} userState={L && L.stateAbbr} />
        </Section>

        <Section title="What happened">
          {hazard && <p className="text-[15px] font-medium leading-snug text-paper">{hazard}</p>}
          {recall.reason && (
            <div className="mt-2.5">
              <Quote who={`The ${agency} notice${clipped(recall.reason) ? " (shortened — the full text is in the official notice)" : ""}`}>
                {unclip(recall.reason)}
              </Quote>
            </div>
          )}
          {info && (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] leading-relaxed text-fog">
              <ClassBadge recall={recall} />
              <span>{info.plain.charAt(0).toUpperCase() + info.plain.slice(1)}. Assigned by {info.agency}.</span>
            </p>
          )}
        </Section>

        <Section title="What to do">
          <ol className="flex flex-col gap-2">
            {todo.steps.map((step, i) => (
              <li key={step} className="flex items-start gap-3 text-[15px] leading-snug text-paper">
                <span aria-hidden="true" className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-[12px] font-semibold text-fog">{i + 1}</span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
          {ended && (
            <p className="mt-3 text-[13px] leading-snug text-subtle">
              The agency has closed this recall. Products bought before then can still be in a cupboard or freezer.
            </p>
          )}
        </Section>

        <RecallAssist recall={recall} />

        <Section title="How to identify it">
          <dl className="flex flex-col gap-3 text-[14px] leading-relaxed">
            <div>
              <dt className="microlabel">Product, as the notice describes it</dt>
              <dd className="mt-0.5 text-paper [overflow-wrap:anywhere]">
                {unclip(recall.product) || "Not given"}{clipped(recall.product) && "…"}
              </dd>
            </div>
            {todo.lot && (
              <div>
                <dt className="microlabel">Lot and code information</dt>
                <dd className="mt-0.5 text-paper [overflow-wrap:anywhere]">{todo.lot}</dd>
              </div>
            )}
            {upcs.length > 0 && (
              <div>
                <dt className="microlabel">Barcodes in the notice</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {upcs.map((u) => (
                    <span key={u} className="tnum rounded-full bg-sunken px-2.5 py-1 text-[13px] text-paper">{u}</span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          {(clipped(recall.product) || !todo.lot) && (
            <p className="mt-3 text-[12.5px] leading-snug text-subtle">
              Lot numbers, sizes and best-by dates are in the official notice — compare them with your package before deciding it is yours.
            </p>
          )}
        </Section>

        <section className="border-t border-line pt-3">
          {dates.length > 0 && (
            <dl className="divide-y divide-line">
              {dates.map(([k, d]) => (
                <div key={k} className="flex min-h-11 items-center justify-between gap-3 text-[14px]">
                  <dt className="text-fog">{k}</dt>
                  <dd className="tnum font-medium text-paper">{d}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="-mx-3 mt-2 flex flex-col">
            {!watchInBar(recall) && <WatchButton recall={recall} variant="row" />}
            <FollowRow term={term} />
          </div>
        </section>
      </div>
    </article>
  );
}
