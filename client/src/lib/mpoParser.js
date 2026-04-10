/**
 * Parses a Nintendo 3DS MPO (Multi-Picture Object) file and returns 
 * two JPEG Blobs representing the left and right eye images.
 *
 * MPO files are essentially multiple JPEGs concatenated together, with 
 * a special APP2 (MPF) marker in the first JPEG detailing the offsets 
 * and sizes of the subsequent images.
 *
 * @param {ArrayBuffer} buffer - Raw bytes of the .mpo file
 * @returns {{ left: Blob, right: Blob }}
 */
export function parseMPO(buffer) {
    const bytes = new Uint8Array(buffer)
    const view = new DataView(buffer)
  
    // Validate that the file starts with the standard JPEG Start Of Image (SOI) marker: FFD8
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error('Not a valid JPEG/MPO file. Missing FFD8 signature.')
    }
  
    // ── 1. PRIMARY METHOD: Parse the MPF APP2 marker ──
    const mpfData = extractMPFData(bytes, view)
  
    if (mpfData && mpfData.images.length >= 2) {
      const rightImage = mpfData.images[1]
      
      // In the MPF specification, data offsets are relative to the MP Endian field
      // (the byte order mark that immediately follows the "MPF\0" identifier).
      const absoluteOffset = mpfData.mpfStart + rightImage.dataOffset
  
      // Verify the calculated offset actually points to a JPEG start marker (FFD8)
      if (bytes[absoluteOffset] === 0xff && bytes[absoluteOffset + 1] === 0xd8) {
        console.log(`MPF Parsed Successfully! Split at offset: ${absoluteOffset}`)
        
        const leftBytes = bytes.slice(0, absoluteOffset)
        
        // Using the exact size from MPF prevents trailing garbage bytes or padding 
        // from being included in the final blob.
        const rightBytes = bytes.slice(absoluteOffset, absoluteOffset + rightImage.size)
        
        return {
          left: new Blob([leftBytes], { type: 'image/jpeg' }),
          right: new Blob([rightBytes], { type: 'image/jpeg' }),
        }
      } else {
        console.warn('MPF offset did not point to a valid JPEG marker. Falling back.')
      }
    } else {
      console.warn('MPF marker missing or unreadable. Falling back to intelligent scan.')
    }
  
    // ── 2. FALLBACK METHOD: Intelligent marker scan ──
    // If the MPF headers are stripped or corrupted, we leapfrog over the first 
    // image's metadata and look for the second FFD8 signature.
    const fallbackOffset = findSecondJpegRobustly(bytes, view)
  
    if (fallbackOffset === -1) {
      throw new Error('Could not find second JPEG in MPO file. Is this a valid 3DS MPO?')
    }
  
    console.log(`Fallback Successful! Split at offset: ${fallbackOffset}`)
    return {
      left: new Blob([bytes.slice(0, fallbackOffset)], { type: 'image/jpeg' }),
      right: new Blob([bytes.slice(fallbackOffset)], { type: 'image/jpeg' }),
    }
  }
  
  /**
   * Scans the first JPEG's headers for the APP2 (0xE2) MPF marker.
   * If found, it delegates to `parseMPFTiff` to read the image directory.
   */
  function extractMPFData(bytes, view) {
    let i = 2 // Start immediately after the FFD8 SOI marker
  
    while (i < bytes.length - 4) {
      if (bytes[i] !== 0xff) break // Lost sync with markers
  
      const marker = bytes[i + 1]
      const segmentLength = view.getUint16(i + 2, false)
  
      // Check for APP2 marker (0xE2)
      if (marker === 0xe2) {
        // Check for the specific "MPF\0" identifier string
        const isMPF =
          bytes[i + 4] === 0x4d && // 'M'
          bytes[i + 5] === 0x50 && // 'P'
          bytes[i + 6] === 0x46 && // 'F'
          bytes[i + 7] === 0x00    // '\0'
  
        if (isMPF) {
          const mpfStart = i + 8 // The start of the TIFF-like Endian field
          return parseMPFTiff(view, mpfStart)
        }
      }
  
      // 0xDA is Start Of Scan (SOS). If we hit the actual image data, 
      // the MPF metadata wasn't in the headers. We can stop searching.
      if (marker === 0xda) break
      
      // Jump to the next marker
      i += 2 + segmentLength
    }
  
    return null
  }
  
  /**
   * Parses the TIFF-like structure inside the MPF marker to extract
   * the sizes and relative offsets of all embedded images.
   */
  function parseMPFTiff(view, mpfStart) {
    try {
      // Read the Endianness (Byte Order Mark)
      const byteOrder = view.getUint16(mpfStart, false)
      const littleEndian = byteOrder === 0x4949 // 'II' for Intel (Little Endian)
  
      // Get the offset to the first Image File Directory (IFD)
      const ifdOffset = view.getUint32(mpfStart + 4, littleEndian)
      const ifdStart = mpfStart + ifdOffset
  
      const entryCount = view.getUint16(ifdStart, littleEndian)
      const images = []
  
      for (let e = 0; e < entryCount; e++) {
        const entryBase = ifdStart + 2 + e * 12
        const tag = view.getUint16(entryBase, littleEndian)
  
        // Tag 0xB002 is the "MP Entry" tag containing our image array
        if (tag === 0xb002) {
          const count = view.getUint32(entryBase + 4, littleEndian)
          const valueOffset = view.getUint32(entryBase + 8, littleEndian)
          const mpEntryBase = mpfStart + valueOffset
  
          const numImages = count / 16 // Each MP entry is exactly 16 bytes
  
          for (let imgIdx = 0; imgIdx < numImages; imgIdx++) {
            const imgBase = mpEntryBase + (imgIdx * 16)
            
            // The 16-byte MP Entry structure:
            // Bytes 0-3: Image Attributes
            // Bytes 4-7: Image Size
            // Bytes 8-11: Data Offset (relative to mpfStart)
            // Bytes 12-15: Dependent Image Entries
            
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
  
  /**
   * Fallback parser: Instead of blindly guessing an offset or getting tricked 
   * by EXIF thumbnails, we parse the JPEG block lengths to jump completely over 
   * the headers, then find the NEXT valid FFD8FF sequence.
   */
  function findSecondJpegRobustly(bytes, view) {
    let i = 2
    let inImageData = false
  
    while (i < bytes.length - 2) {
      if (bytes[i] === 0xff) {
        const marker = bytes[i + 1]
        
        // 0xDA is Start Of Scan (SOS). Once we hit this, we know we are past 
        // all EXIF data and thumbnails. We are safely inside the first image's pixels.
        if (marker === 0xda) {
          inImageData = true
          i += 2
          break 
        }
  
        // Some markers don't have a length payload. Skip them manually.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
  
        // Read segment length and leapfrog over it
        const length = view.getUint16(i + 2, false)
        i += 2 + length
      } else {
        i++
      }
    }
  
    if (!inImageData) return -1 // Reached EOF without finding image data
  
    // Now search for the next FFD8FF, which is guaranteed to be the second image
    for (let j = i; j < bytes.length - 2; j++) {
      if (bytes[j] === 0xff && bytes[j + 1] === 0xd8 && bytes[j + 2] === 0xff) {
        return j
      }
    }
  
    return -1
  }
  
  export async function blobToImageBitmap(blob) {
    return createImageBitmap(blob)
  }
  
  export function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }