import { RealtimeRubberBand } from './RealtimeRubberBand'
import * as createModule from '../../wasm/build/rubberband'
import { RubberBandModule } from './RubberBandModule'

class RealtimePitchShiftProcessor extends AudioWorkletProcessor {
  private _module: RubberBandModule | undefined
  private _api: RealtimeRubberBand | undefined
  private running: boolean = true
  private pitch: number = 1
  private tempo: number = 1
  private highQuality: boolean = false
  private blockSize: number = 512
  private _inputBuffers: Float32Array[] | undefined
  private _inputWriteIndex: number = 0

  constructor(options?: any) {
    super()
    const bs = (options?.processorOptions as any)?.blockSize
    if (typeof bs === 'number' && isFinite(bs)) {
      this.blockSize = (bs | 0) || 512
    }
    if (this.blockSize < 128) this.blockSize = 128

    this.port.onmessage = (e) => {
      const data = JSON.parse(e.data)
      const event = data[0] as string
      const payload = data[1]
      switch (event) {
        case 'pitch': {
          this.pitch = payload
          if (this._api)
            this._api.pitchScale = this.pitch
          break
        }
        case 'quality': {
          this.highQuality = payload
          break
        }
        case 'tempo': {
          this.tempo = payload
          if (this._api)
            this._api.timeRatio = this.tempo
          break
        }
        case 'close': {
          this.close()
          break
        }
      }
    }
    createModule()
      .then((module) => {
        this._module = module as unknown as RubberBandModule
      })
      .catch((err) => {
        console.error('RealtimePitchShiftProcessor: createModule failed', err)
      })
  }

  private ensureInputBuffers(channelCount: number) {
    if (!this._inputBuffers || this._inputBuffers.length !== channelCount || this._inputBuffers[0].length !== this.blockSize) {
      this._inputBuffers = new Array(channelCount)
      for (let channel = 0; channel < channelCount; ++channel) {
        this._inputBuffers[channel] = new Float32Array(this.blockSize)
      }
      this._inputWriteIndex = 0
    }
  }

  getApi(channelCount: number): RealtimeRubberBand | undefined {
    const moduleAny: any = this._module as any
    if (moduleAny && typeof moduleAny._malloc === 'function' && moduleAny.HEAPF32) {
      if (
        !this._api ||
        this._api.channelCount !== channelCount ||
        this._api.highQuality !== this.highQuality
      ) {
        this._api = new RealtimeRubberBand(this._module as RubberBandModule, sampleRate, channelCount, {
          highQuality: this.highQuality,
          pitch: this.pitch,
          tempo: this.tempo,
          blockSize: this.blockSize
        })
        this._inputBuffers = undefined
        this._inputWriteIndex = 0
      }
    }
    return this._api
  }

  close() {
    this.port.onmessage = null
    this.running = false
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input0 = inputs[0]
    const output0 = outputs[0]
    const inputChannels = input0?.length || 0
    const outputChannels = output0?.length || 0
    const numChannels = outputChannels || inputChannels

    if (numChannels > 0) {
      const api = this.getApi(numChannels)
      if (api) {
        if (inputChannels > 0 && input0 && input0[0]) {
          const frameCount = input0[0].length
          this.ensureInputBuffers(numChannels)

          let srcOffset = 0
          while (srcOffset < frameCount) {
            const canCopy = Math.min(frameCount - srcOffset, this.blockSize - this._inputWriteIndex)
            for (let channel = 0; channel < numChannels; ++channel) {
              const src = channel < inputChannels ? input0[channel] : input0[0]
              this._inputBuffers![channel].set(src.subarray(srcOffset, srcOffset + canCopy), this._inputWriteIndex)
            }
            this._inputWriteIndex += canCopy
            srcOffset += canCopy

            if (this._inputWriteIndex === this.blockSize) {
              for (let channel = 0; channel < numChannels; ++channel) {
                const buf = this._inputBuffers![channel]
                for (let i = 0; i < this.blockSize; ++i) {
                  const s = buf[i]
                  if (s !== s) buf[i] = 0
                }
              }
              api.push(this._inputBuffers!, this.blockSize)
              this._inputWriteIndex = 0
            }
          }
        }

        if (outputChannels > 0 && output0 && output0[0]) {
          const outputLength = output0[0].length
          api.pull(output0)
          for (let channel = 0; channel < outputChannels; ++channel) {
            const out = output0[channel]
            for (let i = 0; i < outputLength; ++i) {
              const s = out[i]
              if (s !== s) out[i] = 0
            }
          }
        }
      }
    }
    return this.running
  }
}

registerProcessor('realtime-pitch-shift-processor', RealtimePitchShiftProcessor)