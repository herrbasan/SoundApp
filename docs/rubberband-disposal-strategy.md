# Rubberband Pipeline Disposal & Re-initialization Strategy

## Current Problems

1. **Audio Bleed Between Tracks**: When Parameters window is open and switching tracks, audio from previous track bleeds into the start of the next track
2. **Crackling on Parameter Changes**: Changing pitch/tempo/options causes audible artifacts
3. **Memory Leak**: Rubberband pipeline has a serious memory leak over time
4. **No Clean Reset**: The rubberband WASM processor doesn't expose a reset/flush method

## Root Cause

The rubberband AudioWorkletNode (`realtime-pitch-shift-processor.js`) is a compiled WASM module that maintains internal state:
- Internal ring buffers for audio processing
- DSP state for pitch/time algorithms
- No exposed `reset()` or `flush()` method in the WASM API

When we call `stop()` on the rubberband pipeline, the FFmpeg decoder stops but the worklet keeps its accumulated audio in internal buffers.

## Solution Strategy

### 1. Track Switching: Dispose & Recreate Worklet

**When:** Switching between tracks while Parameters window is open and rubberband pipeline is active

**How:**
```javascript
// In RubberbandPipeline.open():
async open(filePath) {
    if (!this.initialized) await this.init();
    
    // NEW: If we're already initialized and changing files, dispose and recreate worklet
    if (this.rubberbandNode && this.filePath !== filePath) {
        await this.disposeWorklet();
        await this.recreateWorklet();
    }
    
    this.filePath = filePath;
    
    let metadata = null;
    if (this.player) {
        metadata = await this.player.open(filePath);
    }
    
    this.setPitch(this.currentPitch);
    this.setTempo(this.currentTempo);
    return metadata;
}
```

### 2. Parameter Changes: Smart Handling

**Options Changes (Quality/Formant):**
- Rubberband internally recreates its processing kernel when options change
- Use fade-out → setOptions → 300ms stabilization → fade-in pattern
- Full worklet recreation is NOT necessary (too disruptive)

**Pitch/Tempo Changes:**
- Keep DIRECT with NO fades - rubberband handles these internally
- Adding fades or disposal makes it worse
- 30ms debounce on sliders to reduce load during drag

**Recommendation:** Fade+stabilization for options, direct for pitch/tempo

### 3. New Methods in RubberbandPipeline

**CRITICAL: Audio Chain Reconnection**

The audio chain is:
```
FFmpegPlayer.workletNode → FFmpegPlayer.gainNode → rubberbandNode → RubberbandPipeline.gainNode → destination
```

When recreating the rubberband worklet, you MUST reconnect the FFmpegPlayer's gainNode to the new rubberbandNode, otherwise audio won't flow!

```javascript
class RubberbandPipeline {
    // ... existing code ...
    
    /**
     * Dispose only the rubberband worklet node, keeping FFmpeg player
     */
    async disposeWorklet() {
        if (this.rubberbandNode) {            
            // Disconnect everything
            try {
                this.rubberbandNode.disconnect();
            } catch(e) {}
            
            // Give worklet time to clean up
            await new Promise(resolve => setTimeout(resolve, 10));
            
            this.rubberbandNode = null;
            this.isConnected = false;
            
            console.log('[RubberbandPipeline] Worklet disposed');
        }
    }
    
    /**
     * Recreate the rubberband worklet node
     */
    async recreateWorklet() {
        if (this.rubberbandNode) {
            await this.disposeWorklet();
        }
        
        // CRITICAL: Disconnect player from old routing first
        if (this.player && this.player.gainNode) {
            try { this.player.gainNode.disconnect(); } catch(e) {}
        }
        
        try {
            this.rubberbandNode = new AudioWorkletNode(this.ctx, 'realtime-pitch-shift-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                processorOptions: { 
                    blockSize: 4096,
                    highQuality: this.options.highQuality || true
                }
            });
            
            // Rebuild full audio chain
            this.rubberbandNode.connect(this.gainNode);
            
            // CRITICAL: Reconnect player to new rubberband node
            if (this.player && this.player.gainNode) {
                this.player.gainNode.connect(this.rubberbandNode);
            }
            
            // Reapply current settings
            this.setPitch(this.currentPitch);
            this.setTempo(this.currentTempo);
            this.setOptions(this.options);
            
            console.log('[RubberbandPipeline] Worklet recreated');
        } catch(e) {
            console.error('Failed to recreate rubberband worklet:', e);
            throw e;
        }
    }
    
    /**
     * Full disposal including FFmpeg player
     */
    dispose() {
        console.log('[RubberbandPipeline] Full dispose');
        
        if (this.player) {
            this.player.dispose();
            this.player = null;
        }
        
        if (this.rubberbandNode) {
            try { this.rubberbandNode.disconnect(); } catch(e) {}
            this.rubberbandNode = null;
        }
        
        if (this.gainNode) {
            try { this.gainNode.disconnect(); } catch(e) {}
            this.gainNode = null;
        }
        
        this.isConnected = false;
        this.initialized = false;
        this.filePath = null;
    }
}
```

