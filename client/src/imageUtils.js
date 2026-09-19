import { blobToDataURL } from 'mpo-parser'

/**
 * Crop a blob symmetrically for stereo alignment.
 * - side 'left': removes `cropPx` pixels from the right edge.
 * - side 'right': removes `cropPx` pixels from the left edge.
 */
export async function cropBlob(blob, cropPx, side) {
  const img = await createImageBitmap(blob)
  const srcWidth = img.width
  const srcHeight = img.height
  const destWidth = Math.max(1, srcWidth - cropPx)

  const canvas = new OffscreenCanvas(destWidth, srcHeight)
  const ctx = canvas.getContext('2d')

  if (side === 'left') {
    ctx.drawImage(img, 0, 0, destWidth, srcHeight, 0, 0, destWidth, srcHeight)
  } else {
    ctx.drawImage(img, cropPx, 0, destWidth, srcHeight, 0, 0, destWidth, srcHeight)
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
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
