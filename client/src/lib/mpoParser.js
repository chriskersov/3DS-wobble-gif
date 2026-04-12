/**
 * mpoParser.js
 *
 * Parses a Nintendo 3DS MPO (Multi-Picture Object) file and extracts the
 * two stereo JPEG images (left eye and right eye) as separate Blob objects.
 *
 * MPO files are multiple full JPEG files concatenated together. The first JPEG
 * contains a special APP2 marker using the MPF (Multi-Picture Format) standard,
 * which encodes the byte size and offset of every subsequent embedded image.
 * This parser reads that metadata first, then falls back to a robust marker scan
 * if the MPF headers are absent or corrupted.
 */

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Standard JPEG Start-of-Image marker bytes. */
const JPEG_SOI_0 = 0xff
const JPEG_SOI_1 = 0xd8

/** APP2 marker byte (second byte of the 0xFFE2 marker). */
const MARKER_APP2 = 0xe2

/** Start-of-Scan marker byte. Signals the beginning of entropy-coded pixel data. */
const MARKER_SOS = 0xda

/**
 * MPF identifier string ("MPF\0") stored as individual bytes.
 * This distinguishes an MPF-bearing APP2 segment from other APP2 uses (e.g. ICC profiles).
 */
const MPF_IDENTIFIER = [0x4d, 0x50, 0x46, 0x00] // 'M', 'P', 'F', '\0'

/**
 * TIFF little-endian byte-order mark ("II").
 * The MPF block uses a TIFF-like structure; "II" (0x4949) means little-endian,
 * "MM" (0x4d4d) means big-endian.
 */
const TIFF_LITTLE_ENDIAN = 0x4949

/**
 * IFD tag for the MP Entry array (0xB002).
 * Each 16-byte entry in this array describes one embedded image.
 */
const TAG_MP_ENTRY = 0xb002

/** Size in bytes of a single MP Entry record. */
const MP_ENTRY_SIZE = 16

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Parses a Nintendo 3DS MPO file and returns left and right JPEG Blobs.
 *
 * Strategy:
 *  1. Validate the file starts with a JPEG SOI marker (0xFFD8).
 *  2. Attempt to parse the MPF APP2 marker to get precise offsets and sizes.
 *  3. Verify the computed offset points to a real JPEG SOI before trusting it.
 *  4. If MPF parsing fails or yields an invalid offset, fall back to an
 *     intelligent marker scan that skips past the first image's header blocks
 *     before searching, avoiding false positives from embedded EXIF thumbnails.
 *
 * @param {ArrayBuffer} buffer - Raw bytes of the .mpo file.
 * @returns {{ left: Blob, right: Blob }} Left-eye and right-eye JPEG Blobs.
 * @throws {Error} If the buffer is not a valid JPEG/MPO or no second image is found.
 */
export function parseMPO(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  // Every valid JPEG — and therefore every valid MPO — must begin with 0xFFD8.
  // Failing here early prevents misleading errors deeper in the parse chain.
  if (bytes[0] !== JPEG_SOI_0 || bytes[1] !== JPEG_SOI_1) {
    throw new Error('Not a valid JPEG/MPO file. Missing 0xFFD8 SOI signature.')
  }

  // ── Primary path: MPF APP2 marker ──────────────────────────────────────────
  const mpfData = extractMPFData(bytes, view)

  if (mpfData && mpfData.images.length >= 2) {
    const rightImage = mpfData.images[1]

    // MPF data offsets are relative to the MP Endian field (mpfStart), not the
    // absolute start of the file. The first image always has a dataOffset of 0;
    // subsequent images carry their true byte position relative to mpfStart.
    const absoluteOffset = mpfData.mpfStart + rightImage.dataOffset

    // Double-check that the resolved offset actually lands on a JPEG SOI.
    // A mismatch here indicates either a malformed MPF or an unexpected variant.
    if (isJpegSOI(bytes, absoluteOffset)) {
      console.log(`MPF parsed successfully. Right image at byte offset: ${absoluteOffset}`)

      const leftBytes = bytes.slice(0, absoluteOffset)

      // Using the MPF-specified size (rather than slicing to the end of the file)
      // avoids including inter-image padding or trailing data in the right Blob.
      const rightBytes = bytes.slice(absoluteOffset, absoluteOffset + rightImage.size)

      return toBlobs(leftBytes, rightBytes)
    }

    console.warn(
      `MPF offset ${absoluteOffset} did not point to a JPEG SOI. Falling back to marker scan.`
    )
  } else {
    console.warn('MPF marker absent or unreadable. Falling back to marker scan.')
  }

  // ── Fallback path: intelligent marker scan ──────────────────────────────────
  // Walks the first JPEG's segment chain to jump cleanly past all header blocks
  // (including any EXIF-embedded thumbnails), then searches the raw pixel stream
  // for the next 0xFFD8FF sequence — the unambiguous start of the second JPEG.
  const fallbackOffset = findSecondJpegRobustly(bytes, view)

  if (fallbackOffset === -1) {
    throw new Error('Could not locate a second JPEG in this file. Is it a valid 3DS MPO?')
  }

  console.log(`Fallback scan succeeded. Right image at byte offset: ${fallbackOffset}`)

  return toBlobs(
    bytes.slice(0, fallbackOffset),
    bytes.slice(fallbackOffset)
  )
}

