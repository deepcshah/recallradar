import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/* A select whose menu is the app's own surface.
 *
 * The one that shipped was a bare `<select>` painted to look like the pill
 * around it, on the argument that a platform picker renders a four-item list
 * better on a phone than anything we would build. That is true of the phone
 * and false of everywhere else: on a desktop it dropped an OS menu in the OS
 * font at the OS size in the OS colours, which is the same objection the
 * location form already makes about the browser's validation bubble. It was
 * also the only control in the app that could not say which option was
 * chosen with a check mark, or read `Escape` the way every other surface
 * here does.
 *
 * So: Radix, styled to this app's tokens. Radix gives the parts a listbox
 * actually needs — typeahead, arrow keys, focus return, `aria-activedescendant`
 * — and on a touch device it still hands off to the platform's own picker,
 * which was the good half of the original argument. */

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex cursor-pointer items-center justify-between gap-1 whitespace-nowrap",
      "text-[13px] font-semibold text-paper outline-none",
      "focus-visible:ring-2 focus-visible:ring-mint/60",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="size-3.5 shrink-0 opacity-60" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/* Only shown when the list is taller than the room it has, which for a
 * four-item cap is never — but the menu is a shared component and the next
 * caller's list may not be. */
const scrollButton = "flex cursor-default items-center justify-center py-1 text-fog";

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton ref={ref} className={cn(scrollButton, className)} {...props}>
    <ChevronUp className="size-3.5" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton ref={ref} className={cn(scrollButton, className)} {...props}>
    <ChevronDown className="size-3.5" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={6}
      /* Above the sheets' scrim (z-60) is wrong — a select inside a sheet is
         part of it — but this has to clear the map's own controls (z-5) and
         the panel's stacking context, which is what portalling is for. */
      className={cn(
        "pop-in z-[70] overflow-hidden rounded-xl border border-line bg-panel",
        "text-paper shadow-[var(--rr-shadow-3)]",
        className
      )}
      style={{ maxHeight: "var(--radix-select-content-available-height)" }}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn("p-1", position === "popper" && "min-w-[var(--radix-select-trigger-width)]")}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("microlabel px-2.5 py-1.5", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex min-h-9 cursor-pointer select-none items-center gap-3 rounded-lg px-2.5",
      "text-[13px] font-semibold outline-none transition-colors",
      "data-[highlighted]:bg-panel-3 data-[state=checked]:text-mint",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      className
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    {/* Trailing, so a column of numbers stays a column of numbers. */}
    <SelectPrimitive.ItemIndicator className="ml-auto">
      <Check className="size-3.5" strokeWidth={3} />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent,
  SelectLabel, SelectItem, SelectSeparator,
  SelectScrollUpButton, SelectScrollDownButton,
};
