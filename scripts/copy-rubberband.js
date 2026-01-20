const fs = require('fs');
const path = require('path');

function copyRecursive(src, dest) {
	if (!fs.existsSync(dest)) {
		fs.mkdirSync(dest, { recursive: true });
	}
	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyRecursive(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

// Copy processor
fs.copyFileSync(
	'node_modules/rubberband-web/public/rubberband-processor.js',
	'libs/rubberband-processor.js'
);

// Copy dist folder contents directly to libs/rubberband-web (no dist subfolder)
copyRecursive(
	'node_modules/rubberband-web/dist',
	'libs/rubberband-web'
);

console.log('Rubberband files copied to libs/');
