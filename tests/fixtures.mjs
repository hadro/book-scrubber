// Synthetic manifests shaped like the ones real libraries publish.
// `base` lets the e2e test point image services at its local fake server.

export function v2Manifest(n, { base = "https://img.example.org/iiif", label = "A v2 book" } = {}) {
  return {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": "https://example.org/v2/manifest",
    "@type": "sc:Manifest",
    label,
    attribution: "<span>Some Library</span>",
    sequences: [
      {
        "@type": "sc:Sequence",
        canvases: Array.from({ length: n }, (_, i) => ({
          "@id": `https://example.org/v2/canvas/${i}`,
          "@type": "sc:Canvas",
          label: String(i + 1),
          width: 1500,
          height: 2000,
          images: [
            {
              "@type": "oa:Annotation",
              motivation: "sc:painting",
              resource: {
                "@id": `${base}/p${i}/full/full/0/default.jpg`,
                "@type": "dctypes:Image",
                service: {
                  "@context": "http://iiif.io/api/image/2/context.json",
                  "@id": `${base}/p${i}`,
                  profile: "http://iiif.io/api/image/2/level2.json",
                },
              },
              on: `https://example.org/v2/canvas/${i}`,
            },
          ],
        })),
      },
    ],
  };
}

export function v3Manifest(n, { base = "https://img.example.org/iiif3", label = "A v3 book", rtl = false, direction = rtl ? "right-to-left" : null } = {}) {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: "https://example.org/v3/manifest",
    type: "Manifest",
    label: { en: [label] },
    requiredStatement: { label: { en: ["Attribution"] }, value: { en: ["Provided by a museum"] } },
    ...(direction ? { viewingDirection: direction } : {}),
    items: Array.from({ length: n }, (_, i) => ({
      id: `https://example.org/v3/canvas/${i}`,
      type: "Canvas",
      label: { none: [`p. ${i + 1}`] },
      width: 1200,
      height: 1800,
      items: [
        {
          id: `https://example.org/v3/page/${i}`,
          type: "AnnotationPage",
          items: [
            {
              id: `https://example.org/v3/anno/${i}`,
              type: "Annotation",
              motivation: "painting",
              target: `https://example.org/v3/canvas/${i}`,
              body: {
                id: `${base}/p${i}/full/max/0/default.jpg`,
                type: "Image",
                format: "image/jpeg",
                service: [{ id: `${base}/p${i}`, type: "ImageService3", profile: "level2" }],
              },
            },
          ],
        },
      ],
    })),
  };
}
