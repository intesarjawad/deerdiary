import { expect, test } from 'vitest';
import { MastheadTitle } from '../../src/ui/MastheadTitle';

const HREF = 'https://github.com/intesarjawad/deerdiary';

function children(node: ReturnType<typeof MastheadTitle>) {
  return node.props.children as Array<{ type: string; props: Record<string, unknown> }>;
}

test('the landing name row carries the wordmark and the GitHub link', () => {
  const [name, link] = children(MastheadTitle({ heading: false, repoHref: HREF }));
  expect(name?.type).toBe('p');
  expect(link?.type).toBe('a');
  expect(link?.props.href).toBe(HREF);
  const content = link?.props.children as Array<
    string | { type: string; props: Record<string, unknown> }
  >;
  const [mark, label] = content;
  expect((mark as { type: string }).type).toBe('svg');
  expect((mark as { props: Record<string, unknown> }).props['aria-hidden']).toBe('true');
  expect(label).toBe('Star on GitHub');
});

test('with a diary open the name is the page heading and the link stays', () => {
  const [name, link] = children(MastheadTitle({ heading: true, repoHref: HREF }));
  expect(name?.type).toBe('h1');
  expect(link?.props.href).toBe(HREF);
});
