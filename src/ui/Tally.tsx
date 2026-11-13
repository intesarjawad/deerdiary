import type { CSSProperties } from 'preact';

/** Custom properties set through the style object, which the page's CSP allows. */
export function cssVars(vars: Record<string, number | string>): CSSProperties {
  return vars as unknown as CSSProperties;
}
