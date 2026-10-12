/* The five categories a person filters recalls by at a glance.
 *
 * category.js reads the product text into a fine kind (dairy, kids, appliance
 * …) for icons. This is coarser and comes from WHO REGULATES the thing, which
 * is the one fact the feeds state outright rather than one we infer:
 *
 *   FDA Food           → Food
 *   USDA FSIS          → Meat & poultry
 *   FDA Drug           → Drugs
 *   FDA Device         → Medical devices
 *   CPSC               → Products
 *   FDA announcement   → by what the announcement is about: a drug or a
 *                        device announcement is that; everything else FDA
 *                        announces is food (FDA's press-release feed covers
 *                        food, drugs, devices — never consumer goods)
 *
 * Pure and dependency-light, so the list, the search and the counts all
 * agree by construction.
 */
import { categoryFor } from "./category.js";

export const PRIMARY_CATEGORIES = [
  { key: "all", label: "All" },
  { key: "food", label: "Food" },
  { key: "meat", label: "Meat & poultry" },
  { key: "drug", label: "Drugs" },
  { key: "device", label: "Medical devices" },
  { key: "product", label: "Products" },
];

const KEYS = new Set(PRIMARY_CATEGORIES.map((c) => c.key));

export function isPrimaryKey(k) {
  return KEYS.has(k);
}

/** "food" | "meat" | "drug" | "device" | "product" — never "all". */
export function primaryCategoryOf(r) {
  const s = String((r && r.source) || "");
  if (s === "USDA FSIS") return "meat";
  if (s === "FDA Drug") return "drug";
  if (s === "FDA Device") return "device";
  if (s === "CPSC") return "product";
  if (s === "FDA Food") return "food";
  if (s === "FDA announcement") {
    const k = (r && r.category) || categoryFor(r || {}).key;
    if (k === "drug") return "drug";
    if (k === "device") return "device";
    return "food";
  }
  /* An unknown feed: the goods default, same as category.js. */
  return "product";
}

/** A Map key → count over `records`, with "all" = records.length. */
export function countByPrimary(records) {
  const out = new Map(PRIMARY_CATEGORIES.map((c) => [c.key, 0]));
  for (const r of records || []) {
    const k = primaryCategoryOf(r);
    out.set(k, (out.get(k) || 0) + 1);
  }
  out.set("all", (records || []).length);
  return out;
}

export function inPrimary(r, key) {
  return !key || key === "all" || primaryCategoryOf(r) === key;
}

/** Lower-case noun for sentences: "No active food recall in NY…". */
export function primaryNoun(key) {
  return {
    food: "food", meat: "meat & poultry", drug: "drug", device: "medical device", product: "product",
  }[key] || "";
}
