# 0004: Ensemble port fidelity

Status: accepted.

I port the ensemble, geographic filtering and taxonomy logic from SpeciesNet at
commit `aebb5bf852238ee02dac0b82abeb36721ca5bff4`. This is the same revision used
for the golden fixtures and classifier exports, so the implementation and its
reference outputs share one source revision.

I preserve the upstream label constants, thresholds, comparison order and source
strings. The upstream model-independent test cases and the serialized raw golden
capture check the port. For no country, USA and GBR, every processed class and
source must match exactly, with scores within `1e-6`.

The serialized-box capture described in [0003](0003-classifier.md) remains the
reference for crop and ensemble parity. Regeneration includes an ensemble-only
pass over the saved detector and classifier outputs for each country so rounded
boxes do not silently change the reference crop inputs.

I retain the upstream Apache 2.0 notices on the port and test cases, with a copy
of the [license](../../LICENSES/SpeciesNet-Apache-2.0.txt). The test vectors record
source hashes and case names. I captured the model-independent calls while
running the original test assertions, including the image-pairing mock. The
Vitest tests replay those calls and compare their results with the captured
outputs. They also check taxonomy and geofence coverage across all 2,498
classifier labels without loading model weights.

The companion-asset fixture records the original file hashes, compressed labels
and taxonomy, all geographic taxon keys, and the geographic rules reachable from
the raw golden's top-five labels and their ancestors. This keeps tests independent
of local downloads. The upstream coverage check finds no missing taxonomy
ancestors and 12 missing geographic ancestors in these assets. I preserve that
exact diagnostic set; absent geographic rules continue to allow the taxon, as
upstream does.

`tools/golden/run_cli.py` now performs the three serialized-box ensemble passes
after its five inference captures. This incorporates the manual correction
previously documented in 0003 into regeneration itself.
