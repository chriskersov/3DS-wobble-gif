/**
 * Synthetic MPO fixture generator.
 *
 * Generates artificial MPO files in memory for testing both parser paths
 * (MPF primary and fallback marker scan) and various edge cases.
 *
 * These fixtures are generated on-the-fly inside tests and in the browser UI,
 * so no binary files need to be committed.
 */

import jpegJS from 'jpeg-js'

// ─────────────────────────────────────────────
// Low-level helpers
// ─────────────────────────────────────────────

function concat(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function writeUint16BE(value) {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
}

function writeUint32LE(value) {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ])
}

function writeUint32BE(value) {
  return new Uint8Array([
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ])
}

function bufferToUint8Array(buf) {
  // jpeg-js returns a Node Buffer in Node and a Uint8Array-like object in browser.
  if (buf instanceof Uint8Array) return buf
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

// ─────────────────────────────────────────────
// JPEG creation
// ─────────────────────────────────────────────

/**
 * Create a JPEG image filled with an RGB colour.
 * Returns the raw JPEG bytes as a Uint8Array.
 */
export function createJpeg(width, height, [r, g, b]) {
  const frameData = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    frameData[i * 4] = r
    frameData[i * 4 + 1] = g
    frameData[i * 4 + 2] = b
    frameData[i * 4 + 3] = 255
  }

  // jpeg-js accepts a Uint8Array/Buffer of RGBA pixels. Normalise the
  // encoded output to a Uint8Array so the fixtures work in Node and browser.
  const encoded = jpegJS.encode({ data: frameData, width, height }, 90)
  return bufferToUint8Array(encoded.data)
}

/**
 * Create a larger JPEG with a coloured circle on a white background.
 * The circle is offset horizontally so left/right images are easy to
 * distinguish and produce a visible parallax shift when overlaid.
 */
export function createCircleJpeg(width, height, [r, g, b], cx, cy, radius) {
  const frameData = new Uint8Array(width * height * 4)

  // White background.
  for (let i = 0; i < width * height; i++) {
    frameData[i * 4] = 255
    frameData[i * 4 + 1] = 255
    frameData[i * 4 + 2] = 255
    frameData[i * 4 + 3] = 255
  }

  // Anti-aliased circle.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const alpha = 1 - Math.min(Math.max((dist - radius + 1) / 2, 0), 1)

      if (alpha > 0) {
        const idx = (y * width + x) * 4
        frameData[idx] = Math.round(255 * (1 - alpha) + r * alpha)
        frameData[idx + 1] = Math.round(255 * (1 - alpha) + g * alpha)
        frameData[idx + 2] = Math.round(255 * (1 - alpha) + b * alpha)
        frameData[idx + 3] = 255
      }
    }
  }

  const encoded = jpegJS.encode({ data: frameData, width, height }, 90)
  return bufferToUint8Array(encoded.data)
}

/** Default synthetic image size. Larger makes visual inspection easier. */
const SYNTHETIC_SIZE = 512

/** Helper to create the standard left-eye test image (red circle, left of centre). */
function createLeftImage() {
  return createCircleJpeg(
    SYNTHETIC_SIZE,
    SYNTHETIC_SIZE,
    [255, 0, 0],
    Math.round(SYNTHETIC_SIZE * 0.4),
    Math.round(SYNTHETIC_SIZE * 0.5),
    80
  )
}

/** Helper to create the standard right-eye test image (blue circle, right of centre). */
function createRightImage() {
  return createCircleJpeg(
    SYNTHETIC_SIZE,
    SYNTHETIC_SIZE,
    [0, 0, 255],
    Math.round(SYNTHETIC_SIZE * 0.6),
    Math.round(SYNTHETIC_SIZE * 0.5),
    80
  )
}

// ─────────────────────────────────────────────
// JPEG segment helpers
// ─────────────────────────────────────────────

function createSegment(marker, content) {
  const length = 2 + content.length
  return concat([
    new Uint8Array([0xff, marker]),
    writeUint16BE(length),
    content,
  ])
}

/**
 * Create an APP1 segment that contains an embedded EXIF thumbnail JPEG.
 * The fallback scanner must skip over this segment using its length field,
 * rather than mistaking the embedded thumbnail's 0xFFD8 for the second image.
 */
function createApp1WithThumbnail() {
  const thumbnail = createJpeg(2, 2, [255, 0, 0])
  const prefix = new TextEncoder().encode('Exif\0\0')
  const padding = new Uint8Array(16)
  const content = concat([prefix, padding, thumbnail])
  return createSegment(0xe1, content)
}

// ─────────────────────────────────────────────
// MPF APP2 segment builder
// ─────────────────────────────────────────────

