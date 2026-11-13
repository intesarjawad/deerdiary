# Local pipeline import

You can run the reference SpeciesNet pipeline on your own machine and bring its predictions into
deerdiary. Nothing is uploaded: the file is read in the browser.

## Steps

1. Install the reference pipeline: `pip install speciesnet`
2. Run it on the folder of photos:

   ```sh
   python -m speciesnet.scripts.run_model --folders <dir> --predictions_json out.json \
     --country USA --max_classifications_per_detection 5
   ```

3. Choose `out.json` under "Import predictions", then drop the photo folder (or drop the folder
   first). The file holds no capture times, so the diary reads them from the photos. Each
   prediction is matched to its photo by the trailing parts of its path, so the folder above the
   camera card can differ. Photos in the file but not in the folder are left out and counted.

## Formats

The importer in `src/app/import.ts` reads two formats and chooses by their keys:

- SpeciesNet: `info.format_version` and a `predictions` list. Detections carry a
  `processed_classification`.
- MegaDetector: `info.format_version` and an `images` list whose detections carry `classifications`
  named by `classification_categories`.

Each field is checked as it is read. A file that fails is rejected with the path of the first bad
field, for example `predictions[0].detections[0].bbox`.

## Country changes

Changing the country re-runs the geographic step only for detections that kept their five top
classes, which `--max_classifications_per_detection 5` guarantees. A detection with fewer raw
classes, which is every detection in a file made without that flag, keeps the label in the file.
So does every detection in a MegaDetector-format file. While such a file is shown, the country
selector reads "Country fixed by the imported file".
