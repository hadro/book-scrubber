// The starter shelf. `input` can be anything resolveInput() understands:
// a manifest URL, a catalog page URL, or a bare Internet Archive identifier.
// Titles here are just placeholders until the manifest loads.

export const SOURCES = {
  ia: { name: "Internet Archive", short: "IA", color: "var(--c-ia)" },
  loc: { name: "Library of Congress", short: "LoC", color: "var(--c-loc)" },
  nypl: { name: "NYPL", short: "NYPL", color: "var(--c-nypl)" },
  bhl: { name: "Biodiversity Heritage Library", short: "BHL", color: "var(--c-bhl)" },
  ecod: { name: "e-codices", short: "e-cod", color: "var(--c-ecod)" },
  mine: { name: "Your pick", short: "yours", color: "var(--c-mine)" },
};

export const EXAMPLES = [
  {
    source: "ia",
    title: "Kunstformen der Natur",
    note: "Haeckel, 1904",
    input: "https://archive.org/details/kunstformenderna00haec",
  },
  {
    source: "loc",
    title: "The Wonderful Wizard of Oz",
    note: "Baum & Denslow, 1900",
    input: "https://www.loc.gov/item/03032405/",
  },
  {
    source: "nypl",
    title: "The Negro Motorist Green-Book",
    note: "1940 edition",
    input: "https://digitalcollections.nypl.org/items/dce441f0-83d3-0132-efca-58d385a7b928",
  },
  {
    source: "bhl",
    title: "Hortus Eystettensis",
    note: "Besler, 1613",
    input: "https://www.biodiversitylibrary.org/item/98364",
  },
  {
    source: "bhl",
    title: "The Birds of America, v.1",
    note: "Audubon, 1840",
    input: "https://www.biodiversitylibrary.org/item/124833",
  },
  {
    source: "ia",
    title: "Alice's Adventures in Wonderland",
    note: "Carroll & Tenniel",
    input: "https://archive.org/details/carroll-lewis-alices-adventures-in-wonderland-illustrated-by-tenniel-john.-v-1.0",
  },
  {
    source: "ecod",
    title: "St. Gallen, Cod. Sang. 40",
    note: "Medieval manuscript",
    input: "https://www.e-codices.unifr.ch/metadata/iiif/csg-0040/manifest.json",
  },
  {
    source: "ia",
    title: "A Wellcome Library book",
    note: "via IA's IIIF docs",
    input: "b29000427_0001",
  },
];

/** Guess a source key from a manifest URL so pasted items get the right sticker. */
export function guessSource(url) {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("archive.org")) return "ia";
    if (host.endsWith("loc.gov")) return "loc";
    if (host.endsWith("nypl.org")) return "nypl";
    if (host.endsWith("biodiversitylibrary.org")) return "bhl";
    if (host.endsWith("e-codices.unifr.ch")) return "ecod";
  } catch {}
  return "mine";
}
