/* Known US retail chains: used to (a) spot chains named in recall notice text
 * and (b) confirm that a place returned by Mapbox Search really is that chain.
 * `match`  — regex fragment applied (case-insensitive, word-bounded) to recall text.
 * `label`  — the human name we hand to Mapbox as the search query.
 * `osm`    — regex fragment matched against the returned place name.
 */



export const RAW_CHAINS = [
  // -- big box / club --------------------------------------------------
  { id: "walmart",      label: "Walmart",            match: "wal[\\s-]?mart",              osm: "walmart" },
  { id: "target",       label: "Target",             match: "target(?:\\s+stores?)?",     osm: "^target\\b" },
  { id: "costco",       label: "Costco",             match: "costco",                      osm: "costco" },
  { id: "samsclub",     label: "Sam's Club",         match: "sam'?s\\s+club",              osm: "sam'?s club" },
  { id: "bjs",          label: "BJ's Wholesale",     match: "bj'?s(?:\\s+wholesale)?",     osm: "bj'?s" },
  // -- grocery ---------------------------------------------------------
  { id: "kroger",       label: "Kroger",             match: "kroger",                      osm: "kroger" },
  { id: "albertsons",   label: "Albertsons",         match: "albertson'?s?",               osm: "albertsons" },
  { id: "safeway",      label: "Safeway",            match: "safeway",                     osm: "safeway" },
  { id: "publix",       label: "Publix",             match: "publix",                      osm: "publix" },
  { id: "aldi",         label: "ALDI",               match: "aldi",                        osm: "^aldi\\b" },
  { id: "lidl",         label: "Lidl",               match: "lidl",                        osm: "lidl" },
  { id: "traderjoes",   label: "Trader Joe's",       match: "trader\\s+joe'?s",            osm: "trader joe" },
  { id: "wholefoods",   label: "Whole Foods",        match: "whole\\s+foods",              osm: "whole foods" },
  { id: "wegmans",      label: "Wegmans",            match: "wegman'?s?",                  osm: "wegmans" },
  { id: "heb",          label: "H-E-B",              match: "h[\\s.-]?e[\\s.-]?b\\b",      osm: "h-e-b|heb\\b" },
  { id: "meijer",       label: "Meijer",             match: "meijer",                      osm: "meijer" },
  { id: "winco",        label: "WinCo Foods",        match: "winco",                       osm: "winco" },
  { id: "sprouts",      label: "Sprouts",            match: "sprouts\\s+farmers?\\s+market|sprouts", osm: "sprouts" },
  { id: "gianteagle",   label: "Giant Eagle",        match: "giant\\s+eagle",              osm: "giant eagle" },
  { id: "giantfood",    label: "Giant Food",         match: "giant\\s+food",               osm: "^giant\\b" },
  { id: "stopshop",     label: "Stop & Shop",        match: "stop\\s*&\\s*shop|stop\\s+and\\s+shop", osm: "stop *& *shop" },
  { id: "foodlion",     label: "Food Lion",          match: "food\\s+lion",                osm: "food lion" },
  { id: "harristeeter", label: "Harris Teeter",      match: "harris\\s+teeter",            osm: "harris teeter" },
  { id: "shoprite",     label: "ShopRite",           match: "shop\\s?rite",                osm: "shoprite" },
  { id: "hyvee",        label: "Hy-Vee",             match: "hy[\\s-]?vee",                osm: "hy-?vee" },
  { id: "vons",         label: "Vons",               match: "\\bvons\\b",                  osm: "^vons\\b" },
  { id: "ralphs",       label: "Ralphs",             match: "ralph'?s\\b",                 osm: "ralphs" },
  { id: "fredmeyer",    label: "Fred Meyer",         match: "fred\\s+meyer",               osm: "fred meyer" },
  { id: "frys",         label: "Fry's Food",         match: "fry'?s\\s+(?:food|marketplace)", osm: "fry'?s" },
  { id: "kingsoopers",  label: "King Soopers",       match: "king\\s+soopers",             osm: "king soopers" },
  { id: "smiths",       label: "Smith's",            match: "smith'?s\\s+(?:food|marketplace|grocery)", osm: "smith'?s" },
  { id: "qfc",          label: "QFC",                match: "\\bqfc\\b|quality\\s+food\\s+centers?", osm: "qfc" },
  { id: "jewelosco",    label: "Jewel-Osco",         match: "jewel[\\s-]?osco|\\bjewel\\b", osm: "jewel" },
  { id: "acme",         label: "ACME Markets",       match: "acme\\s+markets?",            osm: "^acme\\b" },
  { id: "shaws",        label: "Shaw's",             match: "shaw'?s\\b",                  osm: "shaw'?s" },
  { id: "starmarket",   label: "Star Market",        match: "star\\s+market",              osm: "star market" },
  { id: "tomthumb",     label: "Tom Thumb",          match: "tom\\s+thumb",                osm: "tom thumb" },
  { id: "randalls",     label: "Randalls",           match: "randall'?s\\b",               osm: "randalls" },
  { id: "pavilions",    label: "Pavilions",          match: "pavilions",                   osm: "pavilions" },
  { id: "piggly",       label: "Piggly Wiggly",      match: "piggly\\s+wiggly",            osm: "piggly wiggly" },
  { id: "weis",         label: "Weis Markets",       match: "weis\\s+markets?",            osm: "^weis\\b" },
  { id: "ingles",       label: "Ingles",             match: "ingles\\s+markets?|\\bingles\\b", osm: "ingles" },
  { id: "schnucks",     label: "Schnucks",           match: "schnuck'?s?",                 osm: "schnucks" },
  { id: "raleys",       label: "Raley's",            match: "raley'?s",                    osm: "raley'?s" },
  { id: "staterbros",   label: "Stater Bros.",       match: "stater\\s+bros",              osm: "stater bros" },
  { id: "luckys",       label: "Lucky",              match: "lucky\\s+(?:supermarkets?|stores?)", osm: "^lucky\\b" },
  { id: "foodmaxx",     label: "FoodMaxx",           match: "food\\s?maxx",                osm: "foodmaxx" },
  { id: "saveal",       label: "Save A Lot",         match: "save[\\s-]?a[\\s-]?lot",      osm: "save-?a-?lot" },
  { id: "groceryoutlet",label: "Grocery Outlet",     match: "grocery\\s+outlet",           osm: "grocery outlet" },
  { id: "freshmarket",  label: "The Fresh Market",   match: "the\\s+fresh\\s+market",      osm: "the fresh market" },
  { id: "naturalgrocers", label: "Natural Grocers",  match: "natural\\s+grocers",          osm: "natural grocers" },
  { id: "99ranch",      label: "99 Ranch Market",    match: "99\\s+ranch",                 osm: "99 ranch" },
  { id: "brookshire",   label: "Brookshire's",       match: "brookshire'?s?",              osm: "brookshire" },
  { id: "foodcity",     label: "Food City",          match: "food\\s+city",                osm: "food city" },
  { id: "winn",         label: "Winn-Dixie",         match: "winn[\\s-]?dixie",            osm: "winn-?dixie" },
  { id: "marketbasket", label: "Market Basket",      match: "market\\s+basket",            osm: "market basket" },
  // -- pharmacy / convenience / dollar --------------------------------
  { id: "cvs",          label: "CVS",                match: "\\bcvs\\b",                   osm: "cvs" },
  { id: "walgreens",    label: "Walgreens",          match: "walgreen'?s?",                osm: "walgreens" },
  { id: "riteaid",      label: "Rite Aid",           match: "rite\\s+aid",                 osm: "rite aid" },
  { id: "dollargeneral",label: "Dollar General",     match: "dollar\\s+general",           osm: "dollar general" },
  { id: "dollartree",   label: "Dollar Tree",        match: "dollar\\s+tree",              osm: "dollar tree" },
  { id: "familydollar", label: "Family Dollar",      match: "family\\s+dollar",            osm: "family dollar" },
  { id: "fivebelow",    label: "Five Below",         match: "five\\s+below",               osm: "five below" },
  { id: "biglots",      label: "Big Lots",           match: "big\\s+lots",                 osm: "big lots" },
  { id: "seveneleven",  label: "7-Eleven",           match: "7[\\s-]?eleven",              osm: "7-?eleven" },
  { id: "circlek",      label: "Circle K",           match: "circle\\s+k\\b",              osm: "circle k" },
  { id: "ollies",       label: "Ollie's",            match: "ollie'?s\\s+bargain",         osm: "ollie'?s" },
  // -- home / hardware / specialty ------------------------------------
  { id: "homedepot",    label: "Home Depot",         match: "home\\s+depot",               osm: "home depot" },
  { id: "lowes",        label: "Lowe's",             match: "lowe'?s\\b",                  osm: "lowe'?s" },
  { id: "acehardware",  label: "Ace Hardware",       match: "ace\\s+hardware",             osm: "ace hardware" },
  { id: "menards",      label: "Menards",            match: "menards?",                    osm: "menards" },
  { id: "tractorsupply",label: "Tractor Supply",     match: "tractor\\s+supply",           osm: "tractor supply" },
  { id: "bestbuy",      label: "Best Buy",           match: "best\\s+buy",                 osm: "best buy" },
  { id: "petsmart",     label: "PetSmart",           match: "pet\\s?smart",                osm: "petsmart" },
  { id: "petco",        label: "Petco",              match: "petco",                       osm: "petco" },
  { id: "rei",          label: "REI",                match: "\\brei\\b",                   osm: "^rei\\b" },
  { id: "dicks",        label: "Dick's Sporting Goods", match: "dick'?s\\s+sporting",      osm: "dick'?s sporting" },
  { id: "basspro",      label: "Bass Pro Shops",     match: "bass\\s+pro",                 osm: "bass pro" },
  { id: "cabelas",      label: "Cabela's",           match: "cabela'?s",                   osm: "cabela'?s" },
  { id: "michaels",     label: "Michaels",           match: "michaels\\s+stores?|\\bmichaels\\b", osm: "michaels" },
  { id: "hobbylobby",   label: "Hobby Lobby",        match: "hobby\\s+lobby",              osm: "hobby lobby" },
  { id: "ikea",         label: "IKEA",               match: "\\bikea\\b",                  osm: "ikea" },
  { id: "ross",         label: "Ross",               match: "ross\\s+(?:stores|dress)",    osm: "ross" },
  { id: "tjmaxx",       label: "T.J. Maxx",          match: "t\\.?\\s?j\\.?\\s?maxx",      osm: "t\\.? ?j\\.? ?maxx" },
  { id: "marshalls",    label: "Marshalls",          match: "marshalls",                   osm: "marshalls" },
  { id: "homegoods",    label: "HomeGoods",          match: "home\\s?goods",               osm: "homegoods" },
  { id: "burlington",   label: "Burlington",         match: "burlington\\s+(?:stores?|coat)", osm: "burlington" },
  { id: "kohls",        label: "Kohl's",             match: "kohl'?s",                     osm: "kohl'?s" },
  { id: "macys",        label: "Macy's",             match: "macy'?s",                     osm: "macy'?s" },
  { id: "nordstrom",    label: "Nordstrom",          match: "nordstrom",                   osm: "nordstrom" },
];

