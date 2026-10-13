import { useEffect, useState } from "react";
import { BellPlus, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  followRecall, unfollowRecall, isFollowingRecall, FOLLOWS_EVENT, MAX_FOLLOWED_RECALLS,
} from "@/lib/follows";
import { recallSnapshot, isRecallId } from "@/lib/recall-watch";
import { recallData } from "@/lib/data-sync";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * "NOTIFY ME ABOUT UPDATES" — follow one specific recall
 *
 * Different from Follow <brand> beside it: that one watches for NEW recalls
 * naming a word; this one watches THIS notice for changes — the agency
 * closing it, adding states, reclassifying it, or (for a company press
 * release) FDA publishing the enforcement record. Updates land in the Alerts
 * inbox with no setup, and go out by push or email when one is on.
 *
 * The baseline is the local database's copy of the record when there is one
 * (the same copy the inbox and the server diff against), so a live record
 * that spells its states slightly differently can't produce a false "states
 * added" the moment the index is read.
 * ───────────────────────────────────────────────────────────────────────── */

function useWatching(id) {
  const [on, setOn] = useState(() => !!id && isFollowingRecall(id));
  useEffect(() => {
    if (!id) return undefined;
    const sync = () => setOn(isFollowingRecall(id));
    sync();
    window.addEventListener(FOLLOWS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FOLLOWS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [id]);
  return on;
}

function bestCopy(recall) {
  try {
    const hit = recallData().getState().byId.get(recall.id);
    if (hit) return hit;
  } catch (_) { /* the record we were given will do */ }
  return recall;
}

/**
 * @param {object}  props
 * @param {object}  props.recall
 * @param {boolean} [props.compact]  a text-link sized control for list cards
 */
export default function WatchButton({ recall, compact = false, variant, className }) {
  const id = recall && recall.id;
  const on = useWatching(id);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(""), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  if (!isRecallId(id)) return null;

  const toggle = async () => {
    if (on) {
      unfollowRecall(id);
      track("recall_unfollowed", { recall_id: id });
      return;
    }
    const copy = bestCopy(recall);
    const out = followRecall({ id, title: String(recall.product || "").slice(0, 160), snap: recallSnapshot(copy) });
    if (out.full) setMsg(`You can follow up to ${MAX_FOLLOWED_RECALLS} recalls. Remove one in Alerts first.`);
    else {
      setMsg("Updates will show in Alerts");
      track("recall_followed", { recall_id: id, source: recall.source || null });
    }
  };

  const label = on ? "Following updates" : "Notify me about updates";
  const Icon = on ? BellRing : BellPlus;

  /* A row in the sheet's closing list, beside Follow <brand>: the quiet home
   * for this control once the recall has its full notice. */
  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        className={cn("press flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint", className)}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-fog">
          <Icon aria-hidden="true" className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-paper">{label}</span>
          <span role="status" className="block text-[12.5px] text-subtle">
            {msg || (on ? "Changes to this recall show in Alerts" : "Hear if the agency changes or closes it")}
          </span>
        </span>
      </button>
    );
  }

  /* The sheet's floating action bar, full height, with its confirmation
   * floating above the bar rather than pushing it around. Only there while
   * the recall is still waiting on details, and secondary to Share. */
  if (variant === "bar") {
    return (
      <span className={cn("relative flex", className)}>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={on}
          className={cn(
            "inline-flex h-12 w-full min-w-0 items-center justify-center gap-1.5 rounded-full px-4 text-[15px] font-semibold sm:gap-2 sm:px-5",
            "transition-[transform,background-color,color] active:scale-[0.97]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rr-surface)]",
            on ? "bg-panel-2 text-paper shadow-[inset_0_0_0_1px_var(--rr-line-strong)]" : "bg-panel-2 text-paper shadow-[var(--rr-shadow-1),inset_0_0_0_1px_var(--rr-line)]",
          )}
        >
          <Icon className="size-[18px] shrink-0" aria-hidden="true" />
          <span className="truncate">{on ? "Following" : "Notify me"}</span>
          {!on && <span className="sr-only"> about updates to this recall</span>}
        </button>
        {msg && (
          <span role="status"
                className="pop-in absolute bottom-full left-0 mb-2 max-w-[min(20rem,80vw)] rounded-2xl bg-paper px-3.5 py-2 text-[13px] font-medium leading-snug text-ink shadow-[var(--rr-shadow-3)]">
            {msg}
          </span>
        )}
      </span>
    );
  }

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={on}
          className={cn(
            "inline-flex min-h-8 items-center gap-1 text-[13px] font-semibold underline-offset-2 hover:underline",
            on ? "text-paper" : "text-mint",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" /> {on ? "Following" : "Notify me"}
          <span className="sr-only"> about updates to this recall</span>
        </button>
        {msg && <span role="status" className="text-[11px] text-subtle">{msg}</span>}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex max-w-full flex-wrap items-center gap-2", className)}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-pressed={on}
        className="max-w-full pointer-coarse:h-10"
        onClick={toggle}
      >
        <Icon aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Button>
      {msg && <span role="status" className="text-[12px] text-subtle">{msg}</span>}
    </span>
  );
}
