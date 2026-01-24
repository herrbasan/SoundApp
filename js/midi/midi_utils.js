
/*
	MIDI Utilities
	- Metadata parsing
	- Metronome track generation
	- Buffer injection
*/

export function readString(dv, offset, len) {
	let str = '';
	for (let i = 0; i < len; i++) {
		str += String.fromCharCode(dv.getUint8(offset + i));
	}
	return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
}

export function parseMidiMetadata(buf) {
	const info = {
		title: '',
		copyright: '',
		timeSignature: '',
		keySignature: '',
		markers: [],
		text: [],
		timeSignatures: [], // Map of { tick, n, d }
		maxTick: 0,
		channels: new Set(),
		ppq: 96
	};
	
	try {
		const dv = new DataView(buf);
		let p = 0;

		// Check Header
		if (dv.getUint32(p) !== 0x4D546864) return info; // MThd
		p += 4;
		const headerLen = dv.getUint32(p);
		p += 4;
		const format = dv.getUint16(p); p += 2;
		const ntrks = dv.getUint16(p); p += 2;
		const division = dv.getUint16(p); p += 2;
		
		// Handle PPQ / SMPTE
		let ppq = division;
		if (division & 0x8000) {
			console.warn('[MIDI Utils] SMPTE time division not fully supported, falling back to 96 PPQ');
			ppq = 96;
		}
		info.ppq = ppq;

		// Jump to start of tracks
		p = 14 + (headerLen - 6);
		
		// Iterate all tracks to find metadata and length
		for (let t = 0; t < ntrks; t++) {
			if (p + 4 > dv.byteLength) break;
			
			// Validate Track Header
			if (dv.getUint32(p) !== 0x4D54726B) break; // MTrk
			p += 4;
			const trackLen = dv.getUint32(p);
			p += 4;
			const end = p + trackLen;

			let runningStatus = 0;
			let absTick = 0;
			let tp = p; // Track Pointer

			while (tp < end) {
				// Read VLQ delta-time (Big Endian)
				let delta = 0;
				let b = dv.getUint8(tp++);
				delta = b & 0x7F;
				while (b & 0x80) {
					if (tp >= end) break;
					b = dv.getUint8(tp++);
					delta = (delta << 7) | (b & 0x7F);
				}
				absTick += delta;
				if (absTick > info.maxTick) info.maxTick = absTick;

				if (tp >= end) break;

				// Read Status
				let status = dv.getUint8(tp);
				if (status < 0x80) {
					status = runningStatus;
				} else {
					tp++;
					if (status < 0xF0) runningStatus = status;
				}

				if (status >= 0x80 && status < 0xF0) {
					// Channel Message
					const type = status & 0xF0;
					const ch = status & 0x0F;
					info.channels.add(ch);

					if (type === 0xC0 || type === 0xD0) { tp += 1; }
					else { tp += 2; }
				} else if (status === 0xF0 || status === 0xF7) {
					// Sysex
					let len = 0;
					let b = dv.getUint8(tp++);
					len = b & 0x7F;
					while (b & 0x80) {
						if (tp >= end) break;
						b = dv.getUint8(tp++);
						len = (len << 7) | (b & 0x7F);
					}
					tp += len;
				} else if (status === 0xFF) {
					// Meta Event
					const type = dv.getUint8(tp++);
					
					let len = 0;
					let b = dv.getUint8(tp++);
					len = b & 0x7F;
					while (b & 0x80) {
						if (tp >= end) break;
						b = dv.getUint8(tp++);
						len = (len << 7) | (b & 0x7F);
					}

					if (tp + len <= end) {
						if (type === 0x03 && !info.title) {
							info.title = readString(dv, tp, len);
						} else if (type === 0x02 && !info.copyright) {
							info.copyright = readString(dv, tp, len);
						} else if (type === 0x01) {
							const t = readString(dv, tp, len);
							if(t && info.text.length < 5) info.text.push(t);
						} else if (type === 0x58) {
							const nn = dv.getUint8(tp);
							const dd = Math.pow(2, dv.getUint8(tp + 1));
							if(!info.timeSignature) info.timeSignature = `${nn}/${dd}`;
							info.timeSignatures.push({ tick: absTick, n: nn, d: dd });
						} else if (type === 0x59 && !info.keySignature) {
							const sf = dv.getInt8(tp);
							const mi = dv.getUint8(tp + 1);
							const keys = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
							const idx = sf + 7;
							if (idx >= 0 && idx < keys.length) {
								info.keySignature = keys[idx] + (mi ? 'm' : '');
							}
						} else if (type === 0x06) {
							info.markers.push(readString(dv, tp, len));
						}
					}
					tp += len;
				}
			}
			
			// Advance to next track
			p = end;
		}
		
	} catch(e) {
		console.error('[MIDI Utils] Incomplete metadata parse:', e);
	}

	return info;
}

