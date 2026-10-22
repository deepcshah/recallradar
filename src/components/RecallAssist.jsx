import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ListChecks, Phone, RotateCcw, ShoppingBag, Sparkles } from "lucide-react";
import { assistTasksFor, safeHttpUrl, shopSearchUrl } from "@/lib/assist";
import { agencyOf } from "@/components/VerdictCard";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * GET HELP — the recall assistant, inside the sheet
 *
 *   ┌ ✦ Get help ─────────────────────────────────┐
 *   │ [≡ What do I do with mine?  ›]              │  task = next
 *   │ [🛍 Find something like it   ›]              │  task = alts (CPSC only)
 *   └─────────────────────────────────────────────┘
 *
 * One tap runs the task (api/_lib/assist.js) and the card it was in becomes
 * the answer: steps and a contact for `next`, a short list with shopping
 * searches for `alts`. Every answer says it was written by AI from the
 * notice and the web, and shows the pages it used — the official notice
 * stays the authority, one tap below.
 *
 * Offered only where it earns its place (src/lib/assist.js): physical
 * products and medical devices. A recalled lettuce needs no assistant.
 * Answers are kept for the session so reopening the sheet doesn't re-run.
 * ───────────────────────────────────────────────────────────────────────── */

const TASKS = {
  next: {
    icon: ListChecks,
    label: "What do I do with mine?",
    hint: "Refund or repair, who to contact, how to dispose of it",
    working: (agency) => `Reading the ${agency} notice and the company's recall page…`,
  },
  alts: {
    icon: ShoppingBag,
    label: "Find something like it",
    hint: "Replacements that aren't under a recall",
    working: () => "Looking for replacements and checking them for recalls…",
  },
};

const REMEDY = {
  refund: "Refund",
  replacement: "Free replacement",
  repair: "Free repair",
  refund_or_replacement: "Refund or replacement",
  dispose: "Dispose of it",
  stop_using: "Stop using it",
};

function cacheKey(id, task) {
  return `rr-assist:${id}:${task}`;
}
function readCache(id, task) {
  try {
    const s = sessionStorage.getItem(cacheKey(id, task));
    return s ? JSON.parse(s) : null;
  } catch (_) {
    return null;
  }
}
function writeCache(id, task, body) {
  try { sessionStorage.setItem(cacheKey(id, task), JSON.stringify(body)); } catch (_) { /* memory only */ }
}

function useAssist(recall, task) {
  const [state, setState] = useState(() => {
    const hit = readCache(recall.id, task);
    return hit ? { status: "done", body: hit } : { status: "idle" };
  });
  const ctrl = useRef(null);
  useEffect(() => () => ctrl.current && ctrl.current.abort(), []);

  const run = async () => {
    if (ctrl.current) ctrl.current.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ status: "working" });
    const started = Date.now();
    track("assist_requested", { task, source: recall.source || null });
    try {
      const qs = new URLSearchParams({ format: "assist", id: recall.id, task });
      const res = await fetch(`/api/share?${qs}`, { signal: ac.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ status: res.status === 503 ? "unavailable" : "error" });
        track("assist_failed", { task, status: res.status });
        return;
      }
      writeCache(recall.id, task, body);
      setState({ status: "done", body });
      track("assist_done", { task, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (err) {
      if (err && err.name === "AbortError") return;
      setState({ status: "error" });
      track("assist_failed", { task, status: 0 });
    }
  };
  return [state, run];
}

