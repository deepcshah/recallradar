import { useState } from "react";
import {
  Apple, Armchair, Baby, Beef, Bike, Candy, Carrot, CupSoda, Fish, Microwave, Milk, Package,
  PawPrint, Pill, PlugZap, Soup, Stethoscope, Wheat,
} from "lucide-react";
import { categoryFor } from "@/lib/category";
import { primaryCategoryOf } from "@/lib/primary-category";
import { officialImage } from "@/lib/official-image";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * THE IMAGE TILE — text first, images only real
 *
 * A row's tile is there to help someone recognise a thing, never to decorate
 * it. So it is one of exactly two things:
 *
 *   1. The agency's own photo. Only CPSC publishes one, and only an https URL
 *      on cpsc.gov is accepted (officialImage) — re-checked here, so a bad
 *      record can never put a third-party picture next to a recall.
 *   2. A calm category tile: the kind of thing (a carton, a pill, a bike) as a
 *      line icon on a muted tint, one tint per primary category (Food, Meat &
 *      poultry, Drugs, Medical devices, Products). It says "this is a dairy
 *      recall" without pretending to show the product.
 *
 * Never stock photography, never a generated image, never a guess. A photo
 * that fails to load falls back to the tile, not to a broken-image icon.
 * Open Food Facts photos are NOT used here — only in the opened recall,
 * labelled as theirs (see RecallDetail), because a list of forty rows must
 * not fire forty third-party requests.
 * ───────────────────────────────────────────────────────────────────────── */

const KIND_ICONS = {
  pet: PawPrint, kids: Baby, supplement: Pill, drug: Pill, device: Stethoscope,
  electrical: PlugZap, appliance: Microwave, home: Armchair, sports: Bike,
  meat: Beef, seafood: Fish, dairy: Milk, produce: Carrot, grains: Wheat,
  snacks: Candy, beverage: CupSoda, pantry: Soup, food: Apple, product: Package,
};

export function kindIcon(recall) {
  const k = (recall && recall.category) || categoryFor(recall || {}).key;
  return KIND_ICONS[k] || (primaryCategoryOf(recall) === "product" ? Package : Apple);
}

const SIZES = {
  sm: { box: "size-11 rounded-[14px]", icon: "size-5" },
  md: { box: "size-14 rounded-2xl", icon: "size-6" },
  lg: { box: "size-24 rounded-[28px]", icon: "size-10" },
};

/**
 * @param {object} props.recall
 * @param {"sm"|"md"|"lg"} [props.size="md"]
 * @param {string} [props.src]   an already-vetted photo URL to prefer (detail sheet)
 */
export default function RecallThumb({ recall, size = "md", src: override, className }) {
  const photo = override || officialImage(recall && recall.image, recall && recall.source);
  const [failed, setFailed] = useState(null);
  const cat = primaryCategoryOf(recall);
  const Icon = kindIcon(recall);
  const sz = SIZES[size] || SIZES.md;
  const showPhoto = photo && failed !== photo;
  return (
    <span data-cat={cat} className={cn("cat-tile", sz.box, showPhoto && "has-photo", className)}>
      {showPhoto ? (
        <img
          src={photo}
          alt={String((recall && recall.product) || "").replace(/…$/, "")}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(photo)}
        />
      ) : (
        <Icon aria-hidden="true" className={sz.icon} strokeWidth={1.75} />
      )}
    </span>
  );
}
