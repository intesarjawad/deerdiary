import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';

export const PREDICTIONS_DIR = new URL('../e2e/fixtures/', import.meta.url);

/**
 * The card the prediction fixtures describe. The bytes are not JPEGs, so each photo's time comes
 * from its file date, which is what these readings set.
 */
export const CARD_PHOTOS = [
  { name: 'IMG_0001.JPG', lastModified: Date.UTC(2025, 9, 1, 5, 0, 0) },
  { name: 'IMG_0002.JPG', lastModified: Date.UTC(2025, 9, 1, 5, 0, 20) },
  { name: 'IMG_0003.JPG', lastModified: Date.UTC(2025, 9, 1, 22, 10, 0) },
  { name: 'IMG_0004.JPG', lastModified: Date.UTC(2025, 9, 2, 3, 0, 0) },
  { name: 'IMG_0005.JPG', lastModified: Date.UTC(2025, 9, 2, 12, 0, 0) },
  { name: 'IMG_0006.JPG', lastModified: Date.UTC(2025, 9, 2, 14, 0, 0) },
];

export async function readPredictions(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, PREDICTIONS_DIR), 'utf8'));
}

export async function importPredictions(page: Page, name: string, contents: unknown) {
  await page.getByLabel('Predictions file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(typeof contents === 'string' ? contents : JSON.stringify(contents)),
  });
}

export function importStatus(page: Page) {
  return page.getByRole('region', { name: 'Import predictions' }).getByRole('status');
}

export async function dropCard(page: Page) {
  const transfer = await page.evaluateHandle((photos) => {
    const data = new DataTransfer();
    for (const { name, lastModified } of photos) {
      data.items.add(new File(['not a jpeg'], name, { type: 'image/jpeg', lastModified }));
    }
    return data;
  }, CARD_PHOTOS);
  await page
    .getByRole('region', { name: 'Folder intake' })
    .dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}

/** Card names in diary order. */
export async function expectCards(page: Page, names: readonly string[]) {
  const diary = page.getByRole('region', { name: 'Species diary' });
  await expect(diary.getByRole('article').getByRole('heading', { level: 2 })).toHaveText(names);
}
