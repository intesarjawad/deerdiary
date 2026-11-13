import { formatNetworkMeter, type NetworkSnapshot } from '../app/networkMeter';

const count = new Intl.NumberFormat('en-US');

// The page opens with no requests recorded; this keeps the footer truthful before the first drop.
const EMPTY_NETWORK: NetworkSnapshot = {
  modelRequests: 0,
  modelBytes: 0,
  unknownModelSizes: 0,
  otherRequests: 0,
  hosts: {},
};

export type FooterProps = {
  photoCount: number;
  speciesCount: number;
  blankPhotos?: number | undefined;
  humanPhotos?: number | undefined;
  vehiclePhotos?: number | undefined;
  network?: NetworkSnapshot | undefined;
  sourceHref?: string | undefined;
};

function photosLabel(value: number): string {
  return `${count.format(value)} ${value === 1 ? 'photo' : 'photos'}`;
}

function networkLine(snapshot: NetworkSnapshot): string {
  if (snapshot.modelRequests === 0 && snapshot.otherRequests === 0) {
    return '0 requests since you dropped the folder';
  }
  return `Requests since you dropped the folder: ${formatNetworkMeter(snapshot)}`;
}

/** Totals and the measured request count; blanks, people and vehicles never need a card. */
export function Footer({
  photoCount,
  speciesCount,
  blankPhotos = 0,
  humanPhotos = 0,
  vehiclePhotos = 0,
  network = EMPTY_NETWORK,
  sourceHref,
}: FooterProps) {
  return (
    <footer class="diary-footer">
      <p>
        <span>{photosLabel(photoCount)}</span>
        <span> · {count.format(speciesCount)} species</span>
        {blankPhotos > 0 && (
          <span>
            {' '}
            · {count.format(blankPhotos)} blank {blankPhotos === 1 ? 'photo' : 'photos'}
          </span>
        )}
        {humanPhotos > 0 && (
          <span>
            {' '}
            · {count.format(humanPhotos)} {humanPhotos === 1 ? 'person' : 'people'}
          </span>
        )}
        {vehiclePhotos > 0 && (
          <span>
            {' '}
            · {count.format(vehiclePhotos)} {vehiclePhotos === 1 ? 'vehicle' : 'vehicles'}
          </span>
        )}
      </p>
      <p>{networkLine(network)}</p>
      {sourceHref && (
        <p>
          <a href={sourceHref}>Source on GitHub</a>
        </p>
      )}
    </footer>
  );
}
