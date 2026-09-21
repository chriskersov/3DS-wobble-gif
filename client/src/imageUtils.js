import { blobToDataURL } from 'mpo-parser'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

/**
 * Align a stereo pair by applying horizontal crop and vertical shift.
 *
 * - `hCrop`: symmetric horizontal crop. The left image loses `hCrop` pixels
 *   from its right edge; the right image loses `hCrop` pixels from its left
 *   edge. This corrects horizontal convergence errors.
 * - `vShift`: vertical shift applied to the right image. Positive values shift
 *   the right image up relative to the left; negative values shift it down.
 *   Both outputs are cropped to the overlapping region so they have identical
 *   dimensions.
 */
export async function alignImages(leftBlob, rightBlob, hCrop, vShift) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const srcWidth = left.width
  const srcHeight = left.height
  const destWidth = Math.max(1, srcWidth - hCrop)
  const overlapHeight = Math.max(1, srcHeight - Math.abs(vShift))

  const leftCanvas = new OffscreenCanvas(destWidth, overlapHeight)
  const rightCanvas = new OffscreenCanvas(destWidth, overlapHeight)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  // Horizontal crop: left keeps its left side, right keeps its right side.
  const leftSourceX = 0
  const rightSourceX = hCrop

  // Vertical crop depends on the direction of the shift.
  let leftSourceY = 0
  let rightSourceY = 0

  if (vShift > 0) {
    // Right image shifted up: discard `vShift` pixels from the top of the left
    // image and from the bottom of the right image.
    leftSourceY = vShift
  } else if (vShift < 0) {
    // Right image shifted down: discard `|vShift|` pixels from the bottom of
    // the left image and from the top of the right image.
    rightSourceY = -vShift
  }

  leftCtx.drawImage(
    left,
    leftSourceX,
    leftSourceY,
    destWidth,
    overlapHeight,
    0,
    0,
    destWidth,
    overlapHeight
  )
  rightCtx.drawImage(
    right,
    rightSourceX,
    rightSourceY,
    destWidth,
    overlapHeight,
    0,
    0,
    destWidth,
    overlapHeight
  )

  const [leftOut, rightOut] = await Promise.all([
    leftCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }),
    rightCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }),
  ])

  return { left: leftOut, right: rightOut }
}

/**
 * Compute a pixel-difference image and score between two blobs.
 * Returns { diffUrl, diffScore } where diffScore is the mean absolute
 * difference per pixel (0–255).
 */
export async function computeDiff(leftBlob, rightBlob) {
  const left = await createImageBitmap(leftBlob)
  const right = await createImageBitmap(rightBlob)

  const width = left.width
  const height = left.height

  const leftCanvas = new OffscreenCanvas(width, height)
  const rightCanvas = new OffscreenCanvas(width, height)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  leftCtx.drawImage(left, 0, 0)
  rightCtx.drawImage(right, 0, 0)

  const leftData = leftCtx.getImageData(0, 0, width, height).data
  const rightData = rightCtx.getImageData(0, 0, width, height).data

  const diffCanvas = new OffscreenCanvas(width, height)
  const diffCtx = diffCanvas.getContext('2d')
  const diffImage = diffCtx.createImageData(width, height)
  const diffData = diffImage.data

  let totalDiff = 0

  for (let i = 0; i < leftData.length; i += 4) {
    const dr = Math.abs(leftData[i] - rightData[i])
    const dg = Math.abs(leftData[i + 1] - rightData[i + 1])
    const db = Math.abs(leftData[i + 2] - rightData[i + 2])

    const diff = (dr + dg + db) / 3
    totalDiff += diff

    // Contrast boost x2, clamp to 255.
    const boosted = Math.min(diff * 2, 255)
    diffData[i] = boosted
    diffData[i + 1] = boosted
    diffData[i + 2] = boosted
    diffData[i + 3] = 255
  }

  diffCtx.putImageData(diffImage, 0, 0)

  const diffScore = totalDiff / (width * height)
  const diffBlob = await diffCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  const diffUrl = await blobToDataURL(diffBlob)

  return { diffUrl, diffScore }
}

/**
 * Draw two images on top of each other with 50% opacity and return the
 * result as a JPEG data URL. Useful for visually checking stereo alignment.
 */
export function createOverlayUrl(leftUrl, rightUrl) {
  return new Promise((resolve, reject) => {
    const leftImg = new Image()
    const rightImg = new Image()

    leftImg.onload = () => {
      rightImg.onload = () => {
        const width = Math.max(leftImg.width, rightImg.width)
        const height = Math.max(leftImg.height, rightImg.height)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')

        ctx.globalAlpha = 0.5
        ctx.drawImage(leftImg, 0, 0)
        ctx.drawImage(rightImg, 0, 0)

        resolve(canvas.toDataURL('image/jpeg', 0.9))
      }
      rightImg.onerror = reject
      rightImg.src = rightUrl
    }
    leftImg.onerror = reject
    leftImg.src = leftUrl
  })
}

/**
 * Generate a simple looping wobble GIF from an aligned stereo pair.
 * Returns an object URL for the generated GIF.
 */
export async function generateWobbleGif(leftBlob, rightBlob, delayMs = 300) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const width = left.width
  const height = left.height
  const encoder = GIFEncoder()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')

  const frames = [left, right]
  for (const frame of frames) {
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(frame, 0, 0)
    const { data } = ctx.getImageData(0, 0, width, height)
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    encoder.writeFrame(index, width, height, {
      palette,
      delay: delayMs,
    })
  }

  const bytes = encoder.bytes()
  const blob = new Blob([bytes], { type: 'image/gif' })
  return URL.createObjectURL(blob)
}

/**
 * Create a red-cyan anaglyph image from an aligned stereo pair.
 * The left eye supplies the red channel; the right eye supplies the green
 * and blue channels. Grayscale conversion is used for cleaner channel
 * separation when viewed with red-cyan glasses.
 *
 * Returns a Blob.
 */
export async function createAnaglyphBlob(leftBlob, rightBlob) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const width = left.width
  const height = left.height
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(left, 0, 0)
  const leftData = ctx.getImageData(0, 0, width, height).data

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(right, 0, 0)
  const rightData = ctx.getImageData(0, 0, width, height).data

  const outImage = ctx.createImageData(width, height)
  const outData = outImage.data

  for (let i = 0; i < leftData.length; i += 4) {
    const leftGray = Math.round((leftData[i] + leftData[i + 1] + leftData[i + 2]) / 3)
    const rightGray = Math.round((rightData[i] + rightData[i + 1] + rightData[i + 2]) / 3)

    outData[i] = leftGray // R
    outData[i + 1] = rightGray // G
    outData[i + 2] = rightGray // B
    outData[i + 3] = 255
  }

  ctx.putImageData(outImage, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

/**
 * Trigger a browser download for a Blob.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