// Precompile text-matching regexes with loose word boundaries
// (chain names contain apostrophes, digits and hyphens, so \b alone is unreliable).
const compiled = RAW_CHAINS.map((c) => ({
  ...c,
  re: new RegExp("(^|[^a-z0-9])(?:" + c.match + ")(?=$|[^a-z0-9])", "i"),
}));

/** Return chain objects whose name appears in the given text. */
function chainsInText(text) {
  if (!text) return [];
  return compiled.filter((c) => c.re.test(text));
}

function byId(id) {
  return compiled.find((c) => c.id === id) || null;
}

/** The chain a storefront name belongs to, or null if it is an independent.
 *  Category search returns chains and corner stores in one list; this is what
 *  separates them. */
function chainForName(name) {
  if (!name) return null;
  return compiled.find((c) => c.re.test(name)) || null;
}

/* Most FDA notices name no retailer at all ("Nationwide", a bare state list),
 * so a store list built only from recall text misses nearly every grocery
 * store near you. We always look these up as well, then annotate whichever
 * ones a recall actually names. */
const ALWAYS_NEARBY = [
  "walmart", "target", "costco", "samsclub", "kroger", "safeway", "albertsons",
  "publix", "aldi", "traderjoes", "wholefoods", "heb", "meijer", "wegmans",
  "cvs", "walgreens", "riteaid", "dollargeneral",
];

/** Chain objects we search for near every location, recalls or not. */
export const DEFAULT_NEARBY_CHAINS = ALWAYS_NEARBY.map(byId).filter(Boolean);

export const CHAINS = compiled;
export { chainsInText, byId, chainForName };
