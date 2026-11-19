const fs = require('fs');
const path = require('path');

const tempDir = path.join(__dirname, 'temp_icons');
const sizes = [256, 128, 64, 48, 32, 16];

const images = [];

for (const sz of sizes) {
  const pngPath = path.join(tempDir, `icon_${sz}.png`);
  if (fs.existsSync(pngPath)) {
    const buf = fs.readFileSync(pngPath);
    images.push({
      width: sz >= 256 ? 0 : sz,
      height: sz >= 256 ? 0 : sz,
      colors: 0,
      reserved: 0,
      planes: 1,
      bpp: 32,
      buffer: buf,
      size: buf.length
    });
  }
}

console.log(`Packing ${images.length} resolutions into ICO...`);

// 1. Header (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // Reserved
header.writeUInt16LE(1, 2); // Icon Type = 1
header.writeUInt16LE(images.length, 4); // Image Count

// 2. Directory Entries (16 bytes each)
const dirEntries = [];
let currentOffset = 6 + (images.length * 16);
const payloads = [];

for (const img of images) {
  const dir = Buffer.alloc(16);
  dir.writeUInt8(img.width, 0);
  dir.writeUInt8(img.height, 1);
  dir.writeUInt8(img.colors, 2);
  dir.writeUInt8(img.reserved, 3);
  dir.writeUInt16LE(img.planes, 4);
  dir.writeUInt16LE(img.bpp, 6);
  dir.writeUInt32LE(img.size, 8);
  dir.writeUInt32LE(currentOffset, 12);
  dirEntries.push(dir);

  payloads.push(img.buffer);
  currentOffset += img.size;
}

const icoBuffer = Buffer.concat([header, ...dirEntries, ...payloads]);

// Save to root and public
fs.writeFileSync(path.join(__dirname, 'tally_icon.ico'), icoBuffer);
fs.writeFileSync(path.join(__dirname, 'public', 'favicon.ico'), icoBuffer);
console.log(`Saved tally_icon.ico and public/favicon.ico (${icoBuffer.length} bytes) successfully!`);

// Clean up temp_icons
for (const sz of sizes) {
  const p = path.join(tempDir, `icon_${sz}.png`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
console.log('Cleaned up temporary icon files.');
