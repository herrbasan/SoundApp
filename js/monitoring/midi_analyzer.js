'use strict';

/**
 * Parse MIDI file and extract channel activity segments
 * Groups events by channel with gap detection (3-5 second pauses break segments)
 */

export function parseMidiChannelActivity(buffer, gapThresholdMs = 4000) {
	const view = new DataView(buffer);
	let offset = 0;
	
	// Read header chunk
	const headerType = readChunkType(view, offset);
	if (headerType !== 'MThd') throw new Error('Invalid MIDI file: Missing MThd header');
	offset += 4;
	
	const headerLength = view.getUint32(offset); offset += 4;
	const format = view.getUint16(offset); offset += 2;
	const trackCount = view.getUint16(offset); offset += 2;
	const division = view.getUint16(offset); offset += 2;
	
	// Division determines ticks per quarter note
	const ticksPerBeat = division & 0x7FFF;
	
	// Collect all events with timestamps across all tracks
	const allEvents = [];
	let currentTempo = 500000; // Default: 120 BPM (500,000 microseconds per quarter note)
	
	// Parse all tracks
	for (let track = 0; track < trackCount; track++) {
		const chunkType = readChunkType(view, offset);
		if (chunkType !== 'MTrk') throw new Error(`Invalid track chunk at offset ${offset}`);
		offset += 4;
		
		const trackLength = view.getUint32(offset); offset += 4;
		const trackEnd = offset + trackLength;
		
		let time = 0;
		let runningStatus = 0;
		
		while (offset < trackEnd) {
			// Read delta time (variable length)
			const deltaTime = readVarLen(view, offset);
			offset += deltaTime.length;
			time += deltaTime.value;
			
			// Read event
			let status = view.getUint8(offset);
			
			// Handle running status
			if (status < 0x80) {
				status = runningStatus;
			} else {
				offset++;
				runningStatus = status;
			}
			
			const eventType = status & 0xF0;
			const channel = status & 0x0F;
			
			// Note On/Off
			if (eventType === 0x90 || eventType === 0x80) {
				const note = view.getUint8(offset++);
				const velocity = view.getUint8(offset++);
				
				// Note On with velocity 0 = Note Off
				const isNoteOn = eventType === 0x90 && velocity > 0;
				
				allEvents.push({
					time: time,
					channel: channel,
					type: isNoteOn ? 'noteOn' : 'noteOff',
					note: note,
					velocity: velocity
				});
			}
			// Control Change, Aftertouch, Pitch Bend (2 bytes)
			else if (eventType === 0xB0 || eventType === 0xA0 || eventType === 0xE0) {
				offset += 2;
			}
			// Program Change, Channel Pressure (1 byte)
			else if (eventType === 0xC0 || eventType === 0xD0) {
				offset += 1;
			}
			// Meta event
			else if (status === 0xFF) {
				const metaType = view.getUint8(offset++);
				const metaLength = readVarLen(view, offset);
				offset += metaLength.length;
				
				// Tempo change
				if (metaType === 0x51 && metaLength.value === 3) {
					currentTempo = (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
				}
				
				offset += metaLength.value;
			}
			// SysEx event
			else if (status === 0xF0 || status === 0xF7) {
				const sysexLength = readVarLen(view, offset);
				offset += sysexLength.length + sysexLength.value;
			}
		}
	}
	
	// Convert ticks to milliseconds
	const tickToMs = (currentTempo / 1000) / ticksPerBeat;
	allEvents.forEach(e => e.timeMs = e.time * tickToMs);
	
	// Sort by time
	allEvents.sort((a, b) => a.timeMs - b.timeMs);
	
	// Group into channel segments with gap detection
	const channels = {};
	for (let ch = 0; ch < 16; ch++) {
		channels[ch] = [];
	}
	
	allEvents.forEach(event => {
		const ch = event.channel;
		const segments = channels[ch];
		
		if (segments.length === 0) {
			// First event for this channel
			segments.push({ start: event.timeMs, end: event.timeMs, events: 1 });
		} else {
			const lastSegment = segments[segments.length - 1];
			const gap = event.timeMs - lastSegment.end;
			
			if (gap <= gapThresholdMs) {
				// Continue current segment
				lastSegment.end = event.timeMs;
				lastSegment.events++;
			} else {
				// Start new segment
				segments.push({ start: event.timeMs, end: event.timeMs, events: 1 });
			}
		}
	});
	
	// Get total duration
	const lastEvent = allEvents[allEvents.length - 1];
	const duration = lastEvent ? lastEvent.timeMs / 1000 : 0;
	
	// Filter out empty channels and return
	const activeChannels = [];
	for (let ch = 0; ch < 16; ch++) {
		if (channels[ch].length > 0) {
			activeChannels.push({
				channel: ch,
				segments: channels[ch]
			});
		}
	}
	
	return {
		channels: activeChannels,
		duration: duration
	};
}

function readChunkType(view, offset) {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3)
	);
}

function readVarLen(view, offset) {
	let value = 0;
	let length = 0;
	let byte;
	
	do {
		byte = view.getUint8(offset + length);
		value = (value << 7) | (byte & 0x7F);
		length++;
	} while ((byte & 0x80) && length < 4);
	
	return { value, length };
}
