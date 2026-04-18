#!/usr/bin/env node
// Simple build script: zips the extension/ directory into dist/ubersdr_bridge_chrome-{version}.zip
// No npm dependencies required — uses Node.js built-ins only.

import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createGzip } from 'zlib';

// Read version from manifest
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const version  = manifest.version;

const distDir  = 'dist';
const outFile  = join(distDir, `ubersdr_bridge_chrome-${version}.zip`);

mkdirSync(distDir, { recursive: true });

// Use the system zip command for simplicity (available on Linux/macOS).
// On Windows, use PowerShell's Compress-Archive or install 7-zip.
import { execSync } from 'child_process';

try {
    execSync(
        `cd extension && zip -r ../${outFile} . --exclude "*.DS_Store" --exclude "__MACOSX/*"`,
        { stdio: 'inherit' }
    );
    console.log(`\n✅ Built: ${outFile}`);
    console.log('   Load in Chrome: chrome://extensions → Developer mode → Load unpacked (use extension/ dir)');
    console.log('   Or upload the .zip to the Chrome Web Store developer dashboard.');
} catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
}
