# Design direction: the joiner and the field sheet

A trail camera never moves. Every frame on a card is the same picture with something different walking through it, which is what David Hockney's photo joiners are made of: many exposures of one place, laid back together so the picture holds time. Deerdiary opens on that picture. One empty frame from the sample card comes up out of black as a faint infrared still. The year opens on the first burst that kept an animal. Each burst's flash is aimed at its animal and shows it sharp where it stood, in infrared, and the animal stays behind in the dark. When the year has played, fragments of ground cut from the year's photos are laid over the frame with the animals' prints, and daylight sweeps out from the lens across the finished joiner, graded to the master frame's own light, so it reads as one picture of one place. Beside it a printed field data sheet is filled in by hand, one row per burst, and it keeps an honest blank where a label stopped above species.

The chrome is night: a warm near-black ground, bone ink, and one ember colour for counting, the colour of a camera's infrared LEDs when they fire. The photographs are the only daylight on the page.

## Signature moment: the flash that reveals

The frame starts in true black for a beat, then shows the place faintly. Each burst fires the camera's infrared flash again, and that flash relights the scene from a depth map with real shading and shadow; it does not fade a photo up. At the flash's peak about half the frame stays near black: only the ground in the beam is lit, and the animal stands in it.

- **Depth.** `tools/sample/depth_master.py` runs Depth Anything V2 Small once, offline, on the master frame, caps every row at the 85th percentile of its own depths (so the branch at the right edge lies level with its ground instead of standing up as a cliff with a bright rim), blurs the result in float and stores it in 16 bits across the red and green channels of `public/sample/master-depth.png` (512 x 373, 180 KB). The model never runs in the browser.
- **Light.** `src/ui/relight.ts` is plain WebGL2 in one fragment shader. Normals come from the depth gradient, with the slope clamped so no cut-out edge turns into a rim, plus a little of the photo's own luminance detail; shadows are a 28-step soft ray march toward the light. The flash comes from just above the lens. Its light falls with the square of distance (the map is inverse depth, so the square of its value), inside a narrow beam (0.13 frame heights) aimed at the centre of the visit's print, or at the near path for a burst with no print, so the centre overexposes and the far bank and corners stay black. The frame is monochrome the way an IR flash is. A pointer or finger across the frame carries a lamp that shows true colour in a cone.
- **Darkness is the default.** The first 200 ms are true black; then, over 500 ms, ambient light rises to 1 percent, a faint infrared still at about 8 percent of full brightness on screen. Between flashes the frame decays back to that still in about a second (fall time constant 350 ms). Between flashes an animal already laid takes the same light as the ground, so only its own shape shows: no glow, no rim, no edge. At night a print is only its animal: `animalMatte` in `src/ui/joinerVisits.ts` cuts it from the median of its own burst (the other frames show the same ground in the same light seconds later, and each is first fitted to the print's level on the ring), with each colour channel fitted to the print's on the outer quarter of the box, which is padding and so ground. A pixel counts as animal from 1 to 2.5 times the ring's own spread of difference; the result is blurred to close holes, ramped back to a crisp edge, and faded out over the last fifth of the box. When the animal held still through its burst the median keeps it, so below 10 percent coverage the matte falls back to what differs from any single frame. Any separate piece of the matte smaller than 8 percent of the box is dropped (`withoutScraps`), so no scrap of changed ground floats beside the animal. What is left is then worn back by 3 px before its edge is feathered, so a strip of changed ground no wider than a limb does not stay attached. Each print is level-matched to the master frame on its ring of padding (`ringGains`), so ground the soft edge keeps does not show as a paler or darker patch. Where a newer print overlaps an older one, the older is cleared to ground around the newer's matte, feathered 20 px, so two animals never fuse into one shape.
- **The joiner.** Every piece is cut from a photo at the same place it is laid, so it registers with the scene at the camera's own scale. By day pieces are turned up to two degrees, as prints laid by hand. Only an animal's print has an edge, 1 px of warm paper (`rgb(226 208 176)`), and no piece casts a shadow; ground fragments have no edge. Two kinds:
  - _Ground._ Six rows of overlapping fragments, 57 in all (9 and 10 to a row, alternately), cover the frame between the camera's data strips. Rows are near one height above and below the scene's horizon, the row where the depth map is farthest (`farthestRow`, searched between 10 and 60 percent of the frame height), and one row ends on it, so that seam is the far bank's own edge and no band of the frame is left bare; every other row starts half a fragment over, as bricks are laid, so no seam runs down the frame. Each fragment is between 1.05 and 1.55 cells wide and reaches past its row by its own amount, so the pieces are not one size. Each fragment is cut from the photo that shows that spot best (most textured, at most six fragments per photo), skipping any spot too dark (mean luminance under 0.08), burnt out by the sun (over 0.7) or more than a tenth clipped (over 0.85, an animal too near the flash). A fragment's score is multiplied by how much of its own colour the photo keeps after grading, so a photo that has to be toned gives no ground and the master frame shows through there instead. Ground is laid only when the year ends.
  - _Animals._ A visit's print is its detector box, padded. At night it is registered with the scene, so its flash lands where the animal stood; by day it is laid by hand (`laidRect` in `src/ui/joinerVisits.ts`): from 0.6 to 1.6 times its size, its centre pushed 1.35 times further from the frame's centre so prints reach the edges, never over 0.4 of the frame wide or 0.45 tall, and inside the frame. A dark print is brightened toward a mean luminance of 0.36, at most twice, so it never reads as a hole. It gets no print when the box touches the frame's edge (the animal is cut in two: No. 06, 14 and 17) or when the crop is too dark or flat to show anything (mean luminance under 0.16 or spread under 0.055). Those visits keep their row on the sheet.
- **The flash shows the animal.** The beam is aimed at the newest print, and the animal stands opaque at its real spot in the hottest part of the flash. It takes a little more of the beam than the ground, only where its matte is solid (so the soft edge, which holds ground, takes no halo), then its exposure is capped at 1.0, below the point where the ground burns out, so fur and silhouette stay sharp.
- **Colour.** While the year plays every print is infrared mono, like the scene. When it finishes, daylight arrives nearest the lens first and sweeps out to the far bank, led by the depth map (a band 0.35 of the depth range wide, over about two and a half seconds), and stays there. Every photo is first graded to the master frame's light (`gradeFor` and `applyGrade` in `src/ui/joinerVisits.ts`): a gamma moves its mean brightness half way to the master's (bounded 0.45 to 1.6), so the seams keep the exposure steps of a joiner's prints, and per-channel gains move its white balance toward the master's by at most a tenth, so each fragment keeps its own day. A photo whose cast is within 0.14 of the master's keeps its own colour; past 0.2 (the monochrome infrared frames, and the frames whose colour failed into salmon) it keeps only its tones, warmed toward the master's daylight white (the 97th percentile of each channel) by at most a tenth, as a print is toned in the darkroom. Colour also shows under the lamp at any time.
- **The year.** A slider under the frame has one tick per burst at its date, dashed where the camera kept no animal. Arrow keys, Home and End, or dragging scrubs it, and each step fires the flash (at most once per 140 ms). "Replay the year" replays it. The track runs in the frame's bottom data strip, which is black in every mode (the camera's maker mark is hidden), so no band sits under the picture.
- **Timing.** First flash 1200 ms after the renderer is ready, then one burst every 1250 ms. Flash rise 50 ms, fall time constant 350 ms. The frame loop runs only while light is still settling.

