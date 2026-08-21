import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap border",
  {
    variants: {
      variant: {
        source: "border-mint/40 bg-mint/10 text-mint font-mono uppercase tracking-wider text-[10px]",
        high: "border-alert/50 bg-alert/10 text-alert",
        med: "border-amber/50 bg-amber/10 text-amber",
        low: "border-line bg-white/5 text-fog",
        scope: "border-line bg-white/5 text-fog font-mono uppercase tracking-wider text-[10px]",
        chain: "border-mint/35 bg-transparent text-mint",
      },
    },
    defaultVariants: { variant: "low" },
  }
);

function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
