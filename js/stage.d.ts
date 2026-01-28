/**
 * Type declarations for stage.js (Electron Audio Player)
 * 
 * This file provides type information for AI agents and IDEs without
 * duplicating implementation details. Only public-facing types and the
 * global state object are documented here.
 */

/// <reference types="electron" />
/// <reference types="node" />

declare global {
	const g: GlobalState;
	const player: ChiptunePlayer;
	const midi: MidiPlayer | null;
}

// ============================================================================
// Global State
// ============================================================================

export interface GlobalState {
	test: Record<string, any>;
	
	/**
	 * Dual-Pipeline Architecture:
	 * 
	 * NORMAL PIPELINE (audioContext):
	 * - Variable sample rate (48kHz or HQ mode up to 192kHz)
	 * - Used for standard playback
	 * - FFmpeg decoder outputs at exactly audioContext.sampleRate
	 * 
	 * RUBBERBAND PIPELINE (rubberbandContext):
	 * - Fixed 48kHz sample rate (rubberband requirement)
	 * - Used when Parameters window is open for pitch/time control
	 * 
	 * NOTE: Only ONE context is connected to output at a time.
	 */
	audioContext: AudioContext;
	rubberbandContext: AudioContext;
	maxSampleRate: number;
	
	activePipeline: 'normal' | 'rubberband';
	parametersOpen: boolean;
	
	/**
	 * FFmpeg SAB (SharedArrayBuffer) based streaming player.
	 * 
	 * Uses zero-copy audio transfer between decoder and AudioWorkletProcessor.
	 * Supports gapless looping via ring buffer architecture.
	 * WorkletNode is reused across tracks to prevent memory leaks.
	 */
	ffmpegPlayer: FFmpegStreamPlayerSAB;
	
	/**
	 * Rubberband pipeline for real-time pitch/time manipulation.
	 * 
	 * Composite pipeline using fixed 48kHz AudioContext.
	 * Only active when Parameters window is open.
	 */
	rubberbandPlayer: RubberbandPipeline | null;
	
	/**
	 * Global MIDI player instance (FluidSynth WASM).
	 * Null if MIDI initialization failed.
	 */
	midi: MidiPlayer | null;
	
	music: string[];
	idx: number;
	max: number;
	currentAudio: CurrentAudio | null;
	
	windows: WindowRefs;
	windowsVisible: WindowVisibility;
	windowsClosing: WindowVisibility;
	lastNavTime: number;
	mixerPlaying: boolean;
	
	/**
	 * Ephemeral MIDI settings (not saved to config).
	 * Reset when MIDI window closes.
	 */
	midiSettings: {
		pitch: number;
		speed: number | null;
		metronome?: boolean;
	};
	
	/**
	 * Audio manipulation parameters for rubberband pipeline.
	 * Active when Parameters window is open.
	 */
	audioParams: {
		pitch: number;
		tempo: number;
		formant: boolean;
	};
	
	config: UserConfig;
	config_obj: any;
	win: Electron.BrowserWindow;
	main_env: any;
	basePath: string;
	isPackaged: boolean;
	cache_path: string;
	start_vars: any;
	app_path: string;
	configName: string;
	
	// FFmpeg paths
	ffmpeg_napi_path: string;
	ffmpeg_player_path: string;
	ffmpeg_worklet_path: string;
	ffmpeg_player_pm_path: string;
	ffmpeg_worklet_pm_path: string;
	ffmpeg_player_sab_path: string;
	ffmpeg_worklet_sab_path: string;
	rubberband_worklet_path: string;
	
	// FFmpeg utilities
	getMetadata: (filePath: string) => AudioMetadata;
	FFmpegDecoder: any;
	canFFmpegPlayFile: (filePath: string) => boolean;
	
	// File format support
	supportedMpt: string[];
	supportedMIDI: string[];
	supportedChrome: string[];
	supportedFFmpeg: string[];
	supportedFilter: string[];
	
	// UI state
	blocky: boolean;
	isLoop: boolean;
	scale: number;
	
	// DOM element references
	body: HTMLBodyElement;
	frame: HTMLElement;
	top: HTMLElement;
	top_num: HTMLElement;
	top_close: HTMLElement;
	time_controls: HTMLElement;
	playhead: HTMLElement;
	prog: HTMLElement;
	cover: HTMLElement;
	type_band: HTMLElement;
	playtime: HTMLElement;
	playvolume: HTMLElement;
	playspeed: HTMLElement;
	playremain: HTMLElement;
	top_btn_loop: HTMLElement;
	top_btn_shuffle: HTMLElement;
	top_btn_playpause: HTMLElement;
	ctrl_btn_prev: HTMLElement;
	ctrl_btn_next: HTMLElement;
	ctrl_btn_shuffle: HTMLElement;
	ctrl_btn_play: HTMLElement;
	ctrl_btn_loop: HTMLElement;
	ctrl_btn_settings: HTMLElement;
	ctrl_btn_help: HTMLElement;
	ctrl_volume: HTMLElement;
	ctrl_volume_bar: HTMLElement | null;
	ctrl_volume_bar_inner: HTMLElement | null;
	ctrl_volume_slider?: any;
	timeline_slider?: any;
	text: HTMLElement;
	dropZone: any;
	
