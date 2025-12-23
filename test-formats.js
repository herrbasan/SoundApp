/**
 * Test script to discover audio format support in the FFmpeg build
 * 
 * This creates test files with different extensions and tries to open them
 * to see which formats FFmpeg recognizes. Also shows what extensions
 * FFmpeg typically associates with each format.
 */

const { FFmpegDecoder } = require('./bin/win_bin/');
const fs = require('fs');
const path = require('path');

// Common audio format extensions organized by category
const formatExtensions = {
    // Lossy compressed
    mp3: ['mp3', 'mp2', 'mpa'],
    aac: ['aac', 'm4a', 'm4b', 'm4p', 'mp4', '3gp', 'aa'],
    ogg: ['ogg', 'oga', 'opus', 'spx'],
    wma: ['wma', 'asf'],
    
    // Lossless compressed
    flac: ['flac'],
    alac: ['m4a'],
    ape: ['ape'],
    wv: ['wv'],
    tta: ['tta'],
    
    // Uncompressed/PCM
    wav: ['wav'],
    aiff: ['aif', 'aiff', 'aifc'],
    au: ['au', 'snd'],
    pcm: ['pcm'],
    
    // Module/Tracker formats (handled by libopenmpt in FFmpeg)
    mod: ['mod', 'xm', 's3m', 'it', 'mptm'],
    mod_extended: [
        '669', 'amf', 'ams', 'c67', 'dbm', 'digi', 'dmf', 'dsm', 'dtm',
        'far', 'gdm', 'ice', 'imf', 'j2b', 'm15', 'mdl', 'med', 'mo3',
        'mt2', 'mtm', 'mus', 'nst', 'okt', 'plm', 'psm', 'pt36', 'ptm',
        'sfx', 'sfx2', 'st26', 'stk', 'stm', 'ult', 'wow', 'umx', 'xpk'
    ],
    
    // Other formats
    midi: ['mid', 'midi'],
    tak: ['tak'],
    opus: ['opus'],
    ac3: ['ac3'],
    dts: ['dts'],
    
    // Video containers with audio
    matroska: ['mka', 'mkv'],
    webm: ['webm'],
    
    // Rare/legacy
    ra: ['ra', 'rm', 'ram'],
    voc: ['voc'],
    vqf: ['vqf'],
    caf: ['caf'],
    dsd: ['dsf', 'dff'],
};

// Extract unique extensions for testing
const allExtensions = new Set();
Object.values(formatExtensions).forEach(exts => {
    exts.forEach(ext => allExtensions.add(ext));
});

console.log(`Testing ${allExtensions.size} audio format extensions...\n`);
console.log('Note: This tests format recognition, not actual decoding.');
console.log('FFmpeg will attempt to identify the format even from empty/invalid files.\n');

// Use an actual audio file as test source if available
const testAudioPath = process.argv[2];

if (!testAudioPath) {
    console.log('Usage: node test-formats.js <path-to-valid-audio-file>');
    console.log('\nProvide a valid audio file to test which extensions FFmpeg recognizes.');
    console.log('Example: node test-formats.js "C:\\Music\\test.mp3"');
    process.exit(1);
}

if (!fs.existsSync(testAudioPath)) {
    console.error(`Error: File not found: ${testAudioPath}`);
    process.exit(1);
}

console.log(`Using test file: ${testAudioPath}\n`);
console.log('Testing extensions:\n');

const supported = [];
const unsupported = [];
const decoder = new FFmpegDecoder();

// Create temp directory
const tempDir = path.join(__dirname, 'temp_format_test');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Test each extension by creating a symlink/copy with that extension
for (const ext of Array.from(allExtensions).sort()) {
    const testPath = path.join(tempDir, `test.${ext}`);
    
    try {
        // Copy the test file with new extension
        fs.copyFileSync(testAudioPath, testPath);
        
        // Try to open it
        const result = decoder.open(testPath);
        
        if (result) {
            supported.push(ext);
            console.log(`✓ .${ext}`);
        } else {
            unsupported.push(ext);
            console.log(`✗ .${ext}`);
        }
        
        decoder.close();
        fs.unlinkSync(testPath);
    } catch (err) {
        unsupported.push(ext);
        console.log(`✗ .${ext} (${err.message})`);
    }
}

// Cleanup
fs.rmdirSync(tempDir);

console.log('\n' + '='.repeat(60));
console.log(`RESULTS: ${supported.length} supported, ${unsupported.length} unsupported\n`);

console.log('Supported extensions:');
console.log(supported.join(', '));

if (unsupported.length > 0) {
    console.log('\nUnsupported extensions:');
    console.log(unsupported.join(', '));
}

console.log('\n' + '='.repeat(60));
console.log('\nNote: Format support depends on how the file is encoded,');
console.log('not just the extension. These results show what FFmpeg');
console.log('recognizes based on the codec in your test file.');