The canvas holds no text. Every animal print is also a real button laid over it, with its number, date, name and how far it was named in the accessible label; its number shows on the frame only on hover or keyboard focus. The burnt-in camera strip and the claim above the frame are HTML.

## The field sheet

A printed form, not a ledger: a station block (Station, Frames, Bursts, Days) and one row per visit. All 17 rows are ruled before the year starts, blank and waiting; a row is inked when its burst flashes: date, common name with a capital ("Virginia opossum"), then the Latin name in italic, which never breaks across lines. A burst that counted a second species names both ("Coyote _Canis latrans_ and Northern raccoon _Procyon lotor_"). The sheet and the diary count through one function, `labelCounts` in `src/ui/SpeciesCard.tsx`, so "Stopped above species" on the sheet and "not named to species" in the diary are the same number. A label that stops above species gets an empty rule where the binomial would go and says how far it reached ("to family", "to class"); an animal with no label reads "Unidentified animal" here and everywhere else. Bursts with no animal take a number on the year line but not a row. Three counts close the sheet: named to species, stopped above species, bursts with no animal. A count appears when it reaches one. The counts are plain numbers; there are no tally marks.

Rows and prints are linked: activating either brings that visit to the front, fires its flash, moves the year line's head to its date and highlights its row.

## Numbers and where they come from

Every number on the landing page is computed in the browser from `public/sample/predictions.json`, which `npm run sample:predict` (`tools/sample/predict_sample.ts`) writes from the sample photos.

