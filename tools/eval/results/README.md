# Agreement evaluation inputs

These are inference results and metadata, not photos or weights. The 2,000-image
checksum list is `../lists/eval_2000.txt`; image bytes live in the ignored
`../data/eval_2000/` directory.

- `dataset.json`: selected ENA24 COCO records, animal boxes, image dimensions,
  checksums, source metadata hash and substitute-holdout provenance. Original
  data: University of Missouri (2016); COCO conversion: Vardhan Duvvuri, as named
  in the source metadata. [ENA24 on LILA](https://lila.science/datasets/ena24detection).
- `taxonomy.txt`: newline-normalized SpeciesNet v4.0.3a taxonomy snapshot, from
  the cached Google SpeciesNet model. Used to verify all 23 ENA24 mapping targets.
  Its Apache 2.0 terms are preserved in `SPECIESNET-LICENSE`.
- `official_usa.json` and `wild_default.json`: all serialized pipeline predictions,
  including raw top-five classifications and processed labels. Each export
  has a small index and 20 checksum-verified gzip shards of 100 images in its
  namesake directory; JSON values are preserved without rounding or filtering.
  Official paths
  are normalized relative to the evaluation directory; prediction fields remain.
- The `.run.json` records preserve versions and timings. `wild_models.json`
  records checked sizes and SHA-256 of the exact app-selected model exports.
- `downloads.json`: accounted network payload and a separate allowance for
  unmetered overhead. Images, weights and environments are not committed.

Regenerate the report with `npm run eval:report`; verify it without rewriting
with `cd tools && uv run python eval/report.py --check`. Neither command needs
image files or model weights. The report defines the metrics, exclusions,
bootstrap unit and training-overlap limitation.