	// Runtime state
	wheel_vol?: { acc: number; t: number };
	window_move_timeout?: number;
	currentInfo?: { duration: number; metadata?: any; file?: any; cover_src?: string };
	info_win?: number | null;
	lastMinsec?: string;
	last_vol?: number;
	midiInitError?: string;
}

export interface CurrentAudio {
	fp: string;
	currentTime: number;
	duration: number;
	paused?: boolean;
	isFFmpeg?: boolean;
	isMod?: boolean;
	isMidi?: boolean;
	pipeline?: 'normal' | 'rubberband';
	player?: FFmpegStreamPlayerSAB | RubberbandPipeline;
	volume?: number;
	metadata?: AudioMetadata;
	bench?: number;
	lastTime?: number;
	play: () => void;
	pause: () => void;
	seek?: (time: number) => void;
	getCurrentTime?: () => number;
}

export interface AudioMetadata {
	title?: string;
	artist?: string;
	album?: string;
	date?: string;
	genre?: string;
	comment?: string;
	bitrate?: number;
	sampleRate?: number;
	channels?: number;
	duration?: number;
	coverArt?: Buffer;
	coverArtMimeType?: string;
	[key: string]: any;
}

export interface WindowRefs {
	help: number | null;
	settings: number | null;
	playlist: number | null;
	mixer: number | null;
	pitchtime: number | null;
	midi: number | null;
	parameters: number | null;
}

export interface WindowVisibility {
	help: boolean;
	settings: boolean;
	playlist: boolean;
	mixer: boolean;
	pitchtime: boolean;
	midi: boolean;
	parameters: boolean;
}

export interface UserConfig {
	ui?: {
		theme?: 'dark' | 'light';
		showControls?: boolean;
		defaultDir?: string;
		keepRunningInTray?: boolean;
	};
	audio?: {
		hqMode?: boolean;
		volume?: number;
		playbackRate?: number;
		output?: {
			deviceId?: string;
		};
	};
	ffmpeg?: {
		stream?: {
			prebufferChunks?: number;
		};
		decoder?: {
			threads?: number;
		};
	};
	tracker?: {
		stereoSeparation?: number;
		interpolationFilter?: number;
	};
	midiSoundfont?: string;
	windows?: {
		main?: {
			scale?: number;
			x?: number;
			y?: number;
			width?: number;
			height?: number;
		};
		[key: string]: any;
	};
}

// ============================================================================
// Player Interfaces
// ============================================================================

export interface FFmpegStreamPlayerSAB {
	open(filePath: string, loop?: boolean): Promise<any>;
	play(): void;
	pause(): void;
	stop(keepWorklet?: boolean): void;
	dispose(): void;
	getCurrentTime(): number;
	seek(seconds: number): void;
	setVolume(value: number): void;
	getVolume(): number;
	setLoop(enabled: boolean): void;
	setPlaybackRate(semitones: number): void;
	fadeOut?(): Promise<void>;
	clearBuffer?(): void;
	onEnded(callback: () => void): void;
	isPlaying: boolean;
	isLoaded: boolean;
	duration: number;
	volume: number;
	state?: PlaybackState;
	prebufferSize?: number;
	threadCount?: number;
	reuseWorkletNode?: boolean;
}

export interface RubberbandPipeline {
	open(filePath: string, loop?: boolean): Promise<any>;
	loadFile?(filePath: string, loop?: boolean): Promise<void>;
	play(): void;
	pause(): void;
	stop(keepPlayer?: boolean): void;
	reset(): void;
	seek(seconds: number): void;
	setVolume(value: number): void;
	setPitch(ratio: number): void;
	setTempo(ratio: number): void;
	setFormant?(preserve: boolean): void;
	setOptions?(options: { formantPreserved: boolean }): void;
	setLoop(enabled: boolean): void;
	getCurrentTime(): number;
	connect(): void;
	disconnect(): void;
	onEnded(callback: () => void): void;
	isPlaying: boolean;
	isConnected?: boolean;
	currentTime: number;
	duration: number;
	state?: PlaybackState;
	volume: number;
	player?: any;
}

export interface ChiptunePlayer {
	load(arrayBuffer: ArrayBuffer): void;
	play(arrayBuffer: ArrayBuffer): void;
	stop(): void;
	pause(): void;
	unpause(): void;
	togglePause(): void;
	setRepeatCount(count: number): void;
	setStereoSeparation(value: number): void;
	setInterpolationFilter(value: number): void;
	setPitch(semitones: number): void;
	setTempo(ratio: number): void;
	setPos(seconds: number): void;
	setVol(value: number): void;
	seek(seconds: number): void;
	getCurrentTime?(): number;
	gain: GainNode;
	duration: number;
	onMetadata(callback: (meta: any) => void): void;
	onProgress(callback: (data: { pos: number }) => void): void;
	onEnded(callback: () => void): void;
	onError(callback: (err: any) => void): void;
	onInitialized(callback: () => void): void;
}