| Number                                     | Value   | Computed by                                                       |
| ------------------------------------------ | ------- | ----------------------------------------------------------------- |
| Frames                                     | 60      | `loadSample` in `src/ui/Joiner.tsx`                               |
| Bursts                                     | 20      | `joinerVisits` in `src/ui/joinerVisits.ts`                        |
| Days, "331 days at one trail camera"       | 331     | `loadSample` in `src/ui/Joiner.tsx`                               |
| Named to species, stopped above, no animal | 8, 5, 3 | `sheetTallies` in `src/ui/joinerVisits.ts`, through `labelCounts` |
| Species in the diary's headline            | 8       | `diarySpecies` in `src/ui/Diary.tsx`                              |
| Visit numbers, dates, ranks                | 1 to 17 | `joinerVisits`, `determinedTo`                                    |

`tests/unit/joiner-visits.test.ts` pins these values against the sample. The tallies count every species a burst counted, its second species included, through the same `labelCounts` the diary uses; one test checks the finished sheet against the diary's counts (8, 5, 3) and another that it names every species the diary does.

## The diary

The results view keeps its own signature: when a diary appears, every frame lands as a contact sheet, "60 frames." set large above it, then the roll folds (FLIP) into a bar chart of photographs with the kept portrait on top, and the three tallest piles lift into a row of faces. The headline counts only labels that name genus and species; higher ranks form a quieter "not named to species" row. The fold waits until every kept photo has loaded, the headline's species count rises as each pile lands, and the face row keeps its height from the start, so no empty strip shows. Only the pile that landed last has the ember edge, and a count is written over a pile only when it is more than one. A species seen once in one burst gets a short entry, "Seen once" and its time, without hour bars. Each species entry carries its name, counts, dates, hour bars and bursts with no repeated caption or heading; the dates under the bursts are set in the serif. The reel on the page frames each shot at three times the animal's box, 4:3 and at most 36 rem wide, and pushes in on the animal. Under reduced motion the roll renders already folded. Timing: auto-fold 1 s after arrival, 900 ms per tile with a 95 ms pile stagger and 28 ms depth stagger, zoom 700 ms. It takes the night palette from the tokens below; its structure is unchanged.

## Tokens

All values live in `src/ui/styles/tokens.css`. `color-scheme: dark`.

| Token                        | Value                 | Use                                             |
| ---------------------------- | --------------------- | ----------------------------------------------- |
| `--ground`                   | `#0e0d0b`             | page                                            |
| `--raised` / `--sunken`      | `#181612` / `#221f1a` | panels, the drop gate / disabled, tracks        |
| `--rule` / `--rule-strong`   | `#3b362e` / `#5a5347` | form rules, the year line                       |
| `--ink`                      | `#ece5d3`             | text, the front print's outline                 |
| `--ink-soft` / `--ink-faint` | `#a59c89` / `#8f8775` | Latin names, captions / form labels             |
| `--tally`                    | `#ff7a5c`             | the diary's counts, focus ring, the sample link |
| `--tally-wash`               | `#33150f`             | the row on the front, drag-over                 |
| `--on-tally`                 | `#1a0b06`             | text on the primary action                      |
| `--signal`                   | `#ff5a2c`             | detection boxes, only ever on a photo           |
| `--film` / `--film-ink`      | `#070706` / `#c9c2b0` | photo mats, data strips, footer                 |
| `--danger` / `--danger-wash` | `#ffb3a1` / `#2e120d` | errors                                          |

Contrast, from `tests/unit/contrast.test.ts`, which fails below 4.5:1: ink on ground 15.5, ink-soft 7.1, ink-faint 5.4, tally 7.6; on raised, ink-soft 6.6, ink-faint 5.1, tally 7.0; on-tally on tally 7.5; film-ink on film 11.3; danger on its wash 10.1.

## Type

Two self-hosted SIL OFL 1.1 families, same origin so the Content Security Policy allows them. Files and licences are in `public/fonts/`.

