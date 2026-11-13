// The slim entry points ship no types of their own; they export the same functions as the packages.
declare module 'exifr/dist/lite.esm.mjs' {
  export { parse } from 'exifr';
}

declare module 'jpeg-js/lib/decoder.js' {
  import { decode } from 'jpeg-js';
  export default decode;
}
