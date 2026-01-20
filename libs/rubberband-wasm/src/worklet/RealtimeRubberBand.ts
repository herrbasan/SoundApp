import HeapArray from '../wasm/HeapArray'
import { RealtimePitchShift } from './RealtimePitchShift'
import { RubberBandModule, RealtimeRubberBand as RealtimeRubberBandKernel } from './RubberBandModule'

const RENDER_QUANTUM_FRAMES = 128

interface RealtimeRubberBandOptions {
  highQuality?: boolean,
  pitch?: number,
  tempo?: number,
  blockSize?: number
}

class RealtimeRubberBand implements RealtimePitchShift {
  private readonly _highQuality: boolean
  private readonly _channelCount: number
  private readonly _blockSize: number
  private readonly _kernel: RealtimeRubberBandKernel
  private readonly _inputArray: HeapArray
  private readonly _outputArray: HeapArray
  private _tempo: number = 1
  private _pitch: number = 1

  public constructor(
    module: RubberBandModule,
    sampleRate: number,
    channelCount: number,
    options?: RealtimeRubberBandOptions
  ) {
    this._highQuality = options?.highQuality || false
    this._channelCount = channelCount
    this._blockSize = Math.max(RENDER_QUANTUM_FRAMES, (options?.blockSize || RENDER_QUANTUM_FRAMES) | 0)
    const KernelCtor: any = (module as any).RealtimeRubberBand
    this._kernel = new KernelCtor(sampleRate, this._channelCount, this._highQuality, this._blockSize)
    this._inputArray = new HeapArray(module, this._blockSize, channelCount)
    this._outputArray = new HeapArray(module, RENDER_QUANTUM_FRAMES, channelCount)
    this._pitch = options?.pitch || 1
    this._tempo = options?.tempo || 1

    // Ensure the freshly-created kernel gets the current params immediately.
    // Otherwise toggling HQ (which recreates the kernel) resets pitch/tempo.
    this._kernel.setPitch(this._pitch)
    this._kernel.setTempo(this._tempo)
  }

  get timeRatio(): number {
    return this._tempo
  }

  set timeRatio(timeRatio: number) {
    this._tempo = timeRatio
    this._kernel.setTempo(this._tempo)
  }

  public set pitchScale(pitch: number) {
    this._pitch = pitch
    this._kernel.setPitch(pitch)
  }

  public get samplesAvailable(): number {
    return this._kernel?.getSamplesAvailable() || 0
  }

  public push(channels: Float32Array[], numSamples?: number) {
    const channelCount = channels.length
    if (channelCount > 0) {
      for (let channel = 0; channel < channelCount; ++channel) {
        this._inputArray.getChannelArray(channel).set(channels[channel])
      }
      const n = (numSamples || RENDER_QUANTUM_FRAMES) | 0
      this._kernel.push(this._inputArray.getHeapAddress(), Math.min(n, this._blockSize))
    }
  }

  public pushSlice(channels: Float32Array[], start: number, end: number) {
    const len = end - start
    if (len > this._blockSize) {
      throw new Error(`Part is larger than number of samples: ${len} > ${this._blockSize}`)
    }
    const channelCount = channels.length
    if (channelCount > 0) {
      for (let channel = 0; channel < channelCount; ++channel) {
        this._inputArray.getChannelArray(channel).set(channels[channel].slice(start, end))
      }
      this._kernel.push(this._inputArray.getHeapAddress(), len)
    }
  }

  public pull(channels: Float32Array[]): Float32Array[] {
    const channelCount = channels.length
    if (channelCount > 0) {
      // Always retrieve: kernel.pull() will zero-fill if insufficient samples are available.
      // This keeps RubberBand drained and avoids unbounded internal buffering.
      this._kernel.pull(this._outputArray.getHeapAddress(), RENDER_QUANTUM_FRAMES)
      for (let channel = 0; channel < channels.length; ++channel) {
        channels[channel].set(this._outputArray.getChannelArray(channel))
      }
    }
    return channels
  }

  public get version(): number {
    return this._kernel.getVersion()
  }

  public get channelCount(): number {
    return this._channelCount
  }

  public get highQuality(): boolean {
    return this._highQuality
  }
}

export { RealtimeRubberBand }