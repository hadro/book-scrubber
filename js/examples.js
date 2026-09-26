// The starter shelf. `input` can be anything resolveInput() understands:
// a manifest URL, a catalog page URL, or a bare Internet Archive identifier.
// Titles here are just placeholders until the manifest loads. `page` (optional)
// is the item's web page, for when it can't be worked out from `input` or the
// manifest's own `homepage`.

export const SOURCES = {
  ia: { name: "Internet Archive", short: "IA", color: "var(--c-ia)" },
  loc: { name: "Library of Congress", short: "LoC", color: "var(--c-loc)" },
  nypl: { name: "NYPL", short: "NYPL", color: "var(--c-nypl)" },
  bhl: { name: "Biodiversity Heritage Library", short: "BHL", color: "var(--c-bhl)" },
  ecod: { name: "e-codices", short: "e-cod", color: "var(--c-ecod)" },
  nga: { name: "National Gallery of Art Library", short: "NGA", color: "var(--c-nga)" },
  getty: { name: "Getty Museum", short: "Getty", color: "var(--c-getty)" },
  mine: { name: "Your pick", short: "yours", color: "var(--c-mine)" },
};

export const EXAMPLES = [
  {
    source: "ia",
    title: "Kunstformen der Natur",
    note: "Haeckel, 1904",
    input: "https://archive.org/details/kunstformenderna00haec",
  },
  // {
  //   source: "loc",
  //   title: "The Wonderful Wizard of Oz",
  //   note: "Baum & Denslow, 1900",
  //   input: "https://www.loc.gov/item/03032405/",
  // },
  {
    // Title comes from the manifest.
    source: "loc",
    note: "Library of Congress",
    input: "https://www.loc.gov/item/73644404/",
  },
  //{
  //  source: "nypl",
  //  title: "The Negro Motorist Green-Book",
  //  note: "1940 edition",
  //  input: "https://digitalcollections.nypl.org/items/dce441f0-83d3-0132-efca-58d385a7b928",
  //},
  {
    source: "nypl",
    title: "Shiohi no tsuto (Gifts of the Ebb Tide)",
    note: "Utamaro, 1789 · woodblock shells",
    input: "https://digitalcollections.nypl.org/items/4832eb40-c83f-0133-4c16-00505686a51c",
  },
  {
    source: "nypl",
    title: "Tsuki hyakushi (One Hundred Aspects of the Moon)",
    note: "Yoshitoshi · woodblock prints",
    input: "https://digitalcollections.nypl.org/items/b697e0f0-61e0-013a-bcee-0242ac110003",
  },
  {
    // BHL's own scan. BHL has no reliable manifest endpoint, so this goes
    // through the Internet Archive's IIIF server, where BHL hosts its scans.
    source: "bhl",
    title: "The Birds of America, v.1",
    note: "Audubon, 1840 octavo · BHL scan",
    input: "https://archive.org/details/birdsofamericafr01audu",
  },
  {
    source: "ia",
    title: "The Birds of America, Vol. 1",
    note: "Audubon, folio plates",
    input: "https://archive.org/details/audubon-4477-volume1",
  },
  {
    source: "ia",
    title: "Hortus Eystettensis",
    note: "Besler, 1613 · Wellcome copy",
    input: "https://archive.org/details/b33498854",
  },
  {
    // Title comes from the manifest.
    source: "nga",
    note: "National Gallery of Art Library",
    input:
      "https://library.nga.gov/discovery/fulldisplay?context=L&vid=01NGA_INST:NGA&search_scope=MainLibrary&tab=MainLibrary&lang=en&docid=alma99826713504896",
  },
 // {
 //   source: "getty",
 //   title: "Japanese Album",
 //   note: "Kusakabe Kimbei, 1870s–1890s",
 //   input: "https://media.getty.edu/iiif/manifest/3/ad56409c-f51e-4c33-a49b-0d49234a32b6",
 //   page: "https://www.getty.edu/art/collection/object/104GAQ",
 // },
  {
    // Title comes from the manifest.
    source: "getty",
    note: "Getty Museum album",
    input: "https://media.getty.edu/iiif/manifest/3/01b5ac79-78d9-4900-a51b-5ba13c19b6de",
  },
  //{
  //  source: "ia",
  //  title: "Alice's Adventures in Wonderland",
  //  note: "Carroll & Tenniel",
  //  input: "https://archive.org/details/carroll-lewis-alices-adventures-in-wonderland-illustrated-by-tenniel-john.-v-1.0",
  //},
  {
    // Title comes from the manifest.
    source: "getty",
    note: "Getty Museum album",
    input: "https://media.getty.edu/iiif/manifest/3/d4ce5921-731f-4347-945a-bafd815da340",
  },
  {
    source: "ecod",
    title: "St. Gallen, Cod. Sang. 40",
    note: "Medieval manuscript",
    input: "https://www.e-codices.unifr.ch/metadata/iiif/csg-0040/manifest.json",
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
    if (host.endsWith("nga.gov")) return "nga";
    if (host.endsWith("getty.edu")) return "getty";
  } catch {}
  return "mine";
}