### 4. Update clearAudio() in stage.js

```javascript
function clearAudio(){
    console.log('[clearAudio] Stopping current audio, pipeline:', g.activePipeline);
    
    if(g.ffmpegPlayer) {
        if(typeof g.ffmpegPlayer.clearBuffer === 'function') g.ffmpegPlayer.clearBuffer();
        g.ffmpegPlayer.stop(true);
        console.log('[clearAudio] Stopped ffmpegPlayer');
    }
    
    if(g.rubberbandPlayer) {
        g.rubberbandPlayer.disconnect();
        
        // NEW: Dispose and recreate worklet to flush internal buffers
        if (g.rubberbandPlayer.disposeWorklet) {
            g.rubberbandPlayer.disposeWorklet().catch(e => {
                console.error('[clearAudio] Failed to dispose rubberband worklet:', e);
            });
        }
        
        g.rubberbandPlayer.reset();
        
        if(g.rubberbandPlayer.player && typeof g.rubberbandPlayer.player.clearBuffer === 'function'){
            g.rubberbandPlayer.player.clearBuffer();
        }
        
        g.rubberbandPlayer.stop(false);
        console.log('[clearAudio] Stopped, reset, and disposed rubberband worklet');
        
        g.activePipeline = 'normal';
    }
    
    if(g.currentAudio){
        if(g.currentAudio.isMod) player.stop();
        if(g.currentAudio.isMidi && midi) midi.stop();
        console.log('[clearAudio] Cleared currentAudio');
        g.currentAudio = undefined;
    }
}
```

### 5. Options Change Handler in stage.js

```javascript
ipcRenderer.on('param-change', async (e, data) => {
    // ... existing code ...
    
    else if(data.param === 'formant'){
        g.audioParams.formant = !!data.value;
        if(g.activePipeline === 'rubberband' && g.rubberbandPlayer){
            // Options changes require worklet recreation for clean state
            if(typeof g.rubberbandPlayer.disposeWorklet === 'function' && 
               typeof g.rubberbandPlayer.recreateWorklet === 'function'){
                try {
                    const wasPlaying = g.rubberbandPlayer.isPlaying;
                    const currentTime = g.rubberbandPlayer.getCurrentTime();
                    
                    await g.rubberbandPlayer.fadeOut();
                    
                    // Recreate worklet with new options
                    await g.rubberbandPlayer.disposeWorklet();
                    await g.rubberbandPlayer.recreateWorklet();
                    
                    // Reconnect if was connected
                    if(g.rubberbandPlayer.isConnected === false){
                        g.rubberbandPlayer.connect();
                    }
                    
                    // Restore playback state
                    if(currentTime > 0) g.rubberbandPlayer.seek(currentTime);
                    if(wasPlaying) {
                        await new Promise(resolve => setTimeout(resolve, 300)); // Stabilization
                        g.rubberbandPlayer.play();
                        await g.rubberbandPlayer.fadeIn();
                    }
                } catch(err) {
                    console.error('Failed to recreate worklet for options change:', err);
                }
            } else {
                // Fallback to old method
                if(typeof g.rubberbandPlayer.setOptions === 'function'){
                    g.rubberbandPlayer.setOptions({ formantPreserved: !!data.value });
                }
            }
        }
    }
});
```

## Implementation Order

1. **Phase 1**: Add `disposeWorklet()` and `recreateWorklet()` methods to RubberbandPipeline
2. **Phase 2**: Update `clearAudio()` to call `disposeWorklet()` when clearing rubberband
3. **Phase 3**: Update `open()` to recreate worklet on file change
4. **Phase 4**: Test track switching - verify no audio bleed
5. **Phase 5**: Implement options-change recreation logic
6. **Phase 6**: Test parameter changes - verify reduced crackling

## Testing Checklist

- [ ] Load track with Parameters window open
- [ ] Switch to next track - verify no audio bleed from previous track
- [ ] Change pitch while playing - verify smooth change, no crackling
- [ ] Change tempo while playing - verify smooth change, no crackling  
- [ ] Toggle formant mode - verify it works without excessive crackling
- [ ] Play for extended period (10+ minutes) - verify no memory accumulation
- [ ] Rapid track switching - verify stability
- [ ] Close Parameters window mid-track - verify clean switch to normal pipeline

## Expected Outcomes

1. **No Audio Bleed**: Track switches will have clean silence at start
2. **Reduced Crackling**: Options changes will be cleaner (pitch/tempo already good)
3. **No Memory Leak**: Worklet disposal prevents accumulation
4. **Stable Pipeline**: Recreation pattern is proven (from FFmpeg SAB player experience)

## Notes

- The FFmpeg SAB player uses a similar pattern - worklet is reused across tracks with `stop(true)`, but full `dispose()` is available when needed
- Rubberband worklet is more complex because it has internal DSP state that can't be reset
- This approach aligns with Memory #139 recommendation to destroy/recreate rather than try to flush
