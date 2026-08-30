/* Classify a recall into a product category so the UI can show an icon and
 * label. Pure text heuristics — none of the government feeds carry a
 * machine-readable category, and only CPSC provides product photos.
 * Returns { key, label }; keys map to icons in App.jsx.
 */

const RULES = [
  ["pet", "pet food & pets", /\b(?:dog|cat|pet)s?\b[^.]*\b(?:food|treat|chew|kibble)|pet food/],
  ["kids", "kids & baby", /\binfant|\bbab(?:y|ies)\b(?!\s+(?:spinach|carrots?|corn|kale|greens|bella|arugula|potato|lettuce|back|portabella))|toddler|crib|stroller|pacifier|nursery|children|child\b|kids\b|youth|plush|\btoy\b|toys\b/],
  ["supplement", "supplement", /supplement|vitamin|gummies|protein powder|herbal|probiotic/],
  ["drug", "medication", /\btablets?\b|\bcapsules?\b|\binjection\b|\brx only\b|ointment|\busp\b/],
  ["electrical", "electrical", /\bbatter(?:y|ies)\b|lithium|charger|power bank|extension cord|power strip|generator|solar panel/],
  ["appliance", "appliance", /heater|blender|\boven\b|microwave|refrigerator|freezer|dehumidifier|air fryer|toaster|washer|dryer|vacuum|humidifier|coffee maker|kettle/],
  ["home", "home & furniture", /furniture|dresser|\bchair\b|\btable\b|\blamp\b|mattress|\bsofa\b|bed frame|shelf|bookcase|candle|ladder|blanket|curtain/],
  ["sports", "sports & outdoor", /bicycle|\bbike\b|helmet|scooter|treadmill|exercise|kayak|\batv\b|snowmobile|fire pit|\bgrill\b|trampoline|golf cart/],
  ["meat", "meat & poultry", /\bbeef\b|\bpork\b|chicken|turkey|sausage|\bham\b|\bmeat\b|poultry|salami|bacon|jerky|hot dog|brisket|ribs\b/],
  ["seafood", "seafood", /\bfish\b|salmon|\btuna\b|shrimp|oyster|\bcrabs?\b|\bclams?\b|seafood|scallop|lobster|caviar|tilapia/],
  ["dairy", "dairy & eggs", /\bmilk\b|cheese|yogurt|dairy|butter|ice cream|\beggs?\b|queso|gelato/],
  ["produce", "produce", /lettuce|spinach|salad|onion|tomato|cucumber|carrot|apple|peach|mango|avocado|broccoli|greens\b|berr(?:y|ies)|melon|grape|fruit|vegetable|produce|cilantro|parsley|kale|potato|pepper|cantaloupe|enoki|mushroom/],
  ["grains", "bakery & grains", /\bbread\b|flour|cereal|pasta|cracker|granola|bakery|\bcake\b|wheat|\boats?\b|tortilla|muffin|bagel|\brice\b|noodle/],
  ["snacks", "snacks & candy", /candy|chocolate|cookie|gumm(?:i|y)|snack|chips\b|popcorn|caramel|pretzel/],
  ["beverage", "beverages", /juice|beverage|\bdrink\b|\bwater\b|\bsoda\b|coffee|\btea\b|smoothie|kombucha|\bshake\b/],
  ["pantry", "pantry & prepared", /peanut|almond|cashew|pistachio|\bnuts?\b|tahini|hummus|sauce|\bsoup\b|dressing|spice|seasoning|salsa|dip\b|wrap\b|sandwich|burrito|entree|meal\b/],
];

export function categoryFor(r) {
  // Trust the feed before the text: FDA drug/device recalls are categorical.
  if (r.source === "FDA Drug") return { key: "drug", label: "medication" };
  if (r.source === "FDA Device") return { key: "device", label: "medical device" };

  const text = `${r.product || ""} ${r.reason || ""}`.toLowerCase();
  for (const [key, label, re] of RULES) {
    if (re.test(text)) return { key, label };
  }
  if (r.source === "FDA Food" || r.source === "USDA FSIS") return { key: "food", label: "food" };
  return { key: "product", label: "consumer product" };
}
