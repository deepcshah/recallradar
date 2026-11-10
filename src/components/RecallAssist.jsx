import { useEffect, useSyncExternalStore } from "react";
import {
  ArrowLeftRight, ArrowUpRight, Banknote, ChevronRight, ListChecks, LoaderCircle, OctagonX, Phone,
  RotateCcw, ShoppingBag, Sparkles, Trash2, Wrench,
} from "lucide-react";
import { assistTasksFor, safeHttpUrl, shopSearchUrl } from "@/lib/assist";
import { agencyOf } from "@/components/VerdictCard";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * THE REMEDY, AND SOMETHING ELSE TO BUY — the recall assistant
 *
 * People open a recalled product to learn one thing: am I refunding,
 * repairing, or throwing it out? So the answer is not a tile to find:
 *
 *   sheet opens ──► `next` starts at once (api/_lib/assist.js reads the
 *                   notice and the company's recall page)
 *
 *   footer       [↗] [ ⟳ Finding your remedy…        ] [Notice ↗]
 *                [↗] [ $ Get your refund             ] [Notice ↗]   ← the
 *                      tap: scrolls to the plan          remedy IS the
 *                                                        primary action
 *   ┌ What to do ─────────────────────────────────┐
 *   │ $  Get your refund                           │  PlanCard: the generic
 *   │    Stop using it now. ONTHEWEI refunds …     │  steps until the answer
 *   │ 1  Check it's the recalled seat              │  arrives, then the
 *   │ 2  Cut it and send a photo                   │  remedy, its steps and
 *   │ [☎ 1-800-…] [Claim page ↗]                   │  who to contact
 *   └──────────────────────────────────────────────┘
 *   Shop an alternative ›                            ShopAlternative: on
 *                                                    tap, CPSC only
 *
 * One answer per recall and task, shared by the footer and the card
 * (a small store below, kept for the session), so the notice is read once.
 * Every answer says it was written by AI from the notice and the web, and
 * names its sources; the official notice stays one tap away.
 * ───────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────── the store ───────────────────────────── */

const store = new Map(); // `${id}:${task}` -> { status, body }
const listeners = new Set();
const IDLE = { status: "idle", body: null };

function cacheKey(id, task) { return `rr-assist:${id}:${task}`; }
function readCache(id, task) {
  try { const s = sessionStorage.getItem(cacheKey(id, task)); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function writeCache(id, task, body) {
  try { sessionStorage.setItem(cacheKey(id, task), JSON.stringify(body)); } catch (_) { /* memory only */ }
}
function get(id, task) {
  const k = `${id}:${task}`;
  if (!store.has(k)) {
    const hit = readCache(id, task);
    store.set(k, hit ? { status: "done", body: hit } : IDLE);
  }
  return store.get(k);
}
function set(id, task, v) {
  store.set(`${id}:${task}`, v);
  listeners.forEach((l) => l());
}

/** Start (or retry) a task. A run already in flight or finished is kept. */
export async function runAssist(recall, task, { retry = false } = {}) {
  const cur = get(recall.id, task);
  if (cur.status === "working" || cur.status === "done" || (cur.status === "unavailable" && !retry)) return;
  set(recall.id, task, { status: "working", body: null });
  const started = Date.now();
  track("assist_requested", { task, source: recall.source || null });
  try {
    const qs = new URLSearchParams({ format: "assist", id: recall.id, task });
    const res = await fetch(`/api/share?${qs}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      set(recall.id, task, { status: res.status === 503 ? "unavailable" : "error", body: null });
      track("assist_failed", { task, status: res.status });
      return;
    }
    writeCache(recall.id, task, body);
    set(recall.id, task, { status: "done", body });
    track("assist_done", { task, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (_) {
    set(recall.id, task, { status: "error", body: null });
    track("assist_failed", { task, status: 0 });
  }
}

/** { status: idle|working|done|error|unavailable, body } for one task. */
export function useAssist(recall, task) {
  const id = recall && recall.id;
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => (id ? get(id, task) : IDLE),
    () => IDLE,
  );
}

/* ──────────────────────────────── the remedy ──────────────────────────── */

/* The remedy as an action — what the footer button says. Verb first: the
 * button is something to do, not a category. */
const REMEDY = {
  refund: { label: "Get your refund", Icon: Banknote },
  replacement: { label: "Get a free replacement", Icon: ArrowLeftRight },
  repair: { label: "Get the free repair", Icon: Wrench },
  refund_or_replacement: { label: "Get a refund or replacement", Icon: Banknote },
  dispose: { label: "Throw it out safely", Icon: Trash2 },
  stop_using: { label: "Stop using it", Icon: OctagonX },
};
/* What the company's link does, by remedy. */
const CLAIM = {
  refund: "Claim your refund",
  replacement: "Claim your replacement",
  repair: "Request the repair",
  refund_or_replacement: "Make a claim",
};

export function remedyAction(remedy) {
  return REMEDY[remedy] || { label: "See what to do", Icon: ListChecks };
}

const planEl = () => (typeof document !== "undefined" ? document.getElementById("recall-plan") : null);

/** The footer's primary action for a recall the assistant covers, or null
 *  (not offered, or switched off here — the bar then keeps Share primary). */
export function RemedyButton({ recall, className }) {
  const offered = assistTasksFor(recall).includes("next");
  const s = useAssist(recall, "next");
  if (!offered || s.status === "unavailable") return null;
  const r = s.status === "done" && s.body ? remedyAction(s.body.result && s.body.result.remedy) : null;
  const working = s.status === "working" || s.status === "idle";
  const Icon = r ? r.Icon : working ? LoaderCircle : ListChecks;
  const label = r ? r.label : working ? "Finding your remedy…" : "What do I do?";
  return (
    <button
      type="button"
      onClick={() => {
        if (s.status === "error") runAssist(recall, "next", { retry: true });
        const el = planEl();
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        track("remedy_button_clicked", { state: s.status, remedy: (r && s.body.result.remedy) || null });
      }}
      className={cn(
        "inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-full bg-mint px-5 text-[15px] font-semibold text-mint-ink shadow-[var(--rr-shadow-2)] transition-transform active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rr-surface)]",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("size-[18px] shrink-0", working && !r && "animate-spin")} />
      <span className="truncate" aria-live="polite">{label}</span>
    </button>
  );
}

function Sources({ sources, agency }) {
  const list = (sources || []).filter((s) => safeHttpUrl(s.url));
  return (
    <details className="group mt-4 text-[12.5px] leading-snug text-subtle">
      <summary className="flex cursor-pointer list-none items-start gap-1.5 [&::-webkit-details-marker]:hidden">
        <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0 text-mint" />
        <span>
          Written by AI from the {agency} notice and the web — check the official notice before acting.
          {list.length > 0 && <span className="ml-1 font-semibold text-fog underline-offset-2 group-open:hidden hover:underline">Sources ({list.length})</span>}
        </span>
      </summary>
      {list.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 pl-5">
          {list.map((s) => (
            <li key={s.url} className="min-w-0">
              <a href={safeHttpUrl(s.url)} target="_blank" rel="noopener noreferrer nofollow"
                 className="block truncate text-fog underline-offset-2 hover:underline">
                {s.title || new URL(s.url).hostname}
              </a>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Steps({ steps, rich }) {
  if (!steps || !steps.length) return null;
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const title = rich ? s.title : s;
        const detail = rich ? s.detail : "";
        return (
          <li key={`${i}-${title}`} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
            <span aria-hidden="true" className="tnum grid size-6 place-items-center rounded-full bg-sunken text-[12px] font-semibold text-fog">{i + 1}</span>
            <span className="min-w-0 pt-0.5">
              <span className="block text-[15px] font-medium leading-snug text-paper">{title}</span>
              {detail && <span className="mt-0.5 block text-[14px] leading-snug text-fog">{detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The sheet's "What to do" card. For a recall the assistant covers it starts
 * the run as the sheet opens and shows the generic steps under a progress
 * line until the remedy arrives; for everything else it is the generic
 * steps, with the first one as the headline.
 *
 * @param {object}   props.recall
 * @param {object}   props.todo    whatToDo(recall): { steps: string[] }
 * @param {boolean}  [props.ended]
 */
export function PlanCard({ recall, todo, ended, className }) {
  const offered = assistTasksFor(recall).includes("next");
  const s = useAssist(recall, "next");
  useEffect(() => {
    if (offered && recall && recall.id) runAssist(recall, "next");
  }, [offered, recall && recall.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const agency = agencyOf(recall.source);
  const r = offered && s.status === "done" && s.body ? s.body.result || {} : null;
  const generic = (todo && todo.steps) || [];

  const plan = r
    ? { ...remedyAction(r.remedy), sub: r.summary }
    : { Icon: OctagonX, label: generic[0] || "Stop using it", sub: "" };
  const PlanIcon = plan.Icon;
  const c = (r && r.contact) || {};
  const contactUrl = safeHttpUrl(c.url);

  return (
    <section id="recall-plan" className={cn("scroll-mt-20 rounded-3xl bg-panel-2 p-4 shadow-[var(--rr-shadow-1),inset_0_0_0_1px_var(--rr-line)] sm:p-5", className)}
             aria-labelledby="plan-title" aria-busy={offered && s.status === "working" ? true : undefined}>
      <p className="microlabel">What to do</p>
      <h3 id="plan-title" className="mt-1.5 flex items-start gap-2.5 text-[20px] font-semibold leading-tight tracking-[-0.02em] text-paper">
        <span className={cn("mt-px grid size-7 shrink-0 place-items-center rounded-lg", r ? "bg-mint text-mint-ink" : "bg-paper text-[var(--rr-surface)]")}>
          <PlanIcon aria-hidden="true" className="size-4" />
        </span>
        <span>{plan.label}</span>
      </h3>
      {plan.sub && <p className="mt-2 text-[15px] leading-snug text-paper/90">{plan.sub}</p>}

      {offered && (s.status === "working" || s.status === "idle") && (
        <div className="mt-3 rounded-2xl bg-mint-soft px-3.5 py-3" role="status">
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-paper">
            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-mint" />
            Finding your remedy — reading the {agency} notice and the company's recall page
          </p>
          <div aria-hidden="true" className="mt-2.5 flex flex-col gap-1.5 pl-6">
            <span className="shimmer block h-2.5 w-11/12 rounded-full" />
            <span className="shimmer block h-2.5 w-8/12 rounded-full" />
          </div>
        </div>
      )}

      <div className="mt-4">
        {r ? <Steps steps={r.steps} rich /> : <Steps steps={generic.slice(1)} />}
      </div>

      {r && r.deadline && (
        <p className="mt-3 text-[13.5px] text-fog"><span className="font-semibold text-paper">Deadline:</span> {r.deadline}</p>
      )}
      {r && (c.phone || contactUrl) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {contactUrl && (
            <a href={contactUrl} target="_blank" rel="noopener noreferrer nofollow"
               className="press inline-flex min-h-11 items-center gap-2 rounded-full bg-paper px-4 text-[14px] font-semibold text-[var(--rr-surface)]">
              {CLAIM[r.remedy] || "Company recall page"} <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          )}
          {c.phone && (
            <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}
               className="press inline-flex min-h-11 items-center gap-2 rounded-full bg-sunken px-4 text-[14px] font-semibold text-paper">
              <Phone aria-hidden="true" className="size-4" /> {c.phone}
            </a>
          )}
        </div>
      )}
      {r && c.hours && <p className="mt-1.5 text-[12.5px] text-subtle">{c.name ? `${c.name} · ` : ""}{c.hours}</p>}

      {ended && (
        <p className="mt-3 text-[13px] leading-snug text-subtle">
          The agency has closed this recall. Products bought before then can still be in a cupboard or freezer.
        </p>
      )}
      {offered && s.status === "error" && (
        <button type="button" onClick={() => runAssist(recall, "next", { retry: true })}
                className="mt-3 inline-flex min-h-9 items-center gap-1.5 text-[13.5px] font-semibold text-mint hover:underline">
          <RotateCcw aria-hidden="true" className="size-3.5" /> Couldn't read the notice just now — try again
        </button>
      )}
      {r && <Sources sources={r.sources} agency={agency} />}
    </section>
  );
}

/* ───────────────────────────── shop an alternative ───────────────────── */

/** Consumer products only: a row that, tapped, becomes a short list of
 *  replacements with a shopping search each. Full width, its own section —
 *  never side by side with anything that changes height. */
export function ShopAlternative({ recall, className }) {
  const offered = assistTasksFor(recall).includes("alts");
  const s = useAssist(recall, "alts");
  /* Both tasks run on the same service: when the remedy came back "not
   * switched on here", don't offer a row that can only say the same. */
  const next = useAssist(recall, "next");
  if (!offered || next.status === "unavailable") return null;
  const r = s.status === "done" && s.body ? s.body.result || {} : null;
  const agency = agencyOf(recall.source);

  if (s.status === "idle") {
    return (
      <button type="button" onClick={() => runAssist(recall, "alts")}
              className={cn("press flex min-h-16 w-full items-center gap-3 rounded-2xl px-3 text-left hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint", className)}>
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-mint-soft text-mint">
          <ShoppingBag aria-hidden="true" className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold text-paper">Shop an alternative</span>
          <span className="block text-[13px] text-subtle">Similar products that aren't under a recall</span>
        </span>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-subtle" />
      </button>
    );
  }

  return (
    <section className={cn("rounded-3xl bg-panel-2 p-4 shadow-[inset_0_0_0_1px_var(--rr-line)] sm:p-5", className)} aria-labelledby="alts-title" aria-live="polite">
      <h3 id="alts-title" className="flex items-center gap-2 text-[17px] font-semibold text-paper">
        <ShoppingBag aria-hidden="true" className="size-[18px] text-mint" /> Shop an alternative
      </h3>
      {s.status === "working" && (
        <div role="status" className="mt-3">
          <p className="flex items-center gap-2 text-[14px] text-paper">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-mint" /> Looking for replacements and checking them for recalls…
          </p>
          <div aria-hidden="true" className="mt-3 flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="flex-1 space-y-1.5"><span className="shimmer block h-3 w-7/12 rounded-full" /><span className="shimmer block h-2.5 w-10/12 rounded-full" /></span>
                <span className="shimmer block h-9 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      )}
      {s.status === "unavailable" && <p className="mt-2 text-[14px] leading-snug text-fog">Not switched on here yet.</p>}
      {s.status === "error" && (
        <button type="button" onClick={() => runAssist(recall, "alts", { retry: true })}
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-[13.5px] font-semibold text-mint hover:underline">
          <RotateCcw aria-hidden="true" className="size-3.5" /> Couldn't finish — try again
        </button>
      )}
      {r && (
        <>
          {r.summary && <p className="mt-2 text-[15px] leading-snug text-paper/90">{r.summary}</p>}
          {r.lookFor && r.lookFor.length > 0 && (
            <div className="mt-3">
              <p className="microlabel">Look for</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {r.lookFor.map((f) => <li key={f} className="rounded-full bg-sunken px-2.5 py-1 text-[12.5px] text-paper">{f}</li>)}
              </ul>
            </div>
          )}
          <ul className="mt-3 divide-y divide-line">
            {(r.items || []).map((it) => {
              const href = shopSearchUrl(it.search || `${it.brand} ${it.name}`);
              return (
                <li key={`${it.brand}-${it.name}`} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold leading-snug text-paper">
                      {it.brand ? `${it.brand} ` : ""}{it.name}
                    </span>
                    {it.why && <span className="mt-0.5 block text-[13.5px] leading-snug text-fog">{it.why}</span>}
                    {it.price && <span className="tnum mt-0.5 block text-[13px] text-subtle">{it.price}</span>}
                  </span>
                  {href && (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Shop for ${it.brand} ${it.name}`}
                       className="press inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full bg-paper px-3.5 text-[13.5px] font-semibold text-[var(--rr-surface)]">
                      Shop <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[12.5px] leading-snug text-subtle">Search the model on Yanked before you buy — new recalls are added every day.</p>
          <Sources sources={r.sources} agency={agency} />
        </>
      )}
    </section>
  );
}

/** Kept for callers that want both pieces together. */
export default function RecallAssist({ recall, todo, ended, className }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <PlanCard recall={recall} todo={todo} ended={ended} />
      <ShopAlternative recall={recall} />
    </div>
  );
}
