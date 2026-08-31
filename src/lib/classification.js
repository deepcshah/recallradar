/* What the agencies' severity words actually mean.
 *
 * "Class I" is on the most alarming badge in the app and it is the one piece
 * of copy on a recall card that is not English — it is an FDA term of art
 * that happens to look like an ordinal. Read casually it suggests "the first
 * one" or even "the mildest"; it means the opposite. The same badge also
 * carries USDA's risk words, which are the same three classes wearing
 * different labels, and CPSC's, which do not exist at all.
 *
 * So the badge explains itself. `classInfo` turns a normalized recall into
 * the plain-English gloss the badge discloses on hover or tap; it returns
 * null only when there is genuinely nothing to say.
 *
 * Wording is deliberately paraphrase, not quotation: the definitions are the
 * agencies', the sentences are ours, because "a reasonable probability that
 * the use of, or exposure to, a violative product will cause serious adverse
 * health consequences or death" is a legal test and not a thing to read on a
 * phone in a grocery aisle.
 */

const CLASSES = {
  I: {
    term: "Class I",
    plain: "the most serious class",
    body: "The agency believes eating, taking or using this product could cause " +
          "serious harm or death. If you have it, do not use it — the notice says " +
          "whether to return it, throw it away, or call a doctor.",
  },
  II: {
    term: "Class II",
    plain: "the middle of the scale",
    body: "This product could cause a temporary health problem, or one a doctor " +
          "can reverse. Serious harm is considered unlikely but not impossible.",
  },
  III: {
    term: "Class III",
    plain: "the least serious class",
    body: "This product is unlikely to make anyone ill. It is usually recalled for " +
          "breaking a labelling or manufacturing rule rather than for a health risk.",
  },
};

/* Who assigns the class, and where the three-class scale comes from. FDA and
 * USDA run the same scale under different names; CPSC runs none. */
const SCALES = {
  "FDA Food": "FDA",
  "FDA Drug": "FDA",
  "FDA Device": "FDA",
  "USDA FSIS": "USDA FSIS",
};

/**
 * Plain-English gloss for a recall's severity badge.
 * @returns {{term: string, plain: string, body: string, agency: string}|null}
 */
export function classInfo(recall) {
  const raw = String((recall && recall.classification) || "");
  const source = String((recall && recall.source) || "");
  const agency = SCALES[source] || source || "the agency";

  /* USDA issues these instead of a recall when a risky product is already off
   * the shelves, or when a company refuses to recall. It carries no class, so
   * it must not be read as a mild one. */
  if (/public health alert/i.test(raw)) {
    return {
      term: "Public Health Alert",
      plain: "a warning, not a recall",
      body: "USDA issues one when a product is a risk but no recall is happening — " +
            "usually because it is no longer being sold, or because the company will " +
            "not recall it. Treat the hazard as real.",
      agency: "USDA FSIS",
    };
  }

  /* USDA writes "High - Class I"; FDA writes "Class I". One test reads both.
   * Ordered longest-first so "Class III" cannot match the "Class I" pattern. */
  const m = /class\s+(iii|ii|i)(?![a-z])/i.exec(raw);
  if (m) {
    const c = CLASSES[m[1].toUpperCase()];
    return { ...c, agency };
  }

  /* CPSC publishes a hazard, never a class. The app used to print "Medium
   * risk" on every CPSC card, which is an assessment CPSC never made and this
   * app is in no position to make. */
  if (source === "CPSC") {
    return {
      term: "Not classified",
      plain: "CPSC does not rank recalls",
      body: "Consumer product recalls carry no severity class. Judge this one by the " +
            "hazard named on the card and by the official notice.",
      agency: "CPSC",
    };
  }

  return null;
}

/** Badge text: the agency's own words where it has them. */
export function severityLabel(recall) {
  if (recall && recall.classification) return recall.classification;
  if (recall && recall.source === "CPSC") return "Not classified";
  return { high: "High risk", med: "Medium risk", low: "Lower risk" }[recall && recall.severity] || "Unclassified";
}

/** Badge colour. An unclassified CPSC notice is never tinted as if it were a
 *  middle class — an absent assessment is not a moderate one. */
export function severityVariant(recall) {
  if (recall && recall.source === "CPSC" && !recall.classification) return "low";
  return (recall && recall.severity) || "low";
}
