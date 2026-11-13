# Known errors on the sample card

The sample is 60 frames from a public camera-trap set, run through the same pipeline as your own photos and saved with the app. Nothing on it is corrected by hand, so its mistakes are the model's mistakes. `npm run sample:score` compares every card with the dataset's own labels.

## A raccoon counted as a coyote

Frame `5a0c9b97-23d2-11e8-a6a3-ec086b02610b.jpg` is an overexposed close-up cut off at the frame edge. The classifier gives coyote 0.708 and northern raccoon 0.054, and coyote clears the 0.65 threshold. The sample has no country, so no geographic rule is involved, and the rest of the burst is correctly called raccoon. The diary keeps the model's call; folding it into its siblings would hide exactly the kind of error a reviewer needs to see.

## Rodents left at "Mammal"

On `59adfc81…` the strongest box scores mammal 0.346 and rodent 0.248, with three rat species under 0.06 each. Rodent-order evidence sums to about 0.38, short of 0.65, while class evidence sums to 0.73, so the rollup stops at Mammal. A blank species line on the sheet means exactly that: the animal was found, its species was not.

One of the three rodent frames (`5a1640eb…`) adds Mammal through a false detection on a stick that never moves. The rodent itself scores under the detector's 0.2 threshold.

## MaxN of two on one animal

The detector emits overlapping boxes for a body, a body with tail and a wider crop. The burst counter merges any box that covers 90% or more of a smaller one after the taxonomy fold; low overlap alone would miss these parts. `tests/unit/sample-audit.test.ts` fails if that merge stops working on the rodent and skunk frames.

Two MaxN of two remain, and both are real counts of two boxes that do not overlap. Coyote frame `59b7a872…` holds a coyote and a white bag the detector scored 0.576; empty frame `597b4888…` holds two false detections, one of them the stick. All nine boxes that fall back to "animal" have blank as the classifier's top label (0.84 to 0.985): the upstream fallback thresholds meet a detector with a different score scale (ADR 0005). Fixing that needs held-out labelled data, not these 60 photos.
