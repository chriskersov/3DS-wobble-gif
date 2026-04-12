# MPO Parser — Design Reference

## What is an MPO File?

An MPO (Multi-Picture Object) file is a sequence of complete, valid JPEG files concatenated into a single binary. The Nintendo 3DS uses this format to store stereo image pairs: the left-eye image comes first, immediately followed by the right-eye image.

Rather than requiring the reader to blindly hunt for where one image ends and the next begins, the format uses the **MPF (Multi-Picture Format)** standard. MPF stores a metadata block inside the first JPEG that encodes the exact byte size and offset of every subsequent image. The parser reads this first, and only resorts to a fallback scan if the metadata is absent or unreadable.

---

## File Structure Overview

```
[ JPEG #1 (left eye) ][ JPEG #2 (right eye) ]
        ↑
   Contains APP2/MPF marker
   describing where JPEG #2 starts
```

---

## Parsing Strategy

### Primary Path — MPF APP2 Marker

The first JPEG's header chain is walked segment by segment, looking for an APP2 marker (`0xFFE2`) that carries the four-byte `MPF\0` identifier. This distinguishes the MPF segment from other APP2 uses such as ICC colour profiles or XMP metadata.

Inside the MPF segment is a TIFF-like block (it uses the same byte-order mark and IFD structure as Exif). The parser reads the IFD to find tag `0xB002` — the MP Entry array — which contains one 16-byte record per embedded image:

| Bytes | Field |
|-------|-------|
| 0–3 | Image Attributes |
| 4–7 | Image Size (bytes) |
| 8–11 | Data Offset (relative to MPF Endian field) |
| 12–15 | Dependent Image Entry numbers |

The data offset is **relative to the MP Endian field** (`mpfStart`) inside the file, not the absolute start of the file. This is why the code computes `absoluteOffset = mpfStart + dataOffset`. The first embedded image always has a data offset of zero; subsequent images carry their real position.

After computing the absolute offset, the parser verifies it points to a genuine JPEG SOI (`0xFFD8`) before trusting it. This guards against malformed MPF data silently producing garbage output.

The MPF-specified size is used for slicing the right image (rather than slicing to the end of the file) to exclude any inter-image padding or trailing bytes that some cameras append.

### Fallback Path — Intelligent Marker Scan

If the MPF segment is absent, stripped, or points somewhere invalid, the parser falls back to a two-phase scan.

**Phase 1 — Header walk:** The segment chain of the first JPEG is parsed using each segment's length field to advance the read cursor. This continues until the Start-of-Scan (`0xDA`) marker is reached, which marks the boundary between header blocks and entropy-coded pixel data. Parsing segment lengths — rather than scanning byte by byte — is what ensures EXIF-embedded thumbnails (which are also `0xFFD8`-prefixed) are jumped over cleanly rather than mistaken for the second image.

**Phase 2 — Stream scan:** Once safely inside the pixel data of the first image, the scanner looks for the three-byte sequence `0xFF 0xD8 0xFF`. The third byte (the start of the first marker after SOI) is included in the match to reduce the chance of a coincidental `0xFFD8` in the compressed bitstream being treated as a JPEG start.

---

## Constants

Named constants are used for all magic numbers (`JPEG_SOI_0/1`, `MARKER_APP2`, `MARKER_SOS`, `TAG_MP_ENTRY`, `MP_ENTRY_SIZE`, etc.) so that their meaning is self-documenting at every point of use and changes only need to be made in one place.

---

## Helper Functions

| Function | Purpose |
|---|---|
| `isJpegSOI(bytes, offset)` | Checks that two bytes at a given offset form `0xFFD8` |
| `hasMPFIdentifier(bytes, offset)` | Checks that four bytes match `MPF\0` |
| `isStandaloneMark(marker)` | Identifies markers that carry no length field (SOI, EOI, RST0–7, TEM) |
| `toBlobs(leftBytes, rightBytes)` | Wraps two byte arrays in `image/jpeg` Blobs |

These are extracted into named functions rather than inlined to keep the main parsing logic readable and to make individual behaviours independently testable.

---

## Blob Conversion Utilities

`blobToImageBitmap(blob)` and `blobToDataURL(blob)` are exported as standalone async helpers. They are intentionally separate from the parsing logic so that the core parser remains synchronous and environment-agnostic — it only depends on `ArrayBuffer`, `Uint8Array`, `DataView`, and `Blob`, all of which are available in both browser and Node.js environments.