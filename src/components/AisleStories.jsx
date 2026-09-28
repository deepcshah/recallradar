/* ─────────────────────────────────────────────────────────────────────────
 * AISLE STORIES — one recall per screen, the way people already read news
 *
 * The home digest's aisle rail opens this: a full-screen, tap-through viewer
 * with one recall per story. It exists because a list of 40 notices is read
 * by nobody past the fifth, while a sequence you can flick through with a
 * thumb gets finished — and "finished" is the point, since the end card is
 * the only place this app says "you've seen them all".
 *
 * What a story says, top to bottom, and why:
 *
 *   - The hazard, large. It's what makes someone put the thing down.
 *   - The product, then one line of where (verdictFor's headline), so the
 *     wording can't drift from the recall sheet, the share card or a push.
 *   - "What to do", generic by kind of thing (digest.js whatToDo). No
 *     specifics the notice didn't give; when it did give codes, they are
 *     shown verbatim as "Check lot: …", truncated rather than paraphrased.
 *
 * Gestures, deliberately the Instagram set because nobody has to learn it:
 * tap the right two thirds to advance and the left third to go back,
 * press-and-hold to pause, swipe down (or Esc) to close, arrow keys on a
 * keyboard. Auto-advance is ~6s — and OFF under prefers-reduced-motion,
 * where content that moves on by itself is exactly what was asked not to
 * happen (WCAG 2.2.2); the progress bars still show where you are.
 *
 * Severity colour appears only on the classification badge, as everywhere
 * else. The end card is grey and plain: "caught up" is a statement about
 * what we showed you, not an all-clear.
 * ───────────────────────────────────────────────────────────────────────── */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Armchair, Baby, Beef, Bell, Carrot, ChevronLeft, ChevronRight, Inbox, MapPin, Milk,
  PawPrint, Pill, Wheat, X, ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { verdictFor, resolveLoc } from "@/lib/verdict";
import { severityLabel, severityVariant } from "@/lib/classification";
import { hazardLabel, shortProduct, whatToDo, markSeen, getSeen, dayOf } from "@/lib/digest";
import { cn } from "@/lib/utils";

export const AISLE_ICONS = {
  produce: Carrot, meat: Beef, dairy: Milk, bakery: Wheat,
  baby: Baby, pet: PawPrint, meds: Pill, home: Armchair,
};

export const STORY_MS = 6000;
/* Under this a press is a tap; over it, a hold that paused the story and
 * must not also advance it when the finger lifts. */
const HOLD_MS = 220;
const SWIPE_CLOSE_PX = 90;

function fmtDay(d) {
  const day = dayOf(d);
  if (!day) return "";
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/* The progress fill is a CSS animation, not a timer driving React state 60
 * times a second: the browser runs it, `animation-play-state` pauses it for
 * free on hold, and `animationend` is the advance. One source of truth for
 * "how far through this story are we". */
const KEYFRAMES = `@keyframes rr-story-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }`;

function StoryMedia({ record, aisleKey }) {
  const [broken, setBroken] = useState(false);
  const Icon = AISLE_ICONS[aisleKey] || Inbox;
  if (record.image && !broken) {
    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-white">
        <img
          src={record.image}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className="max-h-full max-w-full select-none object-contain"
        />
      </div>
    );
  }
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-2xl border border-line bg-sunken"
      style={{ backgroundImage: "radial-gradient(circle at 50% 40%, var(--rr-card) 0%, transparent 70%)" }}
      aria-hidden="true"
    >
      <Icon className="size-20 text-subtle" strokeWidth={1.25} />
    </div>
  );
}

function RecallStory({ record, aisleKey, loc, onOpenRecall }) {
  const verdict = verdictFor(record, loc);
  const todo = whatToDo(record);
  const ended = verdict.verdict === "ended";
  const what = todo.steps.map((s, i) => (i ? s.charAt(0).toLowerCase() + s.slice(1) : s)).join("; ");
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="min-h-0 flex-[1_1_38%]">
        <StoryMedia record={record} aisleKey={aisleKey} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={severityVariant(record)}>{severityLabel(record)}</Badge>
        <Badge variant="source">{record.source}</Badge>
        {ended && <Badge variant="scope">Ended</Badge>}
        {fmtDay(record.date) && <span className="tnum text-[11px] text-subtle">{fmtDay(record.date)}</span>}
      </div>
      <div className="space-y-1.5">
        <h3 className="text-[28px] font-bold leading-[1.1] tracking-tight text-paper sm:text-[32px]">
          {hazardLabel(record)}
        </h3>
        <p className="line-clamp-2 text-[15px] leading-snug text-fog" title={record.product}>
          {shortProduct(record.product, 12) || record.product}
          {record.firm ? <span className="text-subtle"> · {record.firm}</span> : null}
        </p>
      </div>
      <p className="flex items-start gap-1.5 text-sm font-semibold text-paper">
        <MapPin className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
        <span>{verdict.headline}</span>
      </p>
      <div className="rounded-xl border border-line bg-panel-2 p-3 text-sm leading-snug text-paper">
        <span className="font-semibold">What to do: </span>
        <span className="text-fog">{what}.</span>
        {todo.lot && (
          <p className="mt-1.5 break-words text-[13px] text-fog">
            <span className="font-semibold text-paper">Check lot: </span>
            <span className="tnum">{todo.lot}</span>
          </p>
        )}
      </div>
      <div className="mt-auto" data-story-control>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => onOpenRecall && onOpenRecall(record)}
        >
          Open the full notice <ExternalLink aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function EndCard({ place, onEnablePush, onClose }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
      <div className="flex size-16 items-center justify-center rounded-full border border-line bg-sunken">
        <Inbox className="size-7 text-subtle" aria-hidden="true" />
      </div>
      <h3 className="text-2xl font-bold tracking-tight text-paper">You're all caught up</h3>
      <p className="max-w-[30ch] text-sm leading-relaxed text-fog">
        That's every recent recall in these aisles{place ? ` for ${place}` : ""} that we know of.
        Agencies publish new notices every week.
      </p>
      <div className="mt-2 flex w-full max-w-xs flex-col gap-2" data-story-control>
        {onEnablePush && (
          <Button onClick={onEnablePush}>
            <Bell aria-hidden="true" /> Get a weekly heads-up
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

/**
 * Full-screen stories viewer.
 *
 * Props:
 *   open          boolean
 *   aisles        [{ key, label, records }] — digest.js aislesFor(); empty aisles are skipped
 *   startAisle    aisle key to open on (starts at its first unseen story)
 *   loc           { state, stateAbbr } | null — for verdictFor's one line
 *   onClose()     required
 *   onOpenRecall(record)  "Open the full notice"; the viewer closes first
 *   onEnablePush()        optional; the end card's "Get a weekly heads-up"
 *   onSeen(id)            optional; called after an id is written to rr-seen
 *   onCaughtUp()          optional; called once each time the end card is reached
 */
export default function AisleStories({ open, aisles, startAisle, loc, onClose, onOpenRecall, onEnablePush, onSeen, onCaughtUp }) {
  const reduce = useReducedMotion();

  /* One flat sequence across aisles, so "next" at the end of Meat is the
   * first of Dairy, and the end card is simply the last slot. */
  const seq = useMemo(() => {
    const out = [];
    for (const a of aisles || []) {
      const recs = (a.records || []).filter(Boolean);
      recs.forEach((record, i) => out.push({ aisle: a, record, i, n: recs.length }));
    }
    out.push({ end: true });
    return out;
  }, [aisles]);

  const firstPos = useCallback(() => {
    const seen = getSeen();
    const inAisle = seq.map((s, p) => [s, p]).filter(([s]) => !s.end && s.aisle.key === startAisle);
    if (!inAisle.length) return 0;
    const unseen = inAisle.find(([s]) => !seen.has(s.record.id));
    return (unseen || inAisle[0])[1];
  }, [seq, startAisle]);

  const [pos, setPos] = useState(0);
  const [dir, setDir] = useState(1);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dragY, setDragY] = useState(0);
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const press = useRef(null);

  /* Reset to the tapped aisle on the closed → open edge only. Re-running on
   * every new `aisles` array would yank the reader back to the start the
   * moment a late feed landed underneath them. */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPos(firstPos());
      setDir(1);
      setHeld(false);
      setDragY(0);
    }
    wasOpen.current = open;
  }, [open, firstPos]);

  const cur = seq[Math.min(pos, seq.length - 1)];

  const go = useCallback((delta) => {
    setDir(delta);
    setPos((p) => Math.max(0, Math.min(seq.length - 1, p + delta)));
  }, [seq.length]);

  const close = useCallback(() => { onClose && onClose(); }, [onClose]);

  // Seen is written as a story is SHOWN, not when it finishes: a reader who
  // taps past one has still seen it, and the ring should say so.
  // Keyed on the id, and onSeen read through a ref, so a parent that passes
  // a fresh callback each render can't turn this into a render loop.
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const curId = open && cur && !cur.end ? cur.record.id : null;
  useEffect(() => {
    if (!curId) return;
    markSeen([curId]);
    if (onSeenRef.current) onSeenRef.current(curId);
  }, [curId]);

  // The end card, reported once per arrival — paging back and forth over it
  // is one "caught up", not several.
  const onCaughtUpRef = useRef(onCaughtUp);
  onCaughtUpRef.current = onCaughtUp;
  const atEnd = Boolean(open && cur && cur.end);
  useEffect(() => {
    if (atEnd && onCaughtUpRef.current) onCaughtUpRef.current();
  }, [atEnd]);

  // Keyboard, focus, scroll lock — the dialog basics.
  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => panelRef.current && panelRef.current.focus({ preventScroll: true }), 0);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === " " && e.target === panelRef.current) { e.preventDefault(); setHeld((h) => !h); }
    };
    const onVis = () => setHidden(document.visibilityState === "hidden");
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      document.body.style.overflow = prevOverflow;
      const el = restoreRef.current;
      if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
    };
  }, [open, close, go]);

  /* Pointer handling on the stage. Controls inside a story (the buttons)
   * are marked data-story-control and opt out, so pressing "Open the full
   * notice" never also advances the story underneath it. */
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest && e.target.closest("[data-story-control]")) return;
    const timer = setTimeout(() => setHeld(true), HOLD_MS);
    press.current = { x: e.clientX, y: e.clientY, t: Date.now(), timer, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* older Safari */ }
  };
  const onPointerMove = (e) => {
    const p = press.current;
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 8 && Math.abs(dy) > Math.abs(e.clientX - p.x)) {
      clearTimeout(p.timer);
      setHeld(true);
      setDragY(dy);
    }
  };
  const endPress = (e, cancelled) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    const dy = e.clientY - p.y;
    const long = Date.now() - p.t >= HOLD_MS;
    setHeld(false);
    setDragY(0);
    if (cancelled) return;
    if (dy > SWIPE_CLOSE_PX) { close(); return; }
    if (long || Math.abs(dy) > 12) return;
    const box = e.currentTarget.getBoundingClientRect();
    go(e.clientX - box.left < box.width / 3 ? -1 : 1);
  };

  const running = open && !held && !hidden && !reduce && cur && !cur.end;
  const place = (resolveLoc(loc) || {}).stateAbbr || null;

  const variants = reduce
    ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }
    : {
      enter: (d) => ({ opacity: 0, x: d > 0 ? 28 : -28 }),
      center: { opacity: 1, x: 0 },
      exit: (d) => ({ opacity: 0, x: d > 0 ? -28 : 28 }),
    };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="rr-stories"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <style>{KEYFRAMES}</style>
          <div className="relative h-[100dvh] w-full sm:h-auto sm:w-[420px]">
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-roledescription="stories"
            aria-label={cur && !cur.end ? `${cur.aisle.label} recalls, ${cur.i + 1} of ${cur.n}` : "Recall stories"}
            className={cn(
              "relative flex h-[100dvh] w-full flex-col overflow-hidden bg-panel text-paper outline-none",
              "sm:h-[min(calc(100dvh_-_3rem),860px)] sm:max-w-[420px] sm:rounded-3xl sm:border sm:border-line sm:shadow-[var(--rr-shadow-3)]",
            )}
            initial={reduce ? { opacity: 0 } : { y: 40, opacity: 0 }}
            animate={{ y: dragY, opacity: dragY ? Math.max(0.4, 1 - dragY / 400) : 1 }}
            exit={reduce ? { opacity: 0 } : { y: 60, opacity: 0 }}
            transition={dragY ? { duration: 0 } : { type: "tween", ease: [0.32, 0.72, 0, 1], duration: reduce ? 0 : 0.3 }}
            style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)", touchAction: "none" }}
          >
            {/* Progress: one segment per story in the current aisle. */}
            <div className="flex gap-1 px-3 pt-3" aria-hidden="true">
              {cur && !cur.end
                ? Array.from({ length: cur.n }, (_, k) => (
                  <div key={k} className="h-[3px] flex-1 overflow-hidden rounded-full bg-line-strong/60">
                    <div
                      key={k === cur.i ? `a-${pos}` : k}
                      className="h-full origin-left rounded-full bg-paper"
                      style={
                        k < cur.i ? { transform: "scaleX(1)" }
                        : k > cur.i ? { transform: "scaleX(0)" }
                        : reduce ? { transform: "scaleX(1)" }
                        : {
                          animation: `rr-story-fill ${STORY_MS}ms linear forwards`,
                          animationPlayState: running ? "running" : "paused",
                        }
                      }
                      onAnimationEnd={k === cur.i ? () => go(1) : undefined}
                    />
                  </div>
                ))
                : <div className="h-[3px] flex-1 rounded-full bg-paper" />}
            </div>

            <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
              {cur && !cur.end ? (() => {
                const Icon = AISLE_ICONS[cur.aisle.key] || Inbox;
                return (
                  <>
                    <span className="flex size-8 items-center justify-center rounded-full border border-line bg-panel-2">
                      <Icon className="size-4 text-fog" aria-hidden="true" />
                    </span>
                    <span className="text-sm font-semibold">{cur.aisle.label}</span>
                    <span className="tnum text-xs text-subtle">{cur.i + 1} of {cur.n}</span>
                    {held && !reduce && <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Paused</span>}
                  </>
                );
              })() : <span className="text-sm font-semibold">Recalls near you</span>}
              <button
                type="button"
                data-story-control
                onClick={close}
                className="tap ml-auto flex size-9 items-center justify-center rounded-full text-fog hover:bg-panel-3 hover:text-paper"
                aria-label="Close stories"
              >
                <X className="size-5" />
              </button>
            </div>

            <div
              className="relative min-h-0 flex-1 select-none px-4 pb-4 pt-2"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endPress(e, false)}
              onPointerCancel={(e) => endPress(e, true)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <AnimatePresence initial={false} custom={dir} mode="popLayout">
                <motion.div
                  key={pos}
                  custom={dir}
                  variants={variants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: reduce ? 0 : 0.22, ease: [0.2, 0.7, 0.3, 1] }}
                  className="h-full"
                  aria-live="polite"
                >
                  {cur && cur.end
                    ? <EndCard place={place} onEnablePush={onEnablePush} onClose={close} />
                    : cur && (
                      <RecallStory
                        record={cur.record}
                        aisleKey={cur.aisle.key}
                        loc={loc}
                        onOpenRecall={(r) => { close(); onOpenRecall && onOpenRecall(r); }}
                      />
                    )}
                </motion.div>
              </AnimatePresence>
            </div>

          </motion.div>
          {/* Visible back/next for a mouse, where "tap the edge" has no
              affordance. Hidden on touch, where the gesture is the control.
              Outside the panel, which clips. */}
          <div className="pointer-events-none absolute inset-y-0 -left-16 -right-16 hidden items-center justify-between [@media(pointer:fine)]:sm:flex">
            <button
              type="button"
              data-story-control
              onClick={() => go(-1)}
              disabled={pos === 0}
              className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-line bg-panel-2 text-fog shadow-[var(--rr-bevel),var(--rr-shadow-1)] hover:text-paper disabled:opacity-30"
              aria-label="Previous story"
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              data-story-control
              onClick={() => go(1)}
              disabled={pos >= seq.length - 1}
              className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-line bg-panel-2 text-fog shadow-[var(--rr-bevel),var(--rr-shadow-1)] hover:text-paper disabled:opacity-30"
              aria-label="Next story"
            >
              <ChevronRight className="size-5" />
            </button>
          </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
