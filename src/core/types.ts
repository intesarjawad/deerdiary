import type { CameraTime } from './time';

export type Detection = {
  category: '1' | '2' | '3';
  conf: number;
  bbox: readonly [x: number, y: number, width: number, height: number];
  processed_classification?: { class: string; score: number; source: string };
};

export type PhotoResult = {
  path: string;
  time: CameraTime;
  detections: readonly Detection[];
};

export type DeerdiaryEvent = {
  cameraKey: string;
  photos: readonly PhotoResult[];
  species: readonly { label: string; bestPhoto: PhotoResult }[];
};

export type IndependentDetection = {
  cameraKey: string;
  label: string;
  time: CameraTime;
  event: DeerdiaryEvent;
};
