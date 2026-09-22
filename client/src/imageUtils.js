import { blobToDataURL } from 'mpo-parser'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

/**
 * Align a stereo pair by shifting the right image relative to the left and
 * cropping to the overlapping region.
 *
 * - `hShift`: horizontal shift. Positive values shift the right image left
 *   (convergence); negative values shift it right. The overlap width is
 *   `srcWidth - abs(hShift)`.
 * - `vShift`: vertical shift. Positive values shift the right image up;
 *   negative values shift it down. The overlap height is
 *   `srcHeight - abs(vShift)`.
 *
 * Both outputs are cropped to the overlapping region so they have identical
 * dimensions.
 */
export async function alignImages(leftBlob, rightBlob, hShift, vShift) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const srcWidth = left.width
  const srcHeight = left.height
  const hCrop = Math.abs(hShift)
  const vCrop = Math.abs(vShift)

  const destWidth = Math.max(1, Math.round(srcWidth - hCrop))
  const overlapHeight = Math.max(1, Math.round(srcHeight - vCrop))

  const leftCanvas = new OffscreenCanvas(destWidth, overlapHeight)
  const rightCanvas = new OffscreenCanvas(destWidth, overlapHeight)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  // Horizontal: sign decides which image keeps the left vs right edge.
  let leftSourceX = 0
  let rightSourceX = 0

  if (hShift > 0) {
    // Right image shifted left: keep the left of the left and the right of the right.
    rightSourceX = hCrop
  } else if (hShift < 0) {
    // Right image shifted right: keep the right of the left and the left of the right.
    leftSourceX = hCrop
  }

  // Vertical: sign decides which image loses the top vs bottom pixels.
  let leftSourceY = 0
  let rightSourceY = 0

  if (vShift > 0) {
    // Right image shifted up: keep the top of the left and the bottom of the right.
    rightSourceY = vCrop
  } else if (vShift < 0) {
    // Right image shifted down: keep the bottom of the left and the top of the right.
    leftSourceY = vCrop
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
 * Compute only the diff score between two blobs, without generating the
 * diff image. Useful for batch comparisons (e.g. the diff graph).
 */
export async function computeDiffScore(leftBlob, rightBlob) {
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

  let totalDiff = 0

  for (let i = 0; i < leftData.length; i += 4) {
    const dr = Math.abs(leftData[i] - rightData[i])
    const dg = Math.abs(leftData[i + 1] - rightData[i + 1])
    const db = Math.abs(leftData[i + 2] - rightData[i + 2])
    totalDiff += (dr + dg + db) / 3
  }

  return totalDiff / (width * height)
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
 * Generate a looping wobble GIF from an aligned stereo pair.
 *
 * Options:
 * - delayMs: hold delay in milliseconds for left/right frames (default 300)
 * - transitionDelayMs: delay per crossfade frame in milliseconds (default 100)
 * - cycles: number of full left→right→left cycles (default 1)
 * - crossfadeSteps: number of blended intermediate frames per transition
 *                   (default 0 = hard cut)
 * - scale: output scale relative to the aligned input (default 1.0)
 * - loop: whether the GIF loops forever (default true)
 *
 * Returns an object URL for the generated GIF.
 */
export async function generateWobbleGif(leftBlob, rightBlob, options = {}) {
  const {
    delayMs = 300,
    transitionDelayMs = 100,
    cycles = 1,
    crossfadeSteps = 0,
    scale = 1.0,
    loop = true,
  } = options

  let [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  let width = left.width
  let height = left.height

  if (scale > 0 && scale !== 1.0) {
    width = Math.max(1, Math.round(width * scale))
    height = Math.max(1, Math.round(height * scale))
    const scaledLeftCanvas = new OffscreenCanvas(width, height)
    const scaledRightCanvas = new OffscreenCanvas(width, height)
    const slCtx = scaledLeftCanvas.getContext('2d')
    const srCtx = scaledRightCanvas.getContext('2d')
    slCtx.drawImage(left, 0, 0, width, height)
    srCtx.drawImage(right, 0, 0, width, height)
    left = await createImageBitmap(scaledLeftCanvas)
    right = await createImageBitmap(scaledRightCanvas)
  }

  const encoder = GIFEncoder()
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')

  function writeFrame(imageBitmap, delay, repeat = 0) {
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(imageBitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, width, height)
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    encoder.writeFrame(index, width, height, { palette, delay, repeat })
  }

  function crossfade(from, to, steps) {
    const frames = []
    for (let i = 1; i <= steps; i++) {
      const alpha = i / (steps + 1)
      const fadeCanvas = new OffscreenCanvas(width, height)
      const fadeCtx = fadeCanvas.getContext('2d')
      fadeCtx.drawImage(from, 0, 0)
      fadeCtx.globalAlpha = alpha
      fadeCtx.drawImage(to, 0, 0)
      frames.push(fadeCanvas.transferToImageBitmap())
    }
    return frames
  }

  const fadeDelay = crossfadeSteps > 0 ? Math.max(20, transitionDelayMs) : delayMs

  for (let c = 0; c < cycles; c++) {
    writeFrame(left, delayMs, c === 0 ? (loop ? 0 : -1) : undefined)

    if (crossfadeSteps > 0) {
      const fadeFrames = crossfade(left, right, crossfadeSteps)
      for (const frame of fadeFrames) {
        writeFrame(frame, fadeDelay)
      }
    }

    writeFrame(right, delayMs)

    if (crossfadeSteps > 0) {
      const fadeFrames = crossfade(right, left, crossfadeSteps)
      for (const frame of fadeFrames) {
        writeFrame(frame, fadeDelay)
      }
    }
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
 * Compute a diff score only within the intersection of two subject boxes
 * after aligning the images with the given shift.
 *
 * `leftBox` and `rightBox` are in original image coordinates:
 * { x, y, width, height }
 *
 * Returns { diffScore, pixelCount }.
 */
export async function computeDiffScoreInBoxes(
  leftBlob,
  rightBlob,
  hShift,
  vShift,
  leftBox,
  rightBox
) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const srcWidth = left.width
  const srcHeight = left.height
  const hCrop = Math.abs(hShift)
  const vCrop = Math.abs(vShift)
  const overlapWidth = Math.max(1, Math.round(srcWidth - hCrop))
  const overlapHeight = Math.max(1, Math.round(srcHeight - vCrop))

  // Same source-offset logic as alignImages.
  let leftSourceX = 0
  let rightSourceX = 0
  let leftSourceY = 0
  let rightSourceY = 0

  if (hShift > 0) rightSourceX = hCrop
  else if (hShift < 0) leftSourceX = hCrop
  if (vShift > 0) rightSourceY = vCrop
  else if (vShift < 0) leftSourceY = vCrop

  // Map each subject box into the aligned overlap coordinate space.
  const leftOverlapBox = {
    x: leftBox.x - leftSourceX,
    y: leftBox.y - leftSourceY,
    width: leftBox.width,
    height: leftBox.height,
  }
  const rightOverlapBox = {
    x: rightBox.x - rightSourceX,
    y: rightBox.y - rightSourceY,
    width: rightBox.width,
    height: rightBox.height,
  }

  // Intersection = region where both subjects are present in the overlap.
  const x1 = Math.round(
    Math.max(0, Math.max(leftOverlapBox.x, rightOverlapBox.x))
  )
  const y1 = Math.round(
    Math.max(0, Math.max(leftOverlapBox.y, rightOverlapBox.y))
  )
  const x2 = Math.round(
    Math.min(overlapWidth, Math.min(leftOverlapBox.x + leftOverlapBox.width, rightOverlapBox.x + rightOverlapBox.width))
  )
  const y2 = Math.round(
    Math.min(overlapHeight, Math.min(leftOverlapBox.y + leftOverlapBox.height, rightOverlapBox.y + rightOverlapBox.height))
  )

  const boxWidth = Math.max(0, Math.round(x2 - x1))
  const boxHeight = Math.max(0, Math.round(y2 - y1))

  if (boxWidth === 0 || boxHeight === 0 || !Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) {
    return { diffScore: 0, pixelCount: 0 }
  }

  const leftCanvas = new OffscreenCanvas(overlapWidth, overlapHeight)
  const rightCanvas = new OffscreenCanvas(overlapWidth, overlapHeight)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  leftCtx.drawImage(left, leftSourceX, leftSourceY, overlapWidth, overlapHeight, 0, 0, overlapWidth, overlapHeight)
  rightCtx.drawImage(right, rightSourceX, rightSourceY, overlapWidth, overlapHeight, 0, 0, overlapWidth, overlapHeight)

  const leftData = leftCtx.getImageData(x1, y1, boxWidth, boxHeight).data
  const rightData = rightCtx.getImageData(x1, y1, boxWidth, boxHeight).data

  let totalDiff = 0
  for (let i = 0; i < leftData.length; i += 4) {
    const dr = Math.abs(leftData[i] - rightData[i])
    const dg = Math.abs(leftData[i + 1] - rightData[i + 1])
    const db = Math.abs(leftData[i + 2] - rightData[i + 2])
    totalDiff += (dr + dg + db) / 3
  }

  return { diffScore: totalDiff / (boxWidth * boxHeight), pixelCount: boxWidth * boxHeight }
}

/**
 * Compute a diff score weighted by the overlap of two subject masks.
 *
 * For each pixel in the aligned overlap, the diff is weighted by how much
 * both masks agree it belongs to the subject. This makes the score focus on
 * aligning the subject rather than the background.
 *
 * `leftMask` and `rightMask` are Float32Arrays of length width*height with
 * values in [0, 1].
 */
export async function computeDiffScoreWithMasks(
  leftBlob,
  rightBlob,
  hShift,
  vShift,
  leftMask,
  rightMask
) {
  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const srcWidth = left.width
  const srcHeight = left.height

  if (!Number.isFinite(hShift) || !Number.isFinite(vShift)) {
    throw new Error(
      `Invalid shift values for mask-weighted diff: hShift=${hShift}, vShift=${vShift}`
    )
  }

  const hShiftInt = Math.round(hShift)
  const vShiftInt = Math.round(vShift)
  const hCrop = Math.abs(hShiftInt)
  const vCrop = Math.abs(vShiftInt)
  const overlapWidth = Math.max(1, Math.round(srcWidth - hCrop))
  const overlapHeight = Math.max(1, Math.round(srcHeight - vCrop))

  let leftSourceX = 0
  let rightSourceX = 0
  let leftSourceY = 0
  let rightSourceY = 0

  if (hShiftInt > 0) rightSourceX = hCrop
  else if (hShiftInt < 0) leftSourceX = hCrop
  if (vShiftInt > 0) rightSourceY = vCrop
  else if (vShiftInt < 0) leftSourceY = vCrop

  if (
    !Number.isFinite(overlapWidth) ||
    !Number.isFinite(overlapHeight) ||
    overlapWidth <= 0 ||
    overlapHeight <= 0
  ) {
    throw new Error(
      `Invalid overlap dimensions: ${overlapWidth}x${overlapHeight} (src=${srcWidth}x${srcHeight}, shift=${hShiftInt},${vShiftInt})`
    )
  }

  const leftCanvas = new OffscreenCanvas(overlapWidth, overlapHeight)
  const rightCanvas = new OffscreenCanvas(overlapWidth, overlapHeight)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  leftCtx.drawImage(left, leftSourceX, leftSourceY, overlapWidth, overlapHeight, 0, 0, overlapWidth, overlapHeight)
  rightCtx.drawImage(right, rightSourceX, rightSourceY, overlapWidth, overlapHeight, 0, 0, overlapWidth, overlapHeight)

  const leftData = leftCtx.getImageData(0, 0, overlapWidth, overlapHeight).data
  const rightData = rightCtx.getImageData(0, 0, overlapWidth, overlapHeight).data

  let weightedDiff = 0
  let totalWeight = 0

  for (let y = 0; y < overlapHeight; y++) {
    for (let x = 0; x < overlapWidth; x++) {
      const leftMaskX = x + leftSourceX
      const leftMaskY = y + leftSourceY
      const rightMaskX = x + rightSourceX
      const rightMaskY = y + rightSourceY

      if (
        leftMaskX < 0 || leftMaskX >= srcWidth ||
        leftMaskY < 0 || leftMaskY >= srcHeight ||
        rightMaskX < 0 || rightMaskX >= srcWidth ||
        rightMaskY < 0 || rightMaskY >= srcHeight
      ) {
        continue
      }

      const leftMaskValue = leftMask[leftMaskY * srcWidth + leftMaskX]
      const rightMaskValue = rightMask[rightMaskY * srcWidth + rightMaskX]
      const weight = Math.min(leftMaskValue, rightMaskValue)

      if (weight <= 0) continue

      const idx = (y * overlapWidth + x) * 4
      const dr = Math.abs(leftData[idx] - rightData[idx])
      const dg = Math.abs(leftData[idx + 1] - rightData[idx + 1])
      const db = Math.abs(leftData[idx + 2] - rightData[idx + 2])
      const diff = (dr + dg + db) / 3

      weightedDiff += diff * weight
      totalWeight += weight
    }
  }

  if (totalWeight === 0) {
    return { diffScore: 0, pixelCount: 0 }
  }

  return { diffScore: weightedDiff / totalWeight, pixelCount: Math.round(totalWeight) }
}

/**
 * Locate the subject from the left image inside the right image using
 * normalized cross-correlation (NCC) template matching.
 *
 * Returns the pixel offset `{ dx, dy }` such that shifting the right image by
 * `(dx, dy)` aligns the matched subject with the left subject, plus a
 * `confidence` value in [-1, 1].
 */
export async function findSubjectOffset(leftBlob, rightBlob, leftBox, options = {}) {
  const targetWidth = options.targetWidth ?? 320
  const hSearchRange = options.hSearchRange ?? 80
  const vSearchRange = options.vSearchRange ?? 40
  const boxPadding = options.boxPadding ?? 0.1
  const minConfidence = options.minConfidence ?? 0.3

  const [left, right] = await Promise.all([
    createImageBitmap(leftBlob),
    createImageBitmap(rightBlob),
  ])

  const srcW = left.width
  const srcH = left.height

  if (right.width !== srcW || right.height !== srcH) {
    throw new Error('Left and right images must have the same dimensions for template matching.')
  }

  const scale = Math.min(1, targetWidth / srcW)
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))

  const leftCanvas = new OffscreenCanvas(w, h)
  const rightCanvas = new OffscreenCanvas(w, h)
  const leftCtx = leftCanvas.getContext('2d')
  const rightCtx = rightCanvas.getContext('2d')

  leftCtx.drawImage(left, 0, 0, w, h)
  rightCtx.drawImage(right, 0, 0, w, h)

  const leftData = leftCtx.getImageData(0, 0, w, h).data
  const rightData = rightCtx.getImageData(0, 0, w, h).data

  // Grayscale
  const leftGray = new Float32Array(w * h)
  const rightGray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4
    const lum = 0.299 * leftData[idx] + 0.587 * leftData[idx + 1] + 0.114 * leftData[idx + 2]
    leftGray[i] = lum
    const rum = 0.299 * rightData[idx] + 0.587 * rightData[idx + 1] + 0.114 * rightData[idx + 2]
    rightGray[i] = rum
  }

  // Scale box and add padding
  const padX = Math.round(leftBox.width * boxPadding * scale)
  const padY = Math.round(leftBox.height * boxPadding * scale)
  let tx = Math.round(leftBox.x * scale) - padX
  let ty = Math.round(leftBox.y * scale) - padY
  let tw = Math.round(leftBox.width * scale) + padX * 2
  let th = Math.round(leftBox.height * scale) + padY * 2

  tx = Math.max(0, tx)
  ty = Math.max(0, ty)
  tw = Math.max(1, Math.min(tw, w - tx))
  th = Math.max(1, Math.min(th, h - ty))

  if (tw < 8 || th < 8) {
    throw new Error('Subject template is too small for matching.')
  }

  // Extract template
  const template = new Float32Array(tw * th)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      template[y * tw + x] = leftGray[(ty + y) * w + (tx + x)]
    }
  }

  const area = tw * th

  // Template stats
  let tMean = 0
  for (let i = 0; i < area; i++) tMean += template[i]
  tMean /= area

  let tVar = 0
  for (let i = 0; i < area; i++) {
    const d = template[i] - tMean
    tVar += d * d
  }

  if (tVar === 0) {
    throw new Error('Subject template has no variation.')
  }

  // Integral images for right image mean and variance
  const stride = w + 1
  const integral = new Float32Array(stride * (h + 1))
  const integralSq = new Float32Array(stride * (h + 1))

  for (let y = 1; y <= h; y++) {
    let rowSum = 0
    let rowSumSq = 0
    for (let x = 1; x <= w; x++) {
      const val = rightGray[(y - 1) * w + (x - 1)]
      rowSum += val
      rowSumSq += val * val
      const i = y * stride + x
      integral[i] = integral[(y - 1) * stride + x] + rowSum
      integralSq[i] = integralSq[(y - 1) * stride + x] + rowSumSq
    }
  }

  function windowSum(intg, x, y) {
    const x2 = x + tw
    const y2 = y + th
    return (
      intg[y2 * stride + x2] -
      intg[y * stride + x2] -
      intg[y2 * stride + x] +
      intg[y * stride + x]
    )
  }

  // Search window
  const hRange = Math.max(0, Math.round(hSearchRange * scale))
  const vRange = Math.max(0, Math.round(vSearchRange * scale))

  const minSx = Math.max(0, tx - hRange)
  const maxSx = Math.min(w - tw, tx + hRange)
  const minSy = Math.max(0, ty - vRange)
  const maxSy = Math.min(h - th, ty + vRange)

  let bestNcc = -Infinity
  let bestDx = 0
  let bestDy = 0

  for (let sy = minSy; sy <= maxSy; sy++) {
    for (let sx = minSx; sx <= maxSx; sx++) {
      const wSum = windowSum(integral, sx, sy)
      const wSumSq = windowSum(integralSq, sx, sy)
      const wVar = wSumSq - (wSum * wSum) / area

      if (wVar <= 0) continue

      let dot = 0
      for (let y = 0; y < th; y++) {
        const tRow = y * tw
        const rRowBase = (sy + y) * w + sx
        for (let x = 0; x < tw; x++) {
          dot += template[tRow + x] * rightGray[rRowBase + x]
        }
      }

      const num = dot - tMean * wSum
      const ncc = num / Math.sqrt(tVar * wVar)

      if (ncc > bestNcc) {
        bestNcc = ncc
        bestDx = sx - tx
        bestDy = sy - ty
      }
    }
  }

  if (bestNcc === -Infinity) {
    throw new Error('Template matching failed to find the subject in the right image.')
  }

  if (bestNcc < minConfidence) {
    throw new Error(
      `Subject match confidence too low (${bestNcc.toFixed(2)}). Try manual alignment or a different image.`
    )
  }

  return {
    dx: Math.round(bestDx / scale),
    dy: Math.round(bestDy / scale),
    confidence: bestNcc,
  }
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

/**
 * Return the natural dimensions of a Blob as { width, height }.
 */
export async function getImageDimensions(blob) {
  const bitmap = await createImageBitmap(blob)
  return { width: bitmap.width, height: bitmap.height }
}
