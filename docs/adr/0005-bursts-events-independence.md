# 0005: Bursts, events and what the diary counts

Status: accepted.

## Context

A diary card claims that an animal visited. The ensemble labels every classified box,
including boxes it could not identify, and the default detector (ADR 0002) returns its
300 top-scoring queries for every photo. Its scores sit on a different scale from
MDv5a's: on empty frames of the Caltech Camera Traps sample, background queries score
above 0.2, where upstream's ensemble thresholds treat a box as a plausible animal.
The ensemble keeps upstream's thresholds unchanged (ADR 0004), so the diary decides
which of its outputs count.

## Decision

Bursts split at a 60 s gap per camera, and a species counts as a new independent
detection more than 30 minutes after its previous counted one, per camera.

A detection is a sighting, and so adds to a card, a photo count, MaxN, an event and an
independent detection, only when:

- its detector confidence is at least `MAXN_MIN_CONF` (0.2), upstream's
  mid-confidence animal threshold. Boxes from 0.1 to 0.2 are still classified, as
  upstream's `--detection_threshold_for_classification` default requires, and their
  labels stay in "Why this label" and the exports, but they are too often spurious to
  count;
- its processed class is not blank, human, vehicle or the ensemble's unknown
  (`no cv result`).

The unknown class is what the ensemble returns when no rule names the box. Apart from the rare
case where geographic rules block every broader group of a confident label, it means
no confident classification, no rollup above 0.65, and no animal box above 0.5, the
level at which upstream itself labels a box "animal". Counting it under "Animal
(unidentified)" would claim an animal where the reference declined to. "Animal
(unidentified)" therefore holds the detector's animal fallback only.

Results keep only the boxes the classifier labelled. Nothing draws, counts or relabels
any other box, and keeping all 300 per photo multiplied the size of stored results and
session exports.

Within one burst, a label that is a taxonomic ancestor of the burst's other sightings
is the same animal seen less clearly, and the diary counts it with them: its card, photo
count, MaxN in its frame and independent detection go to the more specific label.
Ancestry comes from the label's own taxonomy (class, order, family, genus, species), and
the detector's animal fallback is an ancestor of every taxon. When the narrower labels lie
on one line of descent (mammal and coyote below the animal fallback), the broad label
folds into the most specific; when they could be two different animals (coyote and red
fox), it keeps its own card. Siblings never fold, and nothing folds across bursts.

The event's species list is the unit other camera-trap tools count, so a family label in
one frame of a snowshoe hare's burst is not a second visitor. This is a counting rule
only: stored results keep each box's own label, and "Why this label" shows that label and
says which species the diary counted it with. In MaxN, a folded box beside a box of its
species in the same frame is a second animal.

Within one frame, a box that lies at least 90 % inside a more confident box counted as the
same label is the same animal, and nothing counts, draws or opens a detection with it. The
default detector is NMS-free and also boxes parts of an animal: on the instant sample it
boxed a rodent's body, its body and tail, and a wider frame around both, and a skunk's lower
half, which the classifier called only a mammal and the burst folded into the skunk. Each part
lies 98 % or more inside the whole, yet six of the seven pairs have an IoU under 0.45,
so even NMS would keep them, and MaxN read three rodents and two skunks. The rule
compares counted labels after the fold, so a smaller animal of another species standing in
front of a larger one still counts. Two animals of one species where one stands almost
wholly inside the other's box count as one; that undercount is the cost of not counting
every part box as an animal.

The product shows one set of numbers. The fold is applied once, where bursts become
events, so the diary, event grid, reel, History, corrections and every event-level export
(the event species in the SpeciesNet file, Camtrap DP observations and the CSV's
`independent` column) count the same sightings. Per-box records keep the box's own label:
the CSV's detection rows, SpeciesNet and MegaDetector predictions, so a folded box's row
shows its broad label and `independent` is true only on the rows of the label it counted as.

A photo is blank in the footer only when nothing in it was counted: no sighting, person
or vehicle.

## Consequences

`npm run sample:score` (`tools/sample/score_sample.ts`) compares the instant sample's
diary with the dataset's labels per photo: empty frames that still reach a card, the
label confusion table and independent detections per card. It is the measure for any
later change to these rules.
