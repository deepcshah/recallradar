import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Buttons carry depth: a vertical gradient sheen, a top highlight, a hairline
 * and a drop shadow — then press *into* the surface on :active. */
const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold " +
    "transition-[transform,box-shadow,background-color,border-color] duration-150 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60 focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-[var(--rr-surface)] " +
    "disabled:pointer-events-none disabled:opacity-50 " +
    "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] " +
    "before:bg-[image:var(--rr-btn-grad)] " +
    "active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:relative",
  {
    variants: {
      variant: {
        default:
          "bg-mint text-mint-ink border border-mint " +
          "shadow-[var(--rr-shadow-1)] hover:brightness-[1.06] active:brightness-[0.97] " +
          "active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]",
        outline:
          "border border-line-strong bg-panel-2 text-mint " +
          "shadow-[var(--rr-inset),var(--rr-shadow-1)] hover:bg-panel-3 " +
          "active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.14)]",
        secondary:
          "border border-line-strong bg-panel-2 text-paper " +
          "shadow-[var(--rr-inset),var(--rr-shadow-1)] hover:bg-panel-3 " +
          "active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.14)]",
        ghost: "border border-transparent text-fog hover:text-paper hover:bg-panel-3 before:hidden",
      },
      size: {
        default: "h-10 px-5 text-sm",
        sm: "h-8 px-3.5 text-xs",
        lg: "h-12 px-7 text-base",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

const Button = React.forwardRef(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

export { Button, buttonVariants };
