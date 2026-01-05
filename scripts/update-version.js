import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const version = process.argv[2];
if (!version) {
    console.error('Usage: node update-version.js <version>');
    process.exit(1);
}

// Ensure 4 components for Stream Deck version (Major.Minor.Patch.Build)
// Semantic release gives us X.Y.Z
// We'll map it to X.Y.Z.0
const sdVersion = `${version}.0`;

const manifestPath = join(__dirname, '../se.oscarb.pomodoro.sdPlugin/manifest.json');

try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.Version = sdVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t'));
    console.log(`Updated manifest version to ${sdVersion}`);
} catch (error) {
    console.error('Failed to update manifest:', error);
    process.exit(1);
}
