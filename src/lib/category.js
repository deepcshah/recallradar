/* Classify a recall into a product category so the UI can show an icon and
 * label. Pure text heuristics — none of the government feeds carry a
 * machine-readable category, and only CPSC provides product photos.
 * Returns { key, label }; keys map to icons in App.jsx.
 *
 * Two rules govern everything here, and both were learned from misfires that
 * reached the screen.
 *
 * 1. THE AGENCY DECIDES WHICH RULES CAN APPLY. One flat list ran the
 *    appliance and furniture patterns over food recalls, so "Soft Cuajada
 *    (vacuum sealed)" was an appliance because of `vacuum`, "Oven Roasted
 *    Turkey Breast" was an appliance because of `oven`, and a microwaveable
 *    entree was an appliance because of `microwave`. It ran the food patterns
 *    over consumer goods just as happily: a 200 Gram Aerial *Cake* firework
 *    filed under bakery, a coffeemaker under beverages, a water bottle too.
 *
 *    None of those are close calls. CPSC does not regulate food and never
 *    has; FSIS regulates meat, poultry and egg products and nothing else.
 *    So a food source only ever sees food rules, and a goods source only
 *    ever sees goods rules. A whole class of error stops being possible
 *    rather than being patched pattern by pattern.
 *
 * 2. THE PRODUCT NAMES THE CATEGORY; THE HAZARD DOES NOT. Matching ran over
 *    the product *and the reason*, and a CPSC hazard paragraph is mostly a
 *    description of who gets hurt: "the button batteries can be accessed
 *    easily by children", "tip-over hazards ... resulting in death to
 *    children". That put 44 of 311 real notices — dressers, laser pointers,
 *    battery chargers, LED tea lights — into "kids & baby" on the strength of
 *    the injury text alone. The hazard says what could go wrong, not what the
 *    thing is, so only the product is read now.
 */

/* Food, in the order a food recall should be tested. Earlier rules win, so
 * the specific animal proteins come before the catch-all prepared foods. */
const FOOD_RULES = [
  ["pet", "pet food & pets",
    /\b(?:dog|cat|pet)s?\b[^.]*\b(?:food|treat|chew|kibble)|pet food/],
  ["kids", "kids & baby",
    /infant formula|baby food|baby cereal|\btoddler\b|follow-on formula/],
  ["supplement", "supplement",
    /supplement|vitamin|gummies|protein powder|herbal|probiotic/],
  ["meat", "meat & poultry",
    /\bbeef\b|\bpork\b|chicken|turkey|sausage|\bham\b|\bmeat\b|poultry|salami|bacon|jerky|hot dog|brisket|\bribs\b/],
  /* "clam shells" is packaging — a clamshell tub — and turned a cheese
   * recall into seafood. The one-word "clamshell" never matched; the spaced
   * form did. */
  ["seafood", "seafood",
    /\bfish\b|salmon|\btuna\b|shrimp|oyster|\bcrabs?\b|\bclams?\b(?!\s*shells?\b)|seafood|scallop|lobster|caviar|tilapia/],
  ["dairy", "dairy & eggs",
    /\bmilk\b|cheese|yogurt|dairy|butter|ice cream|\beggs?\b|queso|gelato|cuajada/],
  ["produce", "produce",
    /lettuce|spinach|salad|onion|tomato|cucumber|carrot|apple|peach|mango|avocado|broccoli|\bgreens\b|berr(?:y|ies)|melon|grape|fruit|vegetable|produce|cilantro|parsley|kale|potato|pepper|cantaloupe|enoki|mushroom/],
  ["grains", "bakery & grains",
    /\bbread\b|flour|cereal|pasta|cracker|granola|bakery|\bcake\b|wheat|\boats?\b|tortilla|muffin|bagel|\brice\b|noodle/],
  ["snacks", "snacks & candy",
    /candy|chocolate|cookie|gumm(?:i|y)|snack|\bchips\b|popcorn|caramel|pretzel/],
  ["beverage", "beverages",
    /juice|beverage|\bdrink\b|\bsoda\b|coffee|\btea\b|smoothie|kombucha|\bshake\b|drinking water/],
  ["pantry", "pantry & prepared",
    /peanut|almond|cashew|pistachio|\bnuts?\b|tahini|hummus|sauce|\bsoup\b|dressing|spice|seasoning|salsa|\bdip\b|\bwrap\b|sandwich|burrito|entree|\bmeal\b/],
];

/* Consumer goods. No food patterns here at all, which is what stops a
 * firework called an "Aerial Cake" from being bakery. */
const GOODS_RULES = [
  ["kids", "kids & baby",
    /\binfant|\bbab(?:y|ies)\b|toddler|crib|stroller|pacifier|nursery|children'?s|kids'?\b|youth|plush|\btoys?\b|highchair|car seat|bassinet|playpen|onesie/],
  ["electrical", "electrical",
    /\bbatter(?:y|ies)\b|lithium|charger|power bank|power station|extension cord|power strip|generator|solar panel|\bwiring\b|adapter|projector|flashlight|hand warmer|\bcords?\b/],
  ["appliance", "appliance",
    /heater|blender|\boven\b|microwave|refrigerator|fridges?\b|freezer|dehumidifier|air fryer|toaster|washer|\bdryer\b|vacuum|humidifier|coffee ?maker|kettle|steamer|air conditioner|heat pump|\bfans?\b|gas range|cooktop|\bstoves?\b|dishwasher|pressure cooker/],
  ["home", "home & furniture",
    /furniture|dresser|\bchair\b|\btable\b|\blamp\b|mattress|\bsofa\b|bed frame|bed rails?|murphy bed|\bshelf\b|bookcase|candle|chandelier|ladder|blanket|curtain|\bstools?\b|cabinet|\bsafes?\b|cookware|\bmugs?\b/],
  ["sports", "sports & outdoor",
    /bicycle|\bbike\b|helmet|scooter|treadmill|exercise|kayak|\batv\b|snowmobile|fire pit|\bgrills?\b|trampoline|golf cart|firework|paddle|harness|motorcycle|lawn ?mower|\bmowers?\b|off[- ]?(?:road|highway)|scuba|diving|\bdive\b|climbing|zipline|\bpool\b|watersport|\bvisors?\b|snowblower|chainsaw/],
];

/* Which rule set an agency's notices are even eligible for. CPSC has no
 * jurisdiction over food; FSIS and FDA's food centre have none over
 * appliances. Anything unlisted falls through to the goods rules, which is
 * the safer default for an unknown consumer-product feed. */
const FOOD_SOURCES = new Set(["FDA Food", "USDA FSIS"]);

export function categoryFor(r) {
  // Trust the feed before the text: FDA drug/device recalls are categorical.
  if (r.source === "FDA Drug") return { key: "drug", label: "medication" };
  if (r.source === "FDA Device") return { key: "device", label: "medical device" };

  /* Only the product. See the note at the top: a hazard paragraph describes
   * the injury, not the thing, and reading it filed a third of CPSC under
   * "kids & baby" because that is who the hazards endanger. */
  const text = String(r.product || "").toLowerCase();
  const food = FOOD_SOURCES.has(r.source);

  for (const [key, label, re] of (food ? FOOD_RULES : GOODS_RULES)) {
    if (re.test(text)) return { key, label };
  }
  return food ? { key: "food", label: "food" } : { key: "product", label: "consumer product" };
}
