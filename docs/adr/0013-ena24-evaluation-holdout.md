# 0013: ENA24 evaluation holdout when the selection list is absent

Status: accepted for the agreement evaluation, 2026-11-11.

The original detector-selection image list is absent from the repository.
`git log --all -S selection_1000` and `git log --all -S per-class-cap` locate only commit
`10eb5daab3f0ecad47d7d2d653802a298b75347c`, which adds the preparation tools,
not a dataset or a completed selection run. ADR 0002 explicitly leaves the
1,000-image matched-false-detection experiment pending. Its production default
was selected using 16-image export parity and local latency measurements.
There is no record of a per-class cap or an original selection to reconstruct.

Reserve a substitute set of 1,000 publicly available, annotated ENA24 images
before running the agreement evaluation. Use the existing
`prepare_selection.sample` algorithm:
lexically sorted relative paths; stratum is the smallest category ID in each
image; seeded Python shuffle within each stratum; round-robin selection by
lexically sorted stratum keys; seed 20261104; per-class cap 1000. Human images
removed by the dataset host are unavailable and cannot enter either set.
ENA24 has no explicit empty category; unannotated images are not invented blanks.

The reserved paths are in `tools/eval/lists/selection_1000.txt`; these images
need not be downloaded. Sample the evaluation images from the remaining public
annotated images using the same seed and stratification, n=2000, per-class cap 2000. Commit SHA-256
checksums for the downloaded evaluation images and the metadata digest.

The sets are disjoint and reproducible. The substitute detector was not compared
against the original on a separate holdout. ENA24 may overlap SpeciesNet
training data;
measured accuracy is not an independent generalization benchmark. No location
field exists in the supplied COCO metadata; bootstrap by image, with the risk
that adjacent frames are correlated.
