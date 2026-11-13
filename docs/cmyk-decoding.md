# CMYK photo decoding

The photo worker's native path requested `colorSpaceConversion: 'none'`, drew the
full-resolution bitmap onto an sRGB `OffscreenCanvas`, and read RGBA pixels.
WebKit still returned a different CMYK-to-RGB conversion. Changing the option to
`'default'` produced the same pixels. The upstream
`african_elephants_cmyk.jpg` has four components, Adobe transform 0, and no ICC
profile, so removing an embedded profile cannot fix this case.

Measured on the 2048 × 1536 upstream photo against Pillow's `convert('RGB')`,
without resizing or EXIF transformation:

| Decode path     | Mean absolute RGB channel error | Maximum error |
| --------------- | ------------------------------: | ------------: |
| Chromium native |                               0 |             0 |
| Firefox native  |                               0 |             0 |
| WebKit native   |                         11.0514 |            84 |
| jpeg-js 0.4.4   |                          0.0547 |             1 |

For example, PIL, Chromium and Firefox return `[137, 163, 197]` at `(0, 0)`;
WebKit returns `[136, 143, 157]` with either conversion setting. This difference
flips the fourth CMYK crop from African elephant to common wildebeest in the
unmodified golden test.

`workers/jpeg.ts` now recognizes four-component baseline/extended/progressive
JPEG frames and decodes those with pinned `jpeg-js`. Its explicit CMYK conversion
ignores ICC profiles, matching the reference's policy. The decoded RGB pixels
are oriented using the existing `exifr` dependency before model preprocessing.
The canvas matrix uses exact integer right angles to avoid interpolation of
boundary pixels during Firefox rotations.
Other images retain native decoding. The existing missing-end-marker retry also
uses this path.

The 24 × 16 synthetic `tests/fixtures/cmyk.jpg` was generated with Pillow at
quality 100, subsampling 0. Its six 8 × 8 tiles contain CMYK values
`(118,92,58,0)`, `(13,49,38,0)`, `(2,51,58,0)`, `(80,120,160,64)`,
`(20,30,40,128)`, and `(0,0,0,255)`. The browser pixel regression checks their
PIL RGB equivalents within one channel level for all eight EXIF orientations.
The existing golden test remains unchanged and verifies actual worker inference.

Verification:

```sh
npm run check
npx playwright test tests/e2e/golden.spec.ts --project=chromium --project=firefox --project=webkit
npx playwright test
```
