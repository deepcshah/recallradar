import * as React from "react";
import { cn } from "@/lib/utils";

/* Inputs are recessed: an inner shadow at the top edge makes the field read as
 * carved into the surface rather than floating on it. */
const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-lg border border-line-strong bg-panel-2 px-3.5 text-sm text-paper",
      "shadow-[var(--rr-field)] transition-shadow",
      "placeholder:text-subtle focus-visible:outline-none focus-visible:border-mint/60",
      "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