/**
 * Build an APP2/MPF segment describing the provided images.
 *
 * @param {Array<{ size: number, dataOffset: number }>} images
 * @param {Object} options
 * @param {boolean} options.littleEndian
 * @returns {Uint8Array} The complete APP2 segment bytes.
 */
function createMpfApp2(images, { littleEndian = true } = {}) {
  // All multi-byte values inside the TIFF-like MPF structure use the byte
  // order declared by the byte-order mark. The APP2 marker/length themselves
  // remain big-endian, as required by JPEG.
  const u16 = littleEndian
    ? (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff])
    : (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff])
  const u32 = littleEndian ? writeUint32LE : writeUint32BE

  const byteOrderMark = littleEndian
    ? new Uint8Array([0x49, 0x49]) // "II"
    : new Uint8Array([0x4d, 0x4d]) // "MM"

  // MP Entry data: 16 bytes per image.
  const mpEntries = images.flatMap((img) => {
    const attrs = new Uint8Array(4)
    const attrValue = img.index === 0 ? 0x030000 : 0x000000
    u32(attrValue).forEach((b, i) => { attrs[i] = b })

    return [
      attrs,
      u32(img.size),
      u32(img.dataOffset),
      u16(0), // DependentImage1EntryNumber
      u16(0), // DependentImage2EntryNumber
    ]
  })

  const mpEntryData = concat(mpEntries)
  const mpEntryCount = mpEntryData.length

  // IFD layout:
  // 2 bytes count
  // 2 entries * 12 bytes
  // 4 bytes next IFD offset
  const ifdSize = 2 + 2 * 12 + 4
  const mpEntryOffset = 8 + ifdSize // relative to mpfStart

  const numberOfImagesEntry = concat([
    u16(0xb001),
    u16(4), // LONG
    u32(1),
    u32(images.length),
  ])

  const mpEntryTagEntry = concat([
    u16(0xb002),
    u16(7), // UNDEFINED
    u32(mpEntryCount),
    u32(mpEntryOffset),
  ])

  const ifd = concat([
    u16(2), // entry count
    numberOfImagesEntry,
    mpEntryTagEntry,
    u32(0), // next IFD offset
  ])

  const tiffHeader = concat([
    byteOrderMark,
    u16(0x002a), // TIFF magic
    u32(8), // offset to first IFD
  ])

  const mpfContent = concat([
    new TextEncoder().encode('MPF\0'),
    tiffHeader,
    ifd,
    mpEntryData,
  ])

  return createSegment(0xe2, mpfContent)
}

// ─────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────

/**
 * Build a minimal standalone JPEG from raw encoded JPEG bytes.
 * Adds a leading SOI and trailing EOI if missing (jpeg-js already provides these).
 */
function wrapJpeg(imageBytes) {
  return imageBytes
}

/**
 * Generate an MPO with a valid MPF APP2 segment describing both images.
 */
export function generateMpfValid() {
  const leftJpeg = wrapJpeg(createLeftImage())
  const rightJpeg = wrapJpeg(createRightImage())

  const leftImage = concat([
    new Uint8Array([0xff, 0xd8]), // SOI
    createMpfApp2([
      { index: 0, size: 0, dataOffset: 0 }, // placeholders, filled below
      { index: 1, size: 0, dataOffset: 0 },
    ]),
    leftJpeg.slice(2), // remove SOI since we already added it
  ])

  const secondOffset = leftImage.length
  const mpfStart = 10 // SOI (2) + APP2 marker/length (4) + MPF\0 (4)

  const images = [
    { index: 0, size: leftImage.length, dataOffset: 0 },
    { index: 1, size: rightJpeg.length, dataOffset: secondOffset - mpfStart },
  ]

  // Rebuild left image with correct MPF data.
  const leftImageWithMpf = concat([
    new Uint8Array([0xff, 0xd8]),
    createMpfApp2(images),
    leftJpeg.slice(2),
  ])

  return concat([leftImageWithMpf, rightJpeg]).buffer
}

/**
 * Generate an MPO with two JPEGs concatenated and no MPF segment.
 * Forces the parser to use the fallback marker scan.
 */
export function generateNoMpf() {
  const leftJpeg = createLeftImage()
  const rightJpeg = createRightImage()
  return concat([leftJpeg, rightJpeg]).buffer
}

/**
 * Generate an MPO where the first JPEG has an APP1 segment containing an
 * embedded EXIF thumbnail. The fallback scanner must not mistake the thumbnail
 * for the second image.
 */
export function generateExifThumbnail() {
  const leftJpeg = concat([
    new Uint8Array([0xff, 0xd8]),
    createApp1WithThumbnail(),
    createLeftImage().slice(2),
  ])
  const rightJpeg = createRightImage()
  return concat([leftJpeg, rightJpeg]).buffer
}

