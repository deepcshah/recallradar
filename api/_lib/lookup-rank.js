/* The ranking lives in src/lib/relevance.js so the browser's index search
 * applies the same tiers as /api/lookup; this module keeps the server's import
 * path. api/_lib is not a function (see vercel.json / the 12-function cap). */
export { relevanceOf, rankMatches } from "../../src/lib/relevance.js";
