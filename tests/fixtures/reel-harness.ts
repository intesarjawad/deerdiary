import { h, render } from 'preact';
import { createReelExporter } from '../../src/app/reelExport';
import type { DeerdiaryEvent } from '../../src/core/types';
import { Reel } from '../../src/ui/Reel';

const PHOTO_WIDTH = 1600;
const PHOTO_HEIGHT = 1200;

/** A flat-colour JPEG, so a grabbed frame shows at a glance whether it is a shot or the card. */
export async function flatPhoto(colour: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_WIDTH;
  canvas.height = PHOTO_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The test page cannot draw.');
  context.fillStyle = colour;
  context.fillRect(0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The test page cannot encode JPEG.'))),
      'image/jpeg',
    ),
  );
}

/** Renders the reel with the real exporter; the export downloads like the app's other files. */
export function mountReel(
  root: HTMLElement,
  events: readonly DeerdiaryEvent[],
  photos: ReadonlyMap<string, Blob>,
): void {
  const exporter = createReelExporter({
    loadPhoto: async (path) => {
      const photo = photos.get(path);
      if (!photo) throw new Error(`${path} was not prepared for this test.`);
      return photo;
    },
    save: ({ name, blob }) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
    },
  });
  render(h(Reel, { events, exporter }), root);
}
