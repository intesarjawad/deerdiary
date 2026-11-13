# Models and licences

Code is MIT ([LICENSE](LICENSE)). Models are never bundled or committed. The app downloads them on the first drop from the URLs in `models/manifest.json`, checks size and SHA-256, and keeps them in a Cache Storage entry named `deerdiary-models-v1`.

| Model                                            | Role               | Licence as recorded in the manifest                     |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------- |
| MegaDetector v6 `apa-rtdetr-c`, exported to ONNX | Default detector   | Apache-2.0                                              |
| SpeciesNet v4.0.3a crop classifier, ONNX fp16    | Species classifier | Apache-2.0 ([copy](LICENSES/SpeciesNet-Apache-2.0.txt)) |
| SpeciesNet labels, taxonomy, geofence            | Ensemble data      | Apache-2.0                                              |

The sample photos are Caltech Camera Traps, distributed by LILA BC under CDLA-Permissive-1.0 ([provenance](public/sample/PROVENANCE.txt)).

Licence questions that are still open, recorded in [ADR 0002](docs/adr/0002-detector.md): the detector's model zoo declares Apache-2.0 for this checkpoint while the Zenodo collection API reports CC-BY-4.0. Check that discrepancy before redistributing the detector.
