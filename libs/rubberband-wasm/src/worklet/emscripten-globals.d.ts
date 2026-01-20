// Minimal ambient Emscripten typings for this repo's TS build.
// Keeps `tsc -b src/worklet/tsconfig.json` working without relying on external type resolution.

declare interface EmscriptenModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  ready?: Promise<any>;
  [key: string]: any;
}
