/* Classify a recall by WHY it was recalled, so the list can be filtered by
 * hazard rather than only by product type.
 *
 * "What kind of thing is it" and "what is wrong with it" are different
 * questions, and the second is the one people actually arrive with: someone
 * with a peanut allergy wants every undeclared-allergen notice regardless of
 * whether it landed on a cracker or a sauce.
 *
 * None of the three feeds carries a machine-readable hazard field we can
 * trust across sources — CPSC has a Hazards array of free text, FSIS has a
 * short reason phrase, openFDA has a paragraph of prose — so this is text
 * heuristics over the same `reason` string the card already shows.
 *
 * Order is load-bearing. The named pathogens are tested before the generic
 * contamination catch-all, and allergens go first because "undeclared milk"
 * is the single most common food recall reason and its text often also
 * mentions the word "contamination".
 *
 * Returns { key, label }; keys are stable and used as filter values.
 */

const RULES = [
  ["allergen", "Undeclared allergen",
    /undeclared|allergen|not declared|mislabel[^.]*\b(?:milk|egg|soy|wheat|peanut|nut|sesame|fish|shellfish)|contains? (?:undeclared|milk|egg|soy|wheat|peanut|tree nut|sesame)|unreported allergen|allergic reaction/],

  ["listeria", "Listeria",
    /listeri/],

  ["salmonella", "Salmonella",
    /salmonell/],

  ["ecoli", "E. coli",
    /\be\.? ?coli\b|escherichia|shiga toxin|stec\b|o157/],

  ["contamination", "Other contamination",
    /botulism|clostridium|hepatitis|norovirus|cronobacter|staphyloc|campylobact|\bmold\b|\byeast\b|microbial|pathogen|bacteri|insanitary|unsanitary|foodborne|contaminat|adulterat|spoil|sterility|non-?sterile/],

  ["foreign", "Foreign material",
    /foreign (?:material|object|matter|body)|\bmetal\b|\bplastic\b|\bglass\b|\bbone\b|\brubber\b|\bwood\b|extraneous material|hard or sharp/],

  ["chemical", "Chemical or toxin",
    /\blead\b|benzene|nitrosamine|\barsenic\b|cadmium|mercury|pesticide|toxin|toxic|poison|carcinog|ethylene oxide|melamine|aflatoxin|chemical burn/],

  ["fire", "Fire, burn or shock",
    /fire hazard|\bfire\b|burn hazard|\bburns?\b|overheat|thermal|explosion|explode|smoke hazard|electric(?:al)? shock|electrocution|shock hazard|short circuit|battery (?:fail|swell|fire)/],

  ["choking", "Choking hazard",
    /chok(?:e|ing)|aspiration|suffocat|strangulat|small parts?/],

  ["injury", "Injury hazard",
    /laceration|amputation|crush(?:ing)? hazard|fall hazard|\bfalls?\b|tip[- ]over|entrapment|impact hazard|drowning|collision|\bcrash\b|puncture|\bsharp\b|\bcut\b|injury hazard|risk of injury/],

  ["labeling", "Labeling or packaging",
    /mislabel|incorrect label|wrong (?:label|product|item)|labeling error|misbrand|packaging (?:defect|error)|child[- ]resistant|poison prevention|missing (?:label|warning|instruction)|illegible|incorrect (?:dose|dosage|strength)/],

  ["quality", "Quality or process defect",
    /subpotent|superpotent|out of specification|impurit|degradat|dissolution|potency|stability|processing deviation|produced without|without benefit of inspection|temperature abuse|unapproved|failed to meet|does not meet|manufacturing defect|assembly (?:defect|error)/],
];

export function reasonFor(r) {
  const text = `${r.reason || ""} ${r.classification || ""}`.toLowerCase();
  if (!text.trim()) return { key: "unspecified", label: "Reason not stated" };
  for (const [key, label, re] of RULES) {
    if (re.test(text)) return { key, label };
  }
  return { key: "other", label: "Other reason" };
}

/* Filter menus read better grouped than alphabetised: the four biological
 * hazards belong together, and "Other" belongs at the bottom whatever its
 * count. This is the display order; options absent from the current data are
 * simply never rendered. */
export const REASON_ORDER = [
  "allergen", "listeria", "salmonella", "ecoli", "contamination",
  "foreign", "chemical", "fire", "choking", "injury",
  "labeling", "quality", "other", "unspecified",
];
