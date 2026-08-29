import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Badges are tinted chips, not outlines — a soft fill plus a hairline reads as
 * a physical tag and keeps the accent from competing with body text. */
const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap border " +
    "shadow-[var(--rr-inset)]",
  {
    variants: {
      variant: {
        source: "border-line bg-panel-3 text-fog uppercase tracking-[0.06em] text-[10px]",
        high: "border-alert/45 bg-alert-soft text-alert",
        med: "border-amber/45 bg-amber/10 text-amber",
        low: "border-line bg-panel-3 text-fog",
        scope: "border-line bg-panel-3 text-subtle uppercase tracking-[0.06em] text-[10px]",
        chain: "border-mint/35 bg-mint-soft text-mint",
        beta: "border-mint/40 bg-mint-soft text-mint uppercase tracking-[0.1em] text-[10px] font-bold",
      },
    },
    defaultVariants: { variant: "low" },
  }
);

function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