function Sources({ sources }) {
  const list = (sources || []).filter((s) => safeHttpUrl(s.url));
  if (!list.length) return null;
  return (
    <div className="mt-3">
      <p className="microlabel">Sources</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {list.map((s) => (
          <li key={s.url} className="min-w-0">
            <a href={safeHttpUrl(s.url)} target="_blank" rel="noopener noreferrer nofollow"
               className="block truncate text-[12.5px] text-fog underline-offset-2 hover:underline">
              {s.title || new URL(s.url).hostname}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NextAnswer({ r }) {
  const remedy = REMEDY[r.remedy];
  const c = r.contact || {};
  const contactUrl = safeHttpUrl(c.url);
  return (
    <>
      {remedy && (
        <span className="inline-flex rounded-full bg-mint-soft px-2.5 py-0.5 text-[12px] font-semibold text-mint">{remedy}</span>
      )}
      {r.summary && <p className="mt-2 text-[15px] leading-snug text-paper">{r.summary}</p>}
      {r.steps && r.steps.length > 0 && (
        <ol className="mt-3 flex flex-col gap-2.5">
          {r.steps.map((s, i) => (
            <li key={`${i}-${s.title}`} className="flex items-start gap-3">
              <span aria-hidden="true" className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-panel-3 text-[12px] font-semibold text-fog">{i + 1}</span>
              <span className="min-w-0 pt-0.5">
                <span className="block text-[14.5px] font-medium leading-snug text-paper">{s.title}</span>
                {s.detail && <span className="mt-0.5 block text-[13.5px] leading-snug text-fog">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {r.deadline && <p className="mt-3 text-[13px] text-fog"><span className="font-semibold text-paper">Deadline:</span> {r.deadline}</p>}
      {(c.phone || contactUrl) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {c.phone && (
            <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}
               className="press inline-flex min-h-10 items-center gap-2 rounded-full bg-panel-3 px-3.5 text-[13.5px] font-semibold text-paper">
              <Phone aria-hidden="true" className="size-4" /> {c.name ? `${c.name} · ` : ""}{c.phone}
            </a>
          )}
          {contactUrl && (
            <a href={contactUrl} target="_blank" rel="noopener noreferrer nofollow"
               className="press inline-flex min-h-10 items-center gap-2 rounded-full bg-panel-3 px-3.5 text-[13.5px] font-semibold text-paper">
              Claim page <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          )}
        </div>
      )}
      {c.hours && <p className="mt-1.5 text-[12.5px] text-subtle">{c.hours}</p>}
    </>
  );
}

function AltsAnswer({ r }) {
  return (
    <>
      {r.summary && <p className="text-[15px] leading-snug text-paper">{r.summary}</p>}
      {r.lookFor && r.lookFor.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {r.lookFor.map((f) => (
            <li key={f} className="rounded-full bg-panel-3 px-2.5 py-1 text-[12.5px] text-paper">{f}</li>
          ))}
        </ul>
      )}
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {(r.items || []).map((it) => {
          const href = shopSearchUrl(it.search || `${it.brand} ${it.name}`);
          return (
            <li key={`${it.brand}-${it.name}`} className="flex items-start gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium leading-snug text-paper">
                  {it.brand ? `${it.brand} ` : ""}{it.name}
                  {it.price && <span className="tnum ml-1.5 whitespace-nowrap text-[13px] font-normal text-subtle">{it.price}</span>}
                </span>
                {it.why && <span className="mt-0.5 block text-[13.5px] leading-snug text-fog">{it.why}</span>}
              </span>
              {href && (
                <a href={href} target="_blank" rel="noopener noreferrer nofollow"
                   aria-label={`Shop for ${it.brand} ${it.name}`}
                   className="press inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-panel-3 px-3 text-[13px] font-semibold text-paper">
                  Shop <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[12.5px] leading-snug text-subtle">
        Before you buy, search the model on Yanked — new recalls are added every day.
      </p>
    </>
  );
}

function TaskCard({ recall, task }) {
  const t = TASKS[task];
  const Icon = t.icon;
  const [state, run] = useAssist(recall, task);
  const agency = agencyOf(recall.source);

  if (state.status === "idle") {
    return (
      <button type="button" onClick={run}
              className="press flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-panel-3 text-fog">
          <Icon aria-hidden="true" className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-paper">{t.label}</span>
          <span className="block text-[12.5px] text-subtle">{t.hint}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-2xl bg-panel-2 p-3.5 shadow-[inset_0_0_0_1px_var(--rr-line)]" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-fog">
        <Icon aria-hidden="true" className="size-4" /> {t.label}
      </p>
      <div className="mt-2.5">
        {state.status === "working" && (
          <div role="status">
            <p className="text-[14px] leading-snug text-paper">{t.working(agency)}</p>
            <p className="mt-0.5 text-[12.5px] text-subtle">This can take up to a minute.</p>
            <div aria-hidden="true" className="mt-3 flex flex-col gap-2">
              <span className="shimmer block h-3.5 w-11/12 rounded-full" />
              <span className="shimmer block h-3.5 w-9/12 rounded-full" />
              <span className="shimmer block h-3.5 w-10/12 rounded-full" />
            </div>
          </div>
        )}
        {state.status === "unavailable" && (
          <p className="text-[14px] leading-snug text-fog">The assistant isn't switched on here yet. The official notice has the remedy and contact details.</p>
        )}
        {state.status === "error" && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[14px] leading-snug text-fog">Couldn't finish that one.</p>
            <button type="button" onClick={run}
                    className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-panel-3 px-3 text-[13px] font-semibold text-paper">
              <RotateCcw aria-hidden="true" className="size-3.5" /> Try again
            </button>
          </div>
        )}
        {state.status === "done" && state.body && (
          <>
            {task === "next" ? <NextAnswer r={state.body.result || {}} /> : <AltsAnswer r={state.body.result || {}} />}
            <Sources sources={(state.body.result || {}).sources} />
            <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-subtle">
              <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              Written by AI from the {agency} notice and the web. Check the official notice before acting on it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** The "Get help" section, or nothing for a recall it isn't offered on. */
export default function RecallAssist({ recall, className }) {
  const tasks = assistTasksFor(recall);
  if (!recall || !recall.id || !tasks.length) return null;
  return (
    <section className={cn("border-t border-line pt-5", className)} aria-labelledby="assist-title">
      <h3 id="assist-title" className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.015em] text-paper">
        <Sparkles aria-hidden="true" className="size-[18px] text-mint" /> Get help
      </h3>
      <p className="mt-1 text-[13px] leading-snug text-subtle">Reads the notice and the company's site for you.</p>
      <div className="-mx-3 mt-2 flex flex-col gap-2">
        {tasks.map((t) => <TaskCard key={t} recall={recall} task={t} />)}
      </div>
    </section>
  );
}
