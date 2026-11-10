import { cn } from "@/lib/utils";

/* The Yanked wordmark: hand-lettered "yanked" whose tail loops back into an
 * arrow (public/brand/wordmark.svg, traced from the artwork to a single
 * path). Drawn as a CSS mask over `currentColor`, so it takes the text colour
 * in both themes without a second file, and stays crisp at any size. The
 * name is for assistive tech; the drawing is decoration. */
export default function Wordmark({ className, label = "Yanked" }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-block aspect-[1092/676] bg-current", className)}
      style={{
        WebkitMask: "url(/brand/wordmark.svg) center / contain no-repeat",
        mask: "url(/brand/wordmark.svg) center / contain no-repeat",
      }}
    />
  );
}
