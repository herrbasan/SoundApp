// Minimal ambient typings to keep the worklet TS files type-checking in this workspace.
// This avoids relying on external @types packages being resolved by the editor.

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: any) => AudioWorkletProcessor) | any
): void;