export interface MidiPlayer {
	init(): Promise<void>;
	load(url: string): Promise<void>;
	loadMIDI(buffer: ArrayBuffer): Promise<void>;
	play(): void;
	pause(): void;
	stop(): void;
	seek(time: number): void;
	setLoop(enabled: boolean): void;
	setPitchOffset(semitones: number): void;
	setTranspose?(semitones: number): void;
	setPlaybackSpeed(ratio: number | null): void;
	resetPlaybackSpeed(): void;
	setBPM?(bpm: number): void;
	getOriginalBPM?(): number;
	setMetronome(enabled: boolean, config?: any): void;
	setSoundFont?(url: string): void;
	setVol(value: number): void;
	getCurrentTime(): number;
	getCurrentTick(): number;
	getDuration(): number;
	isPlaying(): boolean;
	dispose(): void;
	paused: boolean;
	duration: number;
	metronomeEnabled?: boolean;
	onMetadata(callback: (meta: any) => void): void;
	onProgress(callback: (data: { pos: number }) => void): void;
	onEnded(callback: () => void): void;
	onError(callback: (err: any) => void): void;
}

// ============================================================================
// Public Functions (main playback control)
// ============================================================================

export function playAudio(fp: string, n: number, startPaused?: boolean, autoAdvance?: boolean): Promise<void>;
export function playNext(e?: Event, autoAdvance?: boolean): void;
export function playPrev(e?: Event): void;
export function playPause(): void;
export function toggleLoop(): void;
export function seek(milliseconds: number): void;
export function seekTo(seconds: number): void;
export function seekFore(): void;
export function seekBack(): void;
export function setVolume(value: number, persist?: boolean): void;
export function volumeUp(): void;
export function volumeDown(): void;
export function setPlaybackRate(semitones: number): void;
export function speedUp(): void;
export function speedDown(): void;
export function shufflePlaylist(): void;
export function clearAudio(): void;
export function audioEnded(e?: Event): void;

// Playlist Management
export function playListFromSingle(fp: string, rec?: boolean): Promise<void>;
export function playListFromMulti(ar: string[], add?: boolean, rec?: boolean): Promise<void>;

// Pipeline Switching
export function switchPipeline(newMode: 'normal' | 'rubberband'): Promise<void>;

// Window Management
export function openWindow(type: keyof WindowRefs, forceShow?: boolean, contextFile?: string | null): Promise<void>;
export function applyShowControls(show: boolean, resetSize?: boolean): void;
export function scaleWindow(val: number): Promise<void>;

// HQ Mode
export function toggleHQMode(desiredState: boolean, skipPersist?: boolean): Promise<void>;

// MIDI
export function initMidiPlayer(): Promise<void>;
export function initMidiWithSoundfont(soundfontUrl: string, soundfontPath: string): Promise<void>;

// Metadata & Info
export function getFileInfo(fp: string): Promise<AudioMetadata>;
export function getCoverArt(meta: AudioMetadata): Promise<HTMLImageElement | undefined>;
export function renderInfo(fp: string, metadata: AudioMetadata): Promise<void>;

// Utility
export function detectMaxSampleRate(): Promise<number>;
export function loadImage(url: string): Promise<HTMLImageElement>;
export function flashButton(btn: HTMLElement): void;

// ============================================================================
// Helper Types
// ============================================================================

export type WindowType = keyof WindowRefs;
export type PipelineMode = 'normal' | 'rubberband';
export type PlaybackState = 'playing' | 'paused' | 'stopped';

// ============================================================================
// Internal Functions (not exported, for reference only)
// ============================================================================

declare function fb(o: any): void;
declare function _clamp01(v: number): number;
declare function _getMainScale(): number;
declare function _scaledDim(base: number, scale: number): number;
declare function onWheelVolume(e: WheelEvent): void;
declare function volumeSlider(e: any): void;
declare function timelineSlider(e: any): void;
declare function setupDragDrop(): void;
declare function setupWindow(): void;
declare function renderInfoItem(label: string, text: string): HTMLElement;
declare function renderTopInfo(): void;
declare function renderBar(): void;
declare function loop(): void;
declare function checkState(): void;
declare function flashButton(btn: HTMLElement): void;
declare function audioEnded(e?: Event): void;
declare function onKey(e: KeyboardEvent): Promise<void>;
declare function appStart(): Promise<void>;
declare function detectMaxSampleRate(): Promise<number>;
declare function init(): Promise<void>;
declare function initMidiWithSoundfont(soundfontUrl: string, soundfontPath: string): Promise<void>;
declare function getMixerPlaylist(contextFile?: string | string[] | null): Promise<{ paths: string[]; idx: number }>;
