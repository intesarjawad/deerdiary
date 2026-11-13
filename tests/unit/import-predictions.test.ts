import type { ComponentChildren, VNode } from 'preact';
import { expect, test, vi } from 'vitest';
import { ImportPredictions } from '../../src/ui/ImportPredictions';

function text(node: ComponentChildren): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => text(child)).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return text((node.props as { children?: ComponentChildren }).children);
  }
  return '';
}

function find(
  node: ComponentChildren,
  match: (element: VNode<Record<string, unknown>>) => boolean,
): VNode<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as VNode<Record<string, unknown>>;
  if (match(element)) return element;
  return find(element.props.children as ComponentChildren, match);
}

const view = (state: Parameters<typeof ImportPredictions>[0]['state']) =>
  ImportPredictions({ state, onFile: () => {}, helpHref: 'docs/local-pipeline.md' });

test('offers a JSON file picker and links to how a predictions file is made', () => {
  const idle = view({ status: 'idle' });

  const input = find(idle, (element) => element.type === 'input');
  expect(input?.props.type).toBe('file');
  expect(input?.props.accept).toBe('.json,application/json');
  expect(input?.props.disabled).toBe(false);
  expect(find(idle, (element) => element.type === 'a')?.props.href).toBe('docs/local-pipeline.md');
  expect(find(idle, (element) => element.props.role === 'status')).toBeUndefined();
});

test('hands the chosen file to the caller and clears the picker for the same file again', () => {
  const onFile = vi.fn();
  const input = find(
    ImportPredictions({ state: { status: 'idle' }, onFile, helpHref: '#' }),
    (element) => element.type === 'input',
  );
  const file = new File(['{}'], 'out.json');
  const target = { files: [file], value: 'out.json' };
  if (!input) throw new Error('The import control has no file input.');

  (input.props.onChange as (event: { currentTarget: typeof target }) => void)({
    currentTarget: target,
  });

  expect(onFile).toHaveBeenCalledWith(file);
  expect(target.value).toBe('');
});

test('names each state in words', () => {
  const reading = view({ status: 'reading' });
  expect(text(reading)).toContain('Reading the predictions file.');
  expect(find(reading, (element) => element.type === 'input')?.props.disabled).toBe(true);

  expect(text(view({ status: 'waiting', photoCount: 1 }))).toContain(
    'Predictions for 1 photo read. Drop the folder they were made from to see the diary.',
  );
  expect(
    text(view({ status: 'shown', photoCount: 1200, unmatchedCount: 0, countryFixed: true })),
  ).toBe(
    'Import predictionsBring in the predictions file from SpeciesNet or MegaDetector run on your computer. How to make onePredictions fileShowing 1,200 photos from the predictions file.',
  );
  expect(
    text(view({ status: 'shown', photoCount: 2, unmatchedCount: 1, countryFixed: true })),
  ).toContain(
    'Showing 2 photos from the predictions file. 1 listed photo is not in the dropped folder and is left out.',
  );
});

test('a failure is an alert that says what to do next', () => {
  const failed = view({ status: 'failed', message: 'This file is not valid JSON.' });
  const alert = find(failed, (element) => element.props.role === 'alert');

  expect(text(alert)).toBe('This file is not valid JSON. What to do next');
  expect(find(alert, (element) => element.type === 'a')?.props.href).toBe('docs/local-pipeline.md');
});