// ─────────────────────────────────────────────
// MPF Parsing
// ─────────────────────────────────────────────

/**
 * Walks the first JPEG's APP markers looking for the APP2 segment that carries
 * the MPF identifier. Stops at the SOS marker, since MPF will always appear
 * before pixel data begins.
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @returns {{ mpfStart: number, images: Array<{ size: number, dataOffset: number }> } | null}
 */
function extractMPFData(bytes, view) {
  // Offset 0–1 is the SOI marker; real segments begin at offset 2.
  let i = 2

  while (i < bytes.length - 4) {
    // All JPEG markers begin with 0xFF. Losing this sync means we have
    // slid into padding or corrupted data — stop scanning.
    if (bytes[i] !== 0xff) break

    const marker = bytes[i + 1]

    // Segment length is a big-endian uint16 stored at bytes i+2 and i+3,
    // and it includes the two length bytes themselves (but not the 0xFF marker byte).
    const segmentLength = view.getUint16(i + 2, false)

    if (marker === MARKER_APP2) {
      // APP2 segments are reused by multiple standards (ICC profiles, XMP, MPF, etc.).
      // Confirm this is an MPF segment by matching the 4-byte "MPF\0" identifier
      // that immediately follows the 0xFFE2 marker and the 2-byte length field.
      if (hasMPFIdentifier(bytes, i + 4)) {
        // mpfStart points to the Endian field — the byte-order mark that opens
        // the TIFF-like block. All data offsets inside MPF are relative to this position.
        const mpfStart = i + 8
        return parseMPFTiff(view, mpfStart)
      }
    }

    // 0xDA (SOS) marks the transition into compressed pixel data. MPF metadata
    // will always precede this point, so we can stop searching.
    if (marker === MARKER_SOS) break

    i += 2 + segmentLength
  }

  return null
}

/**
 * Parses the TIFF-like structure embedded inside the MPF APP2 segment.
 * Extracts image size and relative data offset for every embedded image.
 *
 * The MPF block mirrors the TIFF IFD structure:
 *   - 2 bytes: byte-order mark ("II" or "MM")
 *   - 2 bytes: always 0x002A (TIFF magic)
 *   - 4 bytes: offset to first IFD (relative to the byte-order mark)
 *
 * Each IFD entry is 12 bytes. We scan for tag 0xB002 (MP Entry), which
 * contains the array of per-image records.
 *
 * @param {DataView} view
 * @param {number} mpfStart - Byte offset of the MP Endian field within the file.
 * @returns {{ mpfStart: number, images: Array<{ size: number, dataOffset: number }> } | null}
 */
function parseMPFTiff(view, mpfStart) {
  try {
    const byteOrder = view.getUint16(mpfStart, false)
    const littleEndian = byteOrder === TIFF_LITTLE_ENDIAN

    // The IFD offset is relative to mpfStart, pointing past the 8-byte TIFF header.
    const ifdOffset = view.getUint32(mpfStart + 4, littleEndian)
    const ifdStart = mpfStart + ifdOffset

    const entryCount = view.getUint16(ifdStart, littleEndian)
    const images = []

    for (let e = 0; e < entryCount; e++) {
      // Each IFD entry is exactly 12 bytes: 2 tag + 2 type + 4 count + 4 value/offset.
      const entryBase = ifdStart + 2 + e * 12
      const tag = view.getUint16(entryBase, littleEndian)

      if (tag === TAG_MP_ENTRY) {
        // `count` is the total byte length of the MP Entry data array.
        // Dividing by MP_ENTRY_SIZE gives the number of embedded images.
        const count = view.getUint32(entryBase + 4, littleEndian)
        const valueOffset = view.getUint32(entryBase + 8, littleEndian)
        const mpEntryBase = mpfStart + valueOffset

        const numImages = Math.floor(count / MP_ENTRY_SIZE)

        for (let imgIdx = 0; imgIdx < numImages; imgIdx++) {
          const imgBase = mpEntryBase + imgIdx * MP_ENTRY_SIZE

          // 16-byte MP Entry layout:
          //   Bytes  0–3:  Image Attributes (representative flag, format, etc.)
          //   Bytes  4–7:  Image Size in bytes
          //   Bytes  8–11: Data Offset relative to mpfStart (0 for the first image)
          //   Bytes 12–15: Dependent Image Entry numbers (unused here)
          const size = view.getUint32(imgBase + 4, littleEndian)
          const dataOffset = view.getUint32(imgBase + 8, littleEndian)

          images.push({ size, dataOffset })
        }

        return { mpfStart, images }
      }
    }
  } catch (err) {
    console.warn('Error parsing MPF TIFF structure:', err)
  }

  return null
}

