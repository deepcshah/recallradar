import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Bell, BellOff, BellRing, Check, ChevronRight, Loader2, Mail, MapPin, Plus, Smartphone, X,
} from "lucide-react";
import { ResponsiveSurface } from "@/components/ui/responsive-surface";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  addFollow, removeFollow, unfollowRecall, acknowledgeRecall, markAlertsSeen,
} from "@/lib/follows";
import {
  getAlertPrefs, setAlertPrefs, getEmailSub, subscribeEmail, refreshEmailStatus, removeEmail, PREFS_EVENT, EMAIL_EVENT,
} from "@/lib/alerts";
import { changeLabel, describeChange } from "@/lib/recall-watch";
import { isAnnounced } from "@/lib/verdict";
import { plainHeadline, dayOf } from "@/lib/digest";
import { severityLabel, severityVariant } from "@/lib/classification";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * ALERTS — one surface for following and being told
 *
 * Opened from the bell in the header (md and up: an anchored popover) and
 * from Alerts in the bottom bar (a sheet) — the same ResponsiveSurface the
 * location picker uses. Top to bottom:
 *
 *   New for you          updates to followed recalls, then new recalls
 *                        matching a followed term, since "Mark all read".
 *                        Computed in the browser (lib/alerts.js computeInbox)
 *                        from the national index and the live lists; works
 *                        with no delivery channel at all.
 *   You follow           recalls (Notify me about updates) and products/brands.
 *   Delivery             this device (web push) and email — each says "not
 *                        available yet" with the server's reason when it is
 *                        off, rather than disappearing — and the two state
 *                        preferences (weekly digest, urgent Class I).
 *
 * The inbox is held to the app's rule: an empty one says what was checked
 * and since when, never that anything is safe.
 * ───────────────────────────────────────────────────────────────────────── */

