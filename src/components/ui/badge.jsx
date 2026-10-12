import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Badges are tinted chips, not outlines — a soft fill plus a hairline reads as
 * a physical tag and keeps the accent from competing with body text. They stay
 * flat: a badge is a label, not a control, so it gets no bevel and no shadow.
 *
 * Only the severity badges carry warm colour, and only because the class is
 * the government's own ("Class I"). Nothing about a *store* is ever coloured
 * as a hazard — see the note in App.jsx. */
const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap border",
  {
    variants: {
      variant: {
        source: "border-line bg-panel-3 text-fog",
        high: "border-alert-line bg-alert-soft text-alert",
        /* Warm colour is for a serious recall only. Class II is the middle
         * of the scale and reads in ink; the badge explains itself on tap. */
        med: "border-line bg-panel-3 text-paper",
        low: "border-line bg-panel-3 text-fog",
        scope: "border-line bg-panel-3 text-fog",
        chain: "border-mint-line bg-mint-soft text-mint",
        neutral: "border-line-strong bg-panel-3 text-paper",
        beta: "border-mint-line bg-mint-soft text-mint text-[11px] font-semibold",
      },
    },
    defaultVariants: { variant: "low" },
  }
);

function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