// ─────────────────────────────────────────────
// Fallback Scanner
// ─────────────────────────────────────────────

/**
 * Locates the byte offset of the second JPEG embedded in the MPO buffer
 * without relying on MPF metadata.
 *
 * Phase 1 — Header walk: Parses segment lengths to advance past the first
 * JPEG's marker chain until the SOS marker is found. This guarantees we skip
 * any EXIF-embedded thumbnails, which also begin with 0xFFD8 and would cause
 * a naive scan to return a false positive.
 *
 * Phase 2 — Stream scan: Searches the raw entropy-coded data stream for the
 * next 0xFFD8FF sequence. The 0xFF byte after SOI is the mandatory start of the
 * first APP or DQT marker in a valid JPEG, making this a reliable three-byte
 * signature rather than just two.
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @returns {number} Byte offset of the second JPEG, or -1 if not found.
 */
function findSecondJpegRobustly(bytes, view) {
  let i = 2
  let reachedImageData = false

  // Phase 1: walk segment chain until SOS.
  while (i < bytes.length - 2) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }

    const marker = bytes[i + 1]

    if (marker === MARKER_SOS) {
      reachedImageData = true
      i += 2
      break
    }

    // Certain marker types carry no length payload and must be skipped manually.
    // SOI (0xD8), EOI (0xD9), standalone markers (0x01), and RST0–RST7 (0xD0–0xD7).
    if (isStandaloneMark(marker)) {
      i += 2
      continue
    }

    const length = view.getUint16(i + 2, false)
    i += 2 + length
  }

  if (!reachedImageData) return -1

  // Phase 2: scan for the three-byte JPEG SOI + first-marker-byte signature.
  for (let j = i; j < bytes.length - 2; j++) {
    if (bytes[j] === 0xff && bytes[j + 1] === 0xd8 && bytes[j + 2] === 0xff) {
      return j
    }
  }

  return -1
}

// ─────────────────────────────────────────────
// Utility Helpers
// ─────────────────────────────────────────────

/**
 * Returns true if the two bytes at `offset` form a JPEG SOI marker (0xFFD8).
 * Used to validate MPF-computed offsets before trusting them.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {boolean}
 */
function isJpegSOI(bytes, offset) {
  return (
    offset >= 0 &&
    offset + 1 < bytes.length &&
    bytes[offset] === JPEG_SOI_0 &&
    bytes[offset + 1] === JPEG_SOI_1
  )
}

/**
 * Returns true if the four bytes at `offset` match the MPF identifier "MPF\0".
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {boolean}
 */
function hasMPFIdentifier(bytes, offset) {
  return MPF_IDENTIFIER.every((b, idx) => bytes[offset + idx] === b)
}

/**
 * Returns true for JPEG marker bytes that carry no length field.
 * These markers must be stepped over with a fixed 2-byte advance.
 *
 * Includes: SOI (0xD8), EOI (0xD9), TEM (0x01), RST0–RST7 (0xD0–0xD7).
 *
 * @param {number} marker - The second byte of a 0xFF-prefixed JPEG marker.
 * @returns {boolean}
 */
function isStandaloneMark(marker) {
  return (
    marker === 0xd8 ||
    marker === 0xd9 ||
    marker === 0x01 ||
    (marker >= 0xd0 && marker <= 0xd7)
  )
}

/**
 * Wraps two Uint8Array slices in JPEG Blobs and returns them as a named pair.
 *
 * @param {Uint8Array} leftBytes
 * @param {Uint8Array} rightBytes
 * @returns {{ left: Blob, right: Blob }}
 */
function toBlobs(leftBytes, rightBytes) {
  return {
    left: new Blob([leftBytes], { type: 'image/jpeg' }),
    right: new Blob([rightBytes], { type: 'image/jpeg' }),
  }
}

// ─────────────────────────────────────────────
// Blob Conversion Utilities
// ─────────────────────────────────────────────

/**
 * Converts a Blob to an ImageBitmap for rendering on a canvas.
 * Returns a Promise — await it before drawing.
 *
 * @param {Blob} blob
 * @returns {Promise<ImageBitmap>}
 */
export async function blobToImageBitmap(blob) {
  return createImageBitmap(blob)
}

/**
 * Converts a Blob to a base64-encoded data URL (e.g. for use in <img src>).
 * Returns a Promise — await it before assigning.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}