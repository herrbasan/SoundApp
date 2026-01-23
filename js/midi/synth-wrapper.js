// Factory function to create enhanced synthesizer after JSSynth is loaded
export function createEnhancedSynthesizer() {
    const JSSynth = globalThis.JSSynth;
    if (!JSSynth) throw new Error('JSSynth not loaded');
    
    class EnhancedSynthesizer extends JSSynth.AudioWorkletNodeSynthesizer {
        constructor() {
            super();
            this._cachedTick = 0;
            this._isPolling = false;
            this._pollInterval = null;
        }

        async init(settings) {
            await super.init(settings);
        }

        startTickPolling() {
            if (this._isPolling) return;
            this._isPolling = true;
            this._cachedTick = 0;
            
            const poll = async () => {
                if (!this._isPolling) return;
                
                try {
                    const tick = await Promise.race([
                        this.retrievePlayerCurrentTick(),
                        new Promise((_, reject) => setTimeout(() => reject('timeout'), 100))
                    ]);
                    this._cachedTick = tick;
                } catch (e) {
                    // Polling failed (SysEx flood or stopped) - keep last known value
                }
                
                if (this._isPolling) {
                    this._pollInterval = setTimeout(poll, 50);
                }
            };
            
            poll();
        }

        stopTickPolling() {
            this._isPolling = false;
            if (this._pollInterval) {
                clearTimeout(this._pollInterval);
                this._pollInterval = null;
            }
            this._cachedTick = 0;
        }

        getCurrentTickInstant() {
            return this._cachedTick;
        }

        async resetPlayer() {
            this.stopTickPolling();
            return super.resetPlayer();
        }
    }
    
    return new EnhancedSynthesizer();
}
