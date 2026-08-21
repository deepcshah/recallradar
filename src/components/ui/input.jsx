import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-full border border-line bg-panel-2 px-4 text-sm text-paper",
      "placeholder:text-fog/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60 focus-visible:border-mint/50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