/**
 * Generate an MPO with a valid MPF segment but padding between the two images.
 */
export function generatePaddedBetween() {
  const leftJpeg = createLeftImage()
  const rightJpeg = createRightImage()

  const padding = new Uint8Array(64).fill(0)
  const mpfStart = 10

  // Build a placeholder first image to determine its final byte length.
  const placeholderLeft = concat([
    new Uint8Array([0xff, 0xd8]),
    createMpfApp2([
      { index: 0, size: 0, dataOffset: 0 },
      { index: 1, size: 0, dataOffset: 0 },
    ]),
    leftJpeg.slice(2),
  ])

  const secondOffset = placeholderLeft.length + padding.length

  const images = [
    { index: 0, size: placeholderLeft.length, dataOffset: 0 },
    { index: 1, size: rightJpeg.length, dataOffset: secondOffset - mpfStart },
  ]

  const leftImageWithMpf = concat([
    new Uint8Array([0xff, 0xd8]),
    createMpfApp2(images),
    leftJpeg.slice(2),
  ])

  return concat([leftImageWithMpf, padding, rightJpeg]).buffer
}

/**
 * Generate an MPO with a big-endian MPF APP2 segment.
 */
export function generateBigEndianMpf() {
  const leftJpeg = createLeftImage()
  const rightJpeg = createRightImage()

  const mpfStart = 10

  // Build a placeholder first image to determine its final byte length.
  const placeholderLeft = concat([
    new Uint8Array([0xff, 0xd8]),
    createMpfApp2([
      { index: 0, size: 0, dataOffset: 0 },
      { index: 1, size: 0, dataOffset: 0 },
    ], { littleEndian: false }),
    leftJpeg.slice(2),
  ])

  const secondOffset = placeholderLeft.length

  const images = [
    { index: 0, size: placeholderLeft.length, dataOffset: 0 },
    { index: 1, size: rightJpeg.length, dataOffset: secondOffset - mpfStart },
  ]

  const leftImageWithMpf = concat([
    new Uint8Array([0xff, 0xd8]),
    createMpfApp2(images, { littleEndian: false }),
    leftJpeg.slice(2),
  ])

  return concat([leftImageWithMpf, rightJpeg]).buffer
}

/**
 * Generate a plain single JPEG (not an MPO).
 */
export function generateSingleJpeg() {
  return createCircleJpeg(
    SYNTHETIC_SIZE,
    SYNTHETIC_SIZE,
    [0, 255, 0],
    Math.round(SYNTHETIC_SIZE * 0.5),
    Math.round(SYNTHETIC_SIZE * 0.5),
    80
  ).buffer
}

/**
 * Generate random bytes (not a JPEG).
 */
export function generateRandomBytes() {
  const bytes = new Uint8Array(128)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes.buffer
}

/**
 * Generate an MPO where the second image is truncated mid-stream.
 */
export function generateTruncated() {
  const leftJpeg = createLeftImage()
  const rightJpeg = createRightImage()
  const truncatedRight = rightJpeg.slice(0, Math.floor(rightJpeg.length / 2))
  return concat([leftJpeg, truncatedRight]).buffer
}

// ─────────────────────────────────────────────
// Fixture registry
// ─────────────────────────────────────────────

export const SYNTHETIC_FIXTURES = [
  {
    name: 'mpf-valid',
    description: 'Two JPEGs with a valid MPF APP2 header (primary path)',
    shouldPass: true,
    generate: generateMpfValid,
  },
  {
    name: 'no-mpf',
    description: 'Two JPEGs concatenated without MPF (fallback path)',
    shouldPass: true,
    generate: generateNoMpf,
  },
  {
    name: 'exif-thumbnail',
    description: 'First JPEG contains an EXIF thumbnail that must not be mistaken for the second image',
    shouldPass: true,
    generate: generateExifThumbnail,
  },
  {
    name: 'padded-between',
    description: 'Valid MPF with padding bytes between the two images',
    shouldPass: true,
    generate: generatePaddedBetween,
  },
  {
    name: 'big-endian-mpf',
    description: 'MPF APP2 segment uses big-endian byte order',
    shouldPass: true,
    generate: generateBigEndianMpf,
  },
  {
    name: 'single-jpeg',
    description: 'Plain single JPEG, not an MPO',
    shouldPass: false,
    generate: generateSingleJpeg,
  },
  {
    name: 'random-bytes',
    description: 'Random bytes, not a JPEG',
    shouldPass: false,
    generate: generateRandomBytes,
  },
  {
    name: 'truncated',
    description: 'Second image is truncated mid-stream',
    shouldPass: false,
    generate: generateTruncated,
  },
]
