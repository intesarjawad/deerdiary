# Prediction fixtures

Hand-built inputs for the import specs, not model outputs. Both describe the same six-photo card,
which `tests/fixtures/predictions.ts` drops with the file dates listed there.

| Photo        | File date (UTC)     | Detections              |
| ------------ | ------------------- | ----------------------- |
| IMG_0001.JPG | 2025-10-01 05:00:00 | two white-tailed deer   |
| IMG_0002.JPG | 2025-10-01 05:00:20 | one white-tailed deer   |
| IMG_0003.JPG | 2025-10-01 22:10:00 | one white-tailed deer   |
| IMG_0004.JPG | 2025-10-02 03:00:00 | one American black bear |
| IMG_0005.JPG | 2025-10-02 12:00:00 | none                    |
| IMG_0006.JPG | 2025-10-02 14:00:00 | one person              |

- `predictions.speciesnet.json`: SpeciesNet format, five raw classes per animal detection.
- `predictions.md.json`: MegaDetector format, two classifications per animal detection.

`diary.spec.ts` asserts, for both files:

- Card order: white-tailed deer, then American black bear.
- White-tailed deer: 2 independent detections (IMG_0001 and IMG_0002 are one burst), 3 photos,
  MaxN 2.
- American black bear: 1 independent detection, 1 photo, MaxN 1.
- Footer: 6 photos, 2 species, 1 person.

`country.spec.ts` cuts the SpeciesNet file to two raw classes per detection, changes the country
and asserts the same cards and the "Country fixed by the imported file" note.