function fmtDay(d) {
  const day = dayOf(d);
  if (!day) return "";
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Section({ title, aside, children, className }) {
  return (
    <section className={cn("border-t border-line px-4 py-3.5 first:border-t-0", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="microlabel">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Switch({ id, checked, onChange, disabled, label, sub }) {
  return (
    <div className={cn("flex items-start gap-3 py-1.5", disabled && "opacity-60")}>
      <span className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-[14px] text-paper">{label}</label>
        {sub && <span className="block text-[12px] leading-snug text-subtle">{sub}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60",
          checked ? "border-mint bg-mint" : "border-line-strong bg-sunken",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-[18px] rounded-full bg-panel shadow-[var(--rr-shadow-1)] transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-[2px]",
          )}
        />
      </button>
    </div>
  );
}

/* "Not available yet", in words a reader can use. The server's reason names
 * environment variables; that belongs in the owner's logs, not on a phone. */
function Unavailable({ reason }) {
  const unreachable = /reached|offline|HTTP/i.test(String(reason || ""));
  return (
    <p className="text-[12px] leading-snug text-subtle">
      <span className="font-semibold text-fog">Not available yet.</span>{" "}
      {unreachable
        ? "The alerts service couldn't be reached just now."
        : "This site hasn't switched it on. Everything above still works in this browser."}
    </p>
  );
}

function ChannelRow({ icon: Icon, title, status, children }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-fog" aria-hidden="true" />
        <span className="flex-1 text-[14px] font-semibold text-paper">{title}</span>
        {status}
      </div>
      <div className="mt-2 space-y-2 text-[13px] leading-snug text-fog">{children}</div>
    </div>
  );
}

function OnPill({ children = "On" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-mint-line bg-mint-soft px-2 py-0.5 text-[11px] font-semibold text-mint">
      <Check className="size-3" aria-hidden="true" /> {children}
    </span>
  );
}

/* ───────────────────────────── email ───────────────────────────── */
function EmailChannel({ available, reason, stateAbbr, onRequestLocation }) {
  const [sub, setSub] = useState(getEmailSub);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const sync = () => setSub(getEmailSub());
    window.addEventListener(EMAIL_EVENT, sync);
    window.addEventListener("storage", sync);
    if (getEmailSub()) refreshEmailStatus().then(() => sync()).catch(() => {});
    return () => {
      window.removeEventListener(EMAIL_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const out = await subscribeEmail({ email: draft, stateAbbr });
    setBusy(false);
    if (out.ok) {
      setDraft("");
      track("email_alerts_requested", { state: stateAbbr || null });
    } else {
      setMsg(out.message);
      track("email_alerts_failed", {});
    }
  };
  const off = async () => {
    setBusy(true);
    setMsg(null);
    const out = await removeEmail();
    setBusy(false);
    if (!out.ok) setMsg(out.message);
    else track("email_alerts_off", {});
  };

  let body;
  let status = null;
  if (sub && sub.status === "confirmed") {
    status = <OnPill />;
    body = (
      <>
        <p>Alerts go to <span className="font-semibold text-paper [overflow-wrap:anywhere]">{sub.address}</span>.</p>
        <Button variant="outline" size="sm" className="pointer-coarse:h-10" disabled={busy} onClick={off}>
          {busy ? <Loader2 className="animate-spin" /> : <BellOff />} Turn off email
        </Button>
      </>
    );
  } else if (sub) {
    status = <span className="text-[11px] font-semibold text-amber">Waiting</span>;
    body = (
      <>
        <p>
          We sent a link to <span className="font-semibold text-paper [overflow-wrap:anywhere]">{sub.address}</span>.
          Nothing is emailed until you open it and confirm. Not there? Check spam.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="pointer-coarse:h-10" disabled={busy}
                  onClick={async () => { setBusy(true); await refreshEmailStatus(); setSub(getEmailSub()); setBusy(false); }}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} I've confirmed
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:h-10" disabled={busy} onClick={off}>Cancel</Button>
        </div>
      </>
    );
  } else if (!available) {
    body = <Unavailable reason={reason} />;
  } else if (!stateAbbr) {
    body = (
      <Button variant="secondary" size="sm" className="pointer-coarse:h-10" onClick={onRequestLocation}>
        <MapPin /> Set a location first
      </Button>
    );
  } else {
    body = (
      <form onSubmit={submit} noValidate className="flex items-center gap-1.5">
        <label htmlFor="rr-alert-email" className="sr-only">Email address</label>
        <input
          id="rr-alert-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (msg) setMsg(null); }}
          placeholder="you@example.com"
          maxLength={254}
          disabled={busy}
          className={cn(
            "h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-panel px-3 text-[13px] text-paper",
            "shadow-[var(--rr-field)] placeholder:text-subtle focus-visible:border-mint/60 focus-visible:outline-none",
            "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
          )}
        />
        <Button type="submit" size="sm" className="h-9 shrink-0" disabled={busy || !draft.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Mail />} Email me
        </Button>
      </form>
    );
  }
  return (
    <ChannelRow icon={Mail} title="Email" status={status}>
      {body}
      {msg && (
        <p role="alert" className="flex gap-1.5 text-[12px] font-semibold text-alert">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" /> {msg}
        </p>
      )}
    </ChannelRow>
  );
}

/* ───────────────────────────── push ───────────────────────────── */
function PushChannel({ available, reason, push, stateAbbr, onEnable, onDisable, onRequestLocation }) {
  let body;
  let status = null;
  if (push.state === "subscribed") {
    status = <OnPill />;
    body = (
      <Button variant="outline" size="sm" className="pointer-coarse:h-10" disabled={push.busy} onClick={onDisable}>
        {push.busy ? <Loader2 className="animate-spin" /> : <BellOff />} Turn off on this device
      </Button>
    );
  } else if (!available) {
    body = <Unavailable reason={reason} />;
  } else if (push.state === "needs-install") {
    body = (
      <p>
        Apple only delivers notifications to sites added to the Home Screen. Tap{" "}
        <span className="font-semibold text-paper">Share</span>, then{" "}
        <span className="font-semibold text-paper">Add to Home Screen</span>, open Yanked from there, and turn them on.
      </p>
    );
  } else if (push.state === "unsupported") {
    body = <p>This browser can't receive notifications from websites. Email works everywhere.</p>;
  } else if (push.state === "denied") {
    body = <p>Notifications are blocked for this site. Allow them in your browser's site settings, then come back.</p>;
  } else if (!stateAbbr) {
    body = (
      <Button variant="secondary" size="sm" className="pointer-coarse:h-10" onClick={onRequestLocation}>
        <MapPin /> Set a location first
      </Button>
    );
  } else {
    body = (
      <Button size="sm" className="pointer-coarse:h-10" disabled={push.busy || push.state === "unknown"} onClick={onEnable}>
        {push.busy ? <Loader2 className="animate-spin" /> : <Bell />} Turn on notifications
      </Button>
    );
  }
  return (
    <ChannelRow icon={Smartphone} title="Notifications on this device" status={status}>
      {body}
      {push.msg && <p role="alert" className="text-[12px] font-semibold text-alert">{push.msg}</p>}
      {push.dropped && push.dropped.length > 0 && (
        <p className="text-[12px] text-subtle">
          Alerts can watch up to 20 products of 40 characters each, so these aren't included:{" "}
          {push.dropped.map((t) => `“${t}”`).join(", ")}.
        </p>
      )}
    </ChannelRow>
  );
}

/* ───────────────────────────── the panel ───────────────────────────── */
/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {string}   props.anchorId
 * @param {object}   props.loc             the reader's own location, or null
 * @param {object}   props.inbox           lib/alerts.js computeInbox() result, or null while loading
 * @param {string[]} props.terms           follow terms
 * @param {object[]} props.followed        follows.js getFollowedRecalls()
 * @param {object}   props.channels        { push, email } from alertChannels(), or null while asking
 * @param {object}   props.push            { state, busy, msg, dropped }
 * @param {Function} props.onEnablePush
 * @param {Function} props.onDisablePush
 * @param {Function} props.onOpenRecall    (record) => void
 * @param {Function} props.onRequestLocation
 * @param {object}   [props.byId]          Map id → record, to name followed recalls
 */
export default function AlertsPanel({
  open, onClose, anchorId, loc, inbox, terms, followed, channels, push, onEnablePush, onDisablePush,
  onOpenRecall, onRequestLocation, byId,
}) {
  const st = (loc && loc.stateAbbr) || null;
  const [prefs, setPrefs] = useState(getAlertPrefs);
  const [draft, setDraft] = useState("");
  const titleRef = useRef(null);
  useEffect(() => {
    const sync = () => setPrefs(getAlertPrefs());
    window.addEventListener(PREFS_EVENT, sync);
    return () => window.removeEventListener(PREFS_EVENT, sync);
  }, []);

  const updates = (inbox && inbox.updates) || [];
  const matches = (inbox && inbox.matches) || [];
  const unread = (inbox && inbox.count) || 0;
  const anyFollow = terms.length > 0 || followed.length > 0;
  const emailOn = useMemo(() => Boolean(getEmailSub()), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const anyChannel = push.state === "subscribed" || emailOn;

  const markAllRead = () => {
    for (const u of updates) if (u.next) acknowledgeRecall(u.id, u.next);
    markAlertsSeen();
    track("alerts_marked_read", { count: unread });
  };

  const addTerm = (e) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    addFollow(t);
    setDraft("");
  };

  const pushCh = (channels && channels.push) || { enabled: false, reason: null };
  const emailCh = (channels && channels.email) || { enabled: false, reason: null };
  const askLocation = () => { onClose(); onRequestLocation(); };

  return (
    <ResponsiveSurface
      open={open}
      onClose={onClose}
      anchorId={anchorId}
      id="alerts-panel"
      title="Alerts"
      titleId="alerts-panel-title"
      width={400}
      initialFocusRef={titleRef}
      renderHeader={(sheet) => (
        <div className="relative shrink-0 border-b border-line px-4 pb-3 pt-4">
          {sheet && <span aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-line-strong" />}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p id="alerts-panel-title" ref={titleRef} tabIndex={-1}
                 className={cn("text-sm font-bold text-paper outline-none", sheet && "mt-1")}>Alerts</p>
              <p className="mt-0.5 text-[12px] leading-snug text-subtle">
                What you follow, and what's new for it{st ? ` · ${st}` : ""}.
              </p>
            </div>
            {sheet && (
              <button type="button" onClick={onClose} aria-label="Close"
                      className="-mr-1 grid size-9 shrink-0 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper">
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      )}
    >
      {/* ── new for you ── */}
      <Section
        title="New for you"
        aside={unread > 0 && (
          <button type="button" onClick={markAllRead}
                  className="tap text-[12px] font-semibold text-mint hover:underline">
            Mark all read
          </button>
        )}
      >
        {!inbox ? (
          <p className="text-[13px] text-fog">Checking the latest notices…</p>
        ) : unread === 0 ? (
          <p className="text-[13px] leading-snug text-fog">
            {anyFollow
              ? `Nothing new for what you follow since ${fmtDay(inbox.sinceDay)} — in the notices we read. Matching looks at product and brand names only.`
              : "Follow a product, a brand or a specific recall, and anything new about it lands here — no sign-up needed."}
          </p>
        ) : (
          <ul className="-mx-1.5 flex flex-col" aria-label="New for you">
            {updates.map((u) => (
              <li key={`u-${u.id}`}>
                <button
                  type="button"
                  onClick={() => u.record && onOpenRecall(u.record)}
                  disabled={!u.record}
                  className="tap flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left hover:bg-panel-3 disabled:cursor-default"
                >
                  <BellRing className="mt-0.5 size-4 shrink-0 text-paper" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="scope">{changeLabel(u.changes[0])}</Badge>
                      {u.changes.length > 1 && <span className="text-[11px] text-subtle">+{u.changes.length - 1} more</span>}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[13px] font-semibold leading-snug text-paper">
                      {(u.record && plainHeadline(u.record)) || u.title || u.id}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-fog">
                      {u.changes.map((c) => describeChange(c, st)).join(" ")}
                    </span>
                  </span>
                  {u.record && <ChevronRight className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />}
                </button>
              </li>
            ))}
            {matches.map((m) => (
              <li key={`t-${m.term}`} className="px-1.5 pt-2">
                <p className="text-[12px] text-fog">
                  New for <span className="font-semibold text-paper">“{m.term}”</span>
                </p>
                <ul className="-mx-1.5 mt-0.5">
                  {m.records.slice(0, 4).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onOpenRecall(r)}
                        className="tap flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-panel-3"
                      >
                        {/* An announcement has no class yet: neutral and dashed,
                            as everywhere else — never the amber of a Class II. */}
                        {isAnnounced(r)
                          ? <Badge variant="low" className="shrink-0 border-dashed border-line-strong bg-transparent text-fog">Announced</Badge>
                          : <Badge variant={severityVariant(r)} className="shrink-0">{severityLabel(r)}</Badge>}
                        <span className="line-clamp-1 min-w-0 flex-1 text-[13px] text-paper">{plainHeadline(r)}</span>
                        <span className="tnum shrink-0 text-[11px] text-subtle">{fmtDay(r.posted || r.date)}</span>
                      </button>
                    </li>
                  ))}
                  {m.records.length > 4 && (
                    <li className="px-1.5 py-1 text-[12px] text-subtle">+{m.records.length - 4} more — search “{m.term}” on Home</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {inbox && (
          <p className="mt-2 text-[11px] leading-snug text-subtle">
            Checked in this browser{st ? ` for ${st}` : ""}; {anyChannel
              ? "your alert channels get the same updates."
              : "nothing is sent anywhere unless you turn on a channel below."}
          </p>
        )}
      </Section>

      {/* ── what you follow ── */}
      <Section title="You follow">
        <p className="mb-1 text-[12px] font-semibold text-fog">Recalls</p>
        {followed.length === 0 ? (
          <p className="text-[12px] leading-snug text-subtle">
            Open any recall and tap <span className="font-semibold text-fog">Notify me about updates</span> to hear if it's
            closed, reclassified or sent to more states.
          </p>
        ) : (
          <ul className="-mx-1.5 mb-1 flex flex-col" aria-label="Followed recalls">
            {followed.map((f) => {
              const r = byId && byId.get(f.id);
              return (
                <li key={f.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => r && onOpenRecall(r)}
                    disabled={!r}
                    className="tap flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-panel-3 disabled:cursor-default"
                  >
                    <BellRing className="size-3.5 shrink-0 text-fog" aria-hidden="true" />
                    <span className="line-clamp-1 min-w-0 flex-1 text-[13px] text-paper">{r ? plainHeadline(r) : (f.title || f.id)}</span>
                    {r && r.status === "ended" && <span className="shrink-0 text-[11px] text-subtle">Closed</span>}
                  </button>
                  <button type="button" onClick={() => unfollowRecall(f.id)}
                          aria-label={`Stop following ${f.title || f.id}`}
                          className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-panel-3 hover:text-paper">
                    <X className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mb-1.5 mt-3 text-[12px] font-semibold text-fog">Products and brands</p>
        {terms.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Followed products">
            {terms.map((t) => (
              <li key={t} className="inline-flex min-h-[28px] items-center overflow-hidden rounded-full border border-line bg-panel-2 text-paper shadow-[var(--rr-bevel),var(--rr-shadow-1)] [@media(pointer:coarse)]:min-h-9">
                <span className="max-w-[18ch] truncate pl-3 pr-1 text-[12px] font-semibold">{t}</span>
                <button type="button" onClick={() => removeFollow(t)} aria-label={`Stop following ${t}`}
                        className="inline-flex h-full items-center pl-0.5 pr-2.5 text-subtle hover:text-paper">
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addTerm} className="flex items-center gap-1.5">
          <label htmlFor="rr-alerts-follow-input" className="sr-only">Add a product or brand you buy</label>
          <input
            id="rr-alerts-follow-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={60}
            placeholder="Add a product or brand"
            autoComplete="off"
            enterKeyHint="done"
            className={cn(
              "h-9 min-w-0 flex-1 rounded-full border border-line-strong bg-panel-2 px-3.5 text-[13px] text-paper",
              "shadow-[var(--rr-field)] placeholder:text-subtle focus-visible:border-mint/60 focus-visible:outline-none",
              "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
            )}
          />
          <button type="submit" className="chip chip-off shrink-0" disabled={!draft.trim()}>
            <Plus className="size-3.5" aria-hidden="true" /> Follow
          </button>
        </form>
      </Section>

      {/* ── delivery ── */}
      <Section title="Delivery">
        <div className="space-y-2">
          <PushChannel
            available={pushCh.enabled} reason={pushCh.reason} push={push} stateAbbr={st}
            onEnable={onEnablePush} onDisable={onDisablePush} onRequestLocation={askLocation}
          />
          <EmailChannel available={emailCh.enabled} reason={emailCh.reason} stateAbbr={st} onRequestLocation={askLocation} />
        </div>

        <div className="mt-3">
          <Switch
            id="rr-pref-weekly"
            checked={prefs.weekly}
            onChange={(v) => setAlertPrefs({ weekly: v })}
            label={`Weekly digest for ${st || "your state"}`}
            sub="Saturdays: the week's new recalls there. Skipped when there's nothing new."
          />
          <Switch
            id="rr-pref-urgent"
            checked={prefs.urgent}
            onChange={(v) => setAlertPrefs({ urgent: v })}
            label={`Serious recalls in ${st || "your state"}, straight away`}
            sub="Class I and USDA high-risk notices, within a day of us seeing them."
          />
          {!st && (
            <button type="button" onClick={askLocation}
                    className="tap mt-1 inline-flex items-center gap-1 text-[13px] font-semibold text-mint hover:underline">
              <MapPin className="size-3.5" aria-hidden="true" /> Set your state
            </button>
          )}
          <p className="mt-1.5 text-[12px] leading-snug text-subtle">
            Updates to recalls you follow and new matches for your products are always sent to any channel that's on.
          </p>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-subtle">
          With no channel on, all of this stays in this browser. Turning one on sends our server your state, the
          products and recall numbers you follow and these two settings — plus, for email, your address, which is
          deleted after a week if you never confirm it. Never your location. Turning a channel off deletes its copy.
        </p>
      </Section>
    </ResponsiveSurface>
  );
}
