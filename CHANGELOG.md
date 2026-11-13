# Changelog

Changes follow Keep a Changelog and Semantic Versioning.

## [0.1.0] - 2026-11-12

### Added

- Drop a trail-camera folder or SD card on the page and get a species diary, an activity clock and a highlight reel, all computed in a browser worker.
- MegaDetector and SpeciesNet run in the browser through ONNX Runtime; photos never leave the machine, and a footer meter lists every request by host.
- Corrections on any card, carried into the exports: CSV, SpeciesNet JSON, MegaDetector JSON and Camtrap DP, plus session export and restore.
- A finished sample diary from 60 Caltech Camera Traps photos that runs without downloading a model.
- The packaged app serves the built page locally with the same security headers as the hosted page.
- Species accuracy on 2,000 ENA24 photos compared with official SpeciesNet, regenerated from committed predictions by `npm run eval:report`. Reference mode is not evaluated: its 16-image parity check has not passed yet.