- **Newsreader** (Production Type; variable weight 200 to 800 and optical size, roman and italic): the wordmark, the claim above the frame (the page's heading), species names, Latin names in italic and all body copy. Its optical sizes let the 72 pt title and the 15 px sheet rows be the same face.
- **Martian Mono** (Evil Martians; variable weight and width): the camera's burnt-in strip at its widest, form captions, dates, row numbers and the year's months.

Both are subset to Latin and served as WOFF2 with `font-display: swap`.

Boska was considered for the display face and rejected: its ITF Free Font License 2.0 forbids subsetting and forbids distributing the files "through ... repository ... publicly accessible servers", which a public repository that serves its own fonts does.

## Shape and motion

Spacing steps 4, 8, 12, 16, 24, 40, 64 px. Corners 2 px. On the landing the drop gate is secondary: a rule above it, one outlined bone button ("Choose a folder") and a text link ("Try the sample"); the note under it is hidden on the first screen. Links are set in ink with a faint underline, and only "Try the sample" keeps the coral one. The wordmark is set at 20 px and the lede at 15 px, so the claim, one 36 px line above the frame, leads. After a diary appears the gate returns to its compact panel. Controls are at least 44 px tall except the sheet rows, which are 24 px tall and full width. Only the shader, `transform` and `opacity` (a row being written fades in) animate.

## Fallbacks and limits

- **Lazy.** The renderer is a separate 3.6 KB (gzip) chunk, imported after the sample and the first paint. The stage is black until it is ready. Grading runs on a 2D canvas, one photo per task, so it never holds a click or a frame.
- **No WebGL2.** The still shows dim and grey, and every piece, ground and animal, is drawn by CSS from its graded print (made once as a JPEG data URL) at its place and turn: grey while the year plays, colour when it ends. As in the drawn joiner only an animal's print has an edge, and none has a shadow, and by day the master frame shows at full colour in the gaps between fragments.
- **Reduced motion.** No autoplay and no flash: the finished joiner shows at once in daylight colour, and nothing moves. The lamp still follows a pointer, since the reader moves it.
- **Cost.** Device pixel ratio is capped at 2, and at 1 on screens up to 700 px wide or with a coarse pointer. The frame loop stops when nothing is settling, when the frame is off screen, and when the tab is hidden; the year also waits until the frame is back in view.

## What must not change

- The frame starts in true black, settles to a faint still, and is revealed only by light. A brightness fade is not this effect.
- At night a print is lit only where its flash fell. No card edge, border, shadow or glow shows until the year ends.
- One scale: every piece is cut and laid at the camera's own registration. Never enlarge a crop.
- The canvas never holds the only copy of a name, date or count.
- A label that stops above species is shown as stopping, with its blank. Never round it up to a species.
- Every number is computed from the sample's predictions, never typed into copy.

## Surfaces

- First screen, desktop: the claim "331 days at one trail camera, in one picture." as the page's heading on one line, the joiner under it on the left; the wordmark, lede, quiet gate and field sheet in a 26 rem column on the right, with the country under the sheet, all in one 1440 x 900 viewport. Under the year line, beside "Replay the year", one line says the frame takes a lamp, so the lamp is found in the first viewport; it shows only when WebGL runs. The heading's lines are balanced. Phone: the claim first, then the joiner running to the screen's edges, cropped square from the frame's centre, so the flash frame is larger, with every third month on the year line and "Replay the year" under it, then the field sheet directly under the year line, then the paragraph, the wordmark, the gate and the country. On every width the year line spans the frame, with "Replay the year" below the months.
- "Try the sample" is always on screen with the same label, playing or not, on every width. It opens the diary at once. On a first visit the page reloads once under its service worker, to turn on cross-origin isolation; a press before that reload is kept in session storage and opens the sample after it (`tests/e2e/sample.spec.ts` holds the worker back to check this).
- With a diary on screen the gate collapses to one row and the joiner is gone.
- In the diary, "Correct species" is grouped by species: a heading per species (name, binomial, number of bursts), laid out three to a row, then its bursts with a date and a thumbnail framed at twice the animal's box (never under a fifth of the frame), brightened for display to a mean of 0.42 (at most 3 times) so a night crop never shows as a black square. "Correct" and "Why this label" show on hover or keyboard focus, and a species with an open burst spans the whole row. A chosen option in the species list is inked, not coral. The species field appears only after "Correct", with its list as wide as the field (at most 28 rem), and one "Why this label" explanation opens at a time, under its burst: the crop at twice the box and 18 rem wide, from the full photo when the page has it, the classifier's top five down to 1 percent with a count of the rest ("4 more under 1%."), and one sentence on why the label stands. Binomials keep their capital genus (_Felis catus_).
- States kept from before: drag-over, scanning, empty folder, model unavailable, wrong files, loading and download bar, sample failed, long names, one species, huge folders, camera clock not set, first sighting.

## Known gaps

- The joiner is built for the sample card only; a user's own card does not get a depth map or a joiner.
- The relight has been checked only in headless Brave at desktop and phone sizes, not on real phones or other GPUs.
