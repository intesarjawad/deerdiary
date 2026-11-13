const RELOAD_KEY = 'deerdiary-service-worker-reload';

export function needsControlledReload(
  controlledAtLoad: boolean,
  isolated: boolean,
  alreadyReloaded: boolean,
): boolean {
  return !alreadyReloaded && (!controlledAtLoad || !isolated);
}

/** Returns false when this document is being replaced by its first controlled load. */
export async function enableOfflineApp(baseURL: string): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return true;
  const controlledAtLoad = navigator.serviceWorker.controller !== null;
  await navigator.serviceWorker.register(new URL('sw.js', baseURL), { scope: baseURL });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  }
  const key = `${RELOAD_KEY}:${baseURL}`;
  if (
    needsControlledReload(
      controlledAtLoad,
      crossOriginIsolated,
      sessionStorage.getItem(key) === '1',
    )
  ) {
    sessionStorage.setItem(key, '1');
    location.reload();
    return false;
  }
  return true;
}
