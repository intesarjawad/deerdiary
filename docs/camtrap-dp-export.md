# Camtrap DP export

The core exporter writes a [Camtrap DP 1.0.2](https://camtrap-dp.tdwg.org/) package:
`datapackage.json`, `deployments.csv`, `media.csv` and `observations.csv`. Keep the four
files together. Media paths refer to the original photos; the export does not copy photos.
Media rows default to `filePublic=false`: the originals have not been published.
Event observations retain human, vehicle, blank and unknown categories, including
human corrections. Blank and unknown observations have no individual count.

Choose **Download Camtrap DP**, enter each camera folder's WGS84 latitude and longitude, a project title, a contributor name and the sampling design, then choose **Download package**; inline errors block invalid or missing values. Entries are saved with the session (including incomplete drafts) and prefilled when you reopen it; coordinates are never inferred from country or shared between cameras.

Camera timestamps use whole seconds (`YYYY-MM-DDThh:mm:ssZ` or
`YYYY-MM-DDThh:mm:ss±hh:mm`), preserving the camera wall-clock components and each photo's
EXIF offset. Deployment and event endpoints retain the offsets of their endpoint photos.
When EXIF supplies no offset, the existing `Z` convention remains; this is not evidence
that an unconfigured camera was set to UTC. Fractional seconds are truncated, not rounded.

The profile URL is in `profile`, where Frictionless enforces it, as well as `$schema`.
Version 1.0.2 fixes invalid schema references in the original 1.0 profile. A generic
`tabular-data-package` profile validates tables without enforcing Camtrap package metadata.

## Reproduce external validation

With Node dependencies and the repo's tools virtual environment already installed:

```sh
export CAMTRAP_VALIDATION_DIR="$(mktemp -d)"
CAMTRAP_VALIDATION_DIR="$CAMTRAP_VALIDATION_DIR" npm test -- --run tests/unit/camtrapDp.test.ts
tools/.venv/bin/python tools/eval/validate_exports.py --camtrap-only "$CAMTRAP_VALIDATION_DIR"
```

The unit test exports a fresh synthetic fixture with explicit test coordinates, project
metadata and a test contributor. Those coordinates describe the test fixture, not the
Caltech photos or a user's camera. The external script requires the official profile and
all three official table schema URLs before running `python -m frictionless validate`.
It checks package metadata, required coordinates, datetime formats and table relationships.
It requires network access to fetch the official schemas; download failures fail validation.

Without `--camtrap-only`, the script also checks `megadetector.json` when its optional
external validator is installed. The committed legacy export fixture predates this fix;
use a freshly exported package for the Camtrap check above.

The browser regression downloads the package through the form and validates it externally:

```sh
CAMTRAP_PYTHON=tools/.venv/bin/python npm run e2e -- tests/e2e/camtrap-export.spec.ts --project=chromium
```
