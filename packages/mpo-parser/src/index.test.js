import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseMPO, blobToDataURL } from './index.js'
import { SYNTHETIC_FIXTURES } from './fixtures/index.js'

const EXAMPLE_DIR = resolve(import.meta.dirname, '../../../examples')

/**
 * Read a Blob as an ArrayBuffer using FileReader.
 * jsdom's Blob.prototype.arrayBuffer is not implemented, so we use this helper.
 */
function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsArrayBuffer(blob)
  })
}

const EXAMPLE_FILES = [
  'example_1.MPO',
  'example_2.MPO',
  'example_3.MPO',
]

/**
 * Read a file relative to the example directory and return its ArrayBuffer.
 */
async function loadExample(filename) {
  const path = resolve(EXAMPLE_DIR, filename)
  const buffer = await readFile(path)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

/**
 * Check that a Uint8Array starts with the JPEG SOI marker (0xFFD8).
 */
function startsWithJpegSOI(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/**
 * Check that a Uint8Array ends with the JPEG EOI marker (0xFFD9).
 */
function endsWithJpegEOI(bytes) {
  return bytes.length >= 2 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
}

/**
 * Check that a Uint8Array contains at least one JPEG EOI marker (0xFFD9).
 * Used for the left image, which may have trailing padding after its EOI.
 */
function containsJpegEOI(bytes) {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      return true
    }
  }
  return false
}

describe('mpo-parser exports', () => {
  it('exports parseMPO', () => {
    expect(typeof parseMPO).toBe('function')
  })

  it('exports blobToDataURL', () => {
    expect(typeof blobToDataURL).toBe('function')
  })
})

describe('mpo-parser on real 3DS example files', () => {
  it.each(EXAMPLE_FILES)('parses %s into two JPEG blobs', async (filename) => {
    const buffer = await loadExample(filename)
    const { left, right } = parseMPO(buffer)

    expect(left).toBeInstanceOf(Blob)
    expect(right).toBeInstanceOf(Blob)
    expect(left.type).toBe('image/jpeg')
    expect(right.type).toBe('image/jpeg')
  })

  it.each(EXAMPLE_FILES)('returned blobs from %s are valid JPEGs', async (filename) => {
    const buffer = await loadExample(filename)
    const { left, right } = parseMPO(buffer)

    const leftBytes = new Uint8Array(await blobToArrayBuffer(left))
    const rightBytes = new Uint8Array(await blobToArrayBuffer(right))

    // Left image may include trailing padding after its EOI, so we only require
    // a valid JPEG structure somewhere inside the blob.
    expect(startsWithJpegSOI(leftBytes)).toBe(true)
    expect(containsJpegEOI(leftBytes)).toBe(true)

    // Right image should be a complete, self-contained JPEG.
    expect(startsWithJpegSOI(rightBytes)).toBe(true)
    expect(endsWithJpegEOI(rightBytes)).toBe(true)
  })

  it.each(EXAMPLE_FILES)('split point in %s lands cleanly between two JPEGs', async (filename) => {
    const buffer = await loadExample(filename)
    const { left, right } = parseMPO(buffer)

    const leftBytes = new Uint8Array(await blobToArrayBuffer(left))
    const rightBytes = new Uint8Array(await blobToArrayBuffer(right))

    // Left contains a complete JPEG; right starts cleanly with SOI.
    // The left blob may have trailing padding, which is allowed by the MPO spec.
    expect(startsWithJpegSOI(leftBytes)).toBe(true)
    expect(containsJpegEOI(leftBytes)).toBe(true)
    expect(startsWithJpegSOI(rightBytes)).toBe(true)

    // Both images should be non-trivially sized.
    expect(leftBytes.length).toBeGreaterThan(1000)
    expect(rightBytes.length).toBeGreaterThan(1000)
  })

  it.each(EXAMPLE_FILES)('left and right images from %s have identical dimensions', async (filename) => {
    const buffer = await loadExample(filename)
    const { left, right } = parseMPO(buffer)

    // Parse JPEG dimensions from the SOF0/SOF2 markers in each blob.
    const leftDims = readJpegDimensions(new Uint8Array(await blobToArrayBuffer(left)))
    const rightDims = readJpegDimensions(new Uint8Array(await blobToArrayBuffer(right)))

    expect(leftDims).toBeTruthy()
    expect(rightDims).toBeTruthy()
    expect(leftDims.width).toBe(rightDims.width)
    expect(leftDims.height).toBe(rightDims.height)
  })
})

describe('mpo-parser on synthetic fixtures', () => {
  it.each(SYNTHETIC_FIXTURES)(
    '$name — $description',
    async ({ name, shouldPass, generate }) => {
      const buffer = generate()

      if (!shouldPass) {
        expect(() => parseMPO(buffer)).toThrow()
        return
      }

      const { left, right } = parseMPO(buffer)

      expect(left).toBeInstanceOf(Blob)
      expect(right).toBeInstanceOf(Blob)
      expect(left.type).toBe('image/jpeg')
      expect(right.type).toBe('image/jpeg')

      const leftBytes = new Uint8Array(await blobToArrayBuffer(left))
      const rightBytes = new Uint8Array(await blobToArrayBuffer(right))

      expect(startsWithJpegSOI(leftBytes)).toBe(true)
      expect(containsJpegEOI(leftBytes)).toBe(true)

      expect(startsWithJpegSOI(rightBytes)).toBe(true)
      expect(endsWithJpegEOI(rightBytes)).toBe(true)

      const leftDims = readJpegDimensions(leftBytes)
      const rightDims = readJpegDimensions(rightBytes)
      expect(leftDims).toBeTruthy()
      expect(rightDims).toBeTruthy()
      expect(leftDims.width).toBe(rightDims.width)
      expect(leftDims.height).toBe(rightDims.height)
    }
  )
})

describe('blobToDataURL', () => {
  it('converts a JPEG Blob to a data URL', async () => {
    const buffer = await loadExample('example_1.MPO')
    const { left } = parseMPO(buffer)

    const dataUrl = await blobToDataURL(left)

    expect(typeof dataUrl).toBe('string')
    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})

/**
 * Read JPEG width/height from Start Of Frame markers (SOF0, SOF1, SOF2, SOF3,
 * SOF5, SOF6, SOF7, SOF9, SOF10, SOF11, SOF13, SOF14, SOF15).
 */
function readJpegDimensions(bytes) {
  let i = 2 // skip SOI
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }

    const marker = bytes[i + 1]

    // SOF markers that contain dimensions.
    if (
      marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
      marker === 0xc5 || marker === 0xc6 || marker === 0xc7 ||
      marker === 0xc9 || marker === 0xca || marker === 0xcb ||
      marker === 0xcd || marker === 0xce || marker === 0xcf
    ) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6]
      const width = (bytes[i + 7] << 8) | bytes[i + 8]
      return { width, height }
    }

    // Skip standalone markers.
    if (
      marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2
      continue
    }

    // Other markers have a length field.
    if (i + 3 >= bytes.length) break
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    i += 2 + length
  }

  return null
}