export function generateMetronomeTrack(info, ppq) {
	if(!ppq || !info.maxTick) return null;
	
	// Intelligent Channel Selection
	// FIXED Strategy: Force Channel 16 (15).
	// Detecting "unused" channels is risky (late usage), and Channel 10 is critical for Drums.
	// Channel 16 is the standard "safe" sacrifice.
	const channel = 15;
	
	if (info.channels.has(15)) {
		console.warn('[MIDI Utils] Channel 16 is busy, but hijacking ensures consistent Metronome behavior.');
	} else {
		console.log('[MIDI Utils] Metronome assigned to Channel 16');
	}

	// SETUP METRONOME SOUNDS
	const isDrumChannel = (channel === 9); 
	let prog, noteAcc, noteBeat;
	
	if (isDrumChannel) {
		// Do NOT send Program Change (keep existing Kit)
		prog = -1; 
		// Standard Kit: 76 (Hi Woodblock), 77 (Low Woodblock)
		noteAcc = 76;
		noteBeat = 77; 
	} else {
		// Melodic: Program 115 is Woodblock
		prog = 115;
		// Pitched up for better cut usage: F6/E6 (89/88).
		noteAcc = 89; 
		noteBeat = 88;
	}
	
	// Helper to write VLQ directly to array
	const writeVLQ = (arr, val) => {
		if (val === 0) { arr.push(0); return; }
		const buffer = [];
		while (val > 0) {
			buffer.push(val & 0x7F);
			val = val >>> 7; // Unsigned shift
		}
		for (let i = buffer.length - 1; i >= 0; i--) {
			arr.push(buffer[i] | (i > 0 ? 0x80 : 0));
		}
	};
	
	const trackBytes = [];
	// MTrk header
	[0x4D, 0x54, 0x72, 0x6B].forEach(b => trackBytes.push(b));
	// Length placeholder (4 bytes)
	[0, 0, 0, 0].forEach(b => trackBytes.push(b));
	
	/* 
	   FIX: If we don't initialize volume, we might get a single tick IF the player defaults
	   to volume 100 before our 'setMetronome(false)' call kicks in during playback start.
	   However, if we DO initialize volume to 0 (CC7), the synth "chases" it on seek and mutes us.
	   
	   HYBRID SOLUTION: Initialize Volume to 0, but place it at Tick 0.
	   Then immediately place a Volume 127 event at Tick 1.
	   Why?
	   Because if we seek to >0, the synth chases the LAST event. which is 127. So it stays ON.
	   If we enable metronome, we send 127 anyway.
	   If we disable, we send 0.
	   
	   WAIT. If we have Volume 127 at Tick 1, disabling it via CC at the start might still be fighting.
	   
	   BETTER SOLUTION:
	   Initialize to SILENCE (Vol 0) at Tick 0.
	   Then, rely on MIDI.JS `setMetronome(true)` to send Vol 127 when user wants it.
	   AND ensure `setMetronome` is called AFTER any seek/reset operations.
	   
	   The user said "One single tick". This implies it starts audible and then gets muted?
	   Or it plays the very first note before the mute happens?
	   
	   If we put Vol 0 at Tick 0, the first note (also at Tick 0) might play before the Volume change takes effect depending on order?
	   Let's ensure the Control Change happens BEFORE any note.
	   The loop below handles notes.
	*/

	// INITIALIZE CHANNEL TO SILENT (CC7 Volume 0)
	// We MUST do this to prevent the "single tick" on start.
	// We will solve the "seek mute" issue by re-sending Vol 127 in midi.js after seek.
	
	writeVLQ(trackBytes, 0); // Delta 0
	trackBytes.push(0xB0 | channel); 
	trackBytes.push(7); 
	trackBytes.push(0);

	// CC11 Expression 0
	writeVLQ(trackBytes, 0);
	trackBytes.push(0xB0 | channel); 
	trackBytes.push(11); 
	trackBytes.push(0);

	// Set Program Change only if Melodic
	if (prog !== -1) {
		writeVLQ(trackBytes, 0);
		trackBytes.push(0xC0 | channel);
		trackBytes.push(prog);
	}

	// Prepare Time Signatures
	const timeSigs = (info.timeSignatures || []).sort((a,b) => a.tick - b.tick);
	if(timeSigs.length === 0 || timeSigs[0].tick > 0) {
		timeSigs.unshift({ tick: 0, n: 4, d: 4 });
	}

	let currentTick = 0;
	let lastEventTick = 0;
	let tsIdx = 0;
	let currentTs = timeSigs[0];
	let nextTs = timeSigs[1];
	
	let bar = 0;
	let beat = 0;
	
	// Iterate until maxTick
	while(currentTick < info.maxTick) {
		// Check for TS change
		if(nextTs && currentTick >= nextTs.tick) {
			currentTs = nextTs;
			tsIdx++;
			nextTs = timeSigs[tsIdx + 1];
			beat = 0; // Reset beat separate on TS change
		}
		
		const isAccent = (beat === 0);
		const note = isAccent ? noteAcc : noteBeat;
		// Accent: Max volume (127), Others: ~70 (70)
		const vel = isAccent ? 127 : 70;

		// Delta Time for Note On
		const deltaOn = currentTick - lastEventTick;
		writeVLQ(trackBytes, deltaOn);
		lastEventTick = currentTick;
		
		// Note On
		trackBytes.push(0x90 | channel);
		trackBytes.push(note);
		trackBytes.push(vel);
		
		// Duration 1/16th note approx
		const dur = Math.max(10, Math.floor(ppq / 4));
		const offTick = currentTick + dur;
		
		const deltaOff = offTick - lastEventTick;
		writeVLQ(trackBytes, deltaOff);
		lastEventTick = offTick;
		
		// Note Off
		trackBytes.push(0x80 | channel);
		trackBytes.push(note);
		trackBytes.push(0);
		
		// Advance time
		const ticksPerBeat = (ppq * 4) / currentTs.d;
		currentTick += ticksPerBeat;
		
		beat++;
		if(beat >= currentTs.n) {
			beat = 0;
			bar++;
		}
	}
	
	// End of Track
	const deltaEnd = 0;
	writeVLQ(trackBytes, deltaEnd);
	trackBytes.push(0xFF);
	trackBytes.push(0x2F);
	trackBytes.push(0x00);
	
	// Fix Length
	const len = trackBytes.length - 8;
	trackBytes[4] = (len >>> 24) & 0xFF;
	trackBytes[5] = (len >>> 16) & 0xFF;
	trackBytes[6] = (len >>> 8) & 0xFF;
	trackBytes[7] = len & 0xFF;
	
	return { buffer: new Uint8Array(trackBytes), channel };
}

export function injectTrack(ab, trackBytes) {
	const dv = new DataView(ab);
	if (dv.getUint32(0) !== 0x4D546864) return ab; // MThd

	const newLen = ab.byteLength + trackBytes.byteLength;
	const newBuf = new Uint8Array(newLen);
	newBuf.set(new Uint8Array(ab), 0);
	
	const newDv = new DataView(newBuf.buffer);
	
	// Update Format -> 1 if was 0 (Multi-track)
	const oldFormat = dv.getUint16(8);
	if (oldFormat === 0) {
		newDv.setUint16(8, 1);
	}
	
	// Increment Track Count
	const ntrks = dv.getUint16(10);
	newDv.setUint16(10, ntrks + 1);
	
	// Append new track
	newBuf.set(trackBytes, ab.byteLength);
	
	return newBuf.buffer;
}
