import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* A button is a pill. Primary is the one accent, filled; secondary is a
 * white (or dark-card) pill with a hairline ring; ghost is text on nothing.
 * Press scales to 0.97 rather than sinking — the reference's press — and the
 * focus ring is the accent with a gap, visible on every fill. Touch sizes
 * never drop under 44px. */
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold " +
    "transition-[transform,box-shadow,background-color,border-color,color] duration-150 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-[var(--rr-surface)] " +
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 " +
    "active:scale-[0.97] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-mint text-mint-ink border border-mint shadow-[var(--rr-shadow-2)] " +
          "hover:brightness-[1.06] active:brightness-[0.96]",
        outline:
          "border border-line-strong bg-panel-2 text-mint shadow-[var(--rr-shadow-1)] hover:bg-panel-3",
        secondary:
          "border border-line bg-panel-2 text-paper shadow-[var(--rr-shadow-1)] hover:border-line-strong hover:bg-panel-3",
        ghost: "border border-transparent text-fog hover:text-paper hover:bg-panel-3",
      },
      size: {
        default: "h-11 px-5 text-[15px]",
        sm: "h-9 px-4 text-[13px] pointer-coarse:h-11",
        lg: "h-12 px-7 text-base",
        icon: "size-10 p-0 pointer-coarse:size-11",
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
