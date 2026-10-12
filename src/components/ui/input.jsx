import * as React from "react";
import { cn } from "@/lib/utils";

/* Inputs are recessed: an inner shadow at the top edge makes the field read as
 * carved into the surface rather than floating on it. */
const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-11 w-full rounded-xl border border-line bg-panel-2 px-4 text-[15px] text-paper",
      "shadow-[var(--rr-field)] transition-shadow",
      "placeholder:text-subtle focus-visible:outline-none focus-visible:border-mint",
      "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
