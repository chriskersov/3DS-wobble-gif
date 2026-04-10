# Parsing Nintendo 3DS MPO Files

## The Anatomy of an MPO File
An MPO (Multi-Picture Object) file is essentially two or more standard JPEG files glued together. However, instead of requiring a parser to blindly guess where one image ends and the next begins, the format utilizes the **MPF (Multi-Picture Format)** metadata standard.

The MPF data is stored inside an `APP2` (Application 2) marker in the header of the *first* JPEG file. By parsing this marker, we can map out the exact file sizes and byte offsets for every subsequent image attached to the file.

### Fixing the Offset vs. Size Bug
In previous iterations of the parser, a logic error occurred when extracting data from the 16-byte `MP Entry`. 

According to the MPF specification, each entry is structured as follows:
* **Bytes 0–3:** Image Attributes (e.g., representative image flag, format details).
* **Bytes 4–7:** Image Size (in bytes).
* **Bytes 8–11:** Data Offset.

The parser was mistakenly extracting the `Image Size` (bytes 4-7) and treating it as the `Data Offset` (bytes 8-11). Because the size of the image and the offset location are two entirely different numbers, the parser was jumping to arbitrary locations in the file, causing it to fall back to backup methods.

Furthermore, the specification dictates that the `Data Offset` is relative to the **MP Endian field** (the byte order mark following the `MPF\0` string), not the absolute start of the file. 

The updated logic accurately separates size and offset:
```javascript
const size = view.getUint32(imgBase + 4, littleEndian);
const dataOffset = view.getUint32(imgBase + 8, littleEndian);
const absoluteOffset = mpfStart + dataOffset;