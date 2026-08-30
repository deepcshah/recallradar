import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* A button is a moulded face: a bevel (light hairline on the top inner edge,
 * dark on the bottom), a hairline border, and a 1px drop shadow. On :active it
 * sinks — the bevel is replaced by a press shadow so the light flips sides. No
 * gradient wash; a sheen across the whole face reads as a sticker, not a key. */
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold " +
    "transition-[transform,box-shadow,background-color,border-color] duration-100 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60 focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-[var(--rr-surface)] " +
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 " +
    "active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-mint text-mint-ink border border-mint " +
          "shadow-[var(--rr-bevel-strong),var(--rr-shadow-1)] " +
          "hover:brightness-[1.08] active:brightness-[0.95] active:shadow-[var(--rr-press)]",
        outline:
          "border border-line-strong bg-panel-2 text-mint " +
          "shadow-[var(--rr-bevel),var(--rr-shadow-1)] hover:bg-panel-3 " +
          "active:shadow-[var(--rr-press)]",
        secondary:
          "border border-line-strong bg-panel-2 text-paper " +
          "shadow-[var(--rr-bevel),var(--rr-shadow-1)] hover:bg-panel-3 " +
          "active:shadow-[var(--rr-press)]",
        ghost: "border border-transparent text-fog hover:text-paper hover:bg-panel-3",
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
