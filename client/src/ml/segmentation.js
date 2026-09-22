import * as ort from 'onnxruntime-web'

const MODEL_URL = 'https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx'
const MODEL_INPUT_SIZE = 320

// ImageNet normalization constants used by u2netp.
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

// Load ONNX Runtime WASM from jsDelivr so it is not bundled.
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/'

let sessionPromise = null

function downloadArrayBuffer(url, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('GET', url, true)
    request.responseType = 'arraybuffer'
    request.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress((e.loaded / e.total) * 100)
      }
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response)
      } else {
        reject(new Error(`Failed to download ${url}: ${request.statusText}`))
      }
    }
    request.onerror = () => reject(new Error(`Network error downloading ${url}`))
    request.send()
  })
}

/**
 * Lazy-load the u2netp ONNX session.
 */
export async function loadSegmentor(onProgress) {
  if (sessionPromise) return sessionPromise

  sessionPromise = (async () => {
    const buffer = await downloadArrayBuffer(MODEL_URL, (p) =>
      onProgress?.({ text: 'Loading u2netp model', progress: p })
    )
    return ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] })
  })()

  return sessionPromise
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}

/**
 * Preprocess an image for u2netp: resize to 320x320, convert RGBA to RGB,
 * normalize with ImageNet mean/std, and arrange as NCHW.
 */
function preprocessImage(image) {
  const canvas = document.createElement('canvas')
  canvas.width = MODEL_INPUT_SIZE
  canvas.height = MODEL_INPUT_SIZE
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)

  const imageData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data
  const input = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE)
  const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE

  for (let i = 0; i < pixelCount; i++) {
    const r = imageData[i * 4] / 255.0
    const g = imageData[i * 4 + 1] / 255.0
    const b = imageData[i * 4 + 2] / 255.0

    input[i] = (r - MEAN[0]) / STD[0]
    input[i + pixelCount] = (g - MEAN[1]) / STD[1]
    input[i + 2 * pixelCount] = (b - MEAN[2]) / STD[2]
  }

  return input
}

/**
 * Resize a 1D saliency array from model output size to original image size
 * using a temporary canvas for bilinear scaling.
 */
function resizeSaliency(saliency, srcSize, dstWidth, dstHeight) {
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = srcSize
  srcCanvas.height = srcSize
  const srcCtx = srcCanvas.getContext('2d')
  const srcImage = srcCtx.createImageData(srcSize, srcSize)

  for (let i = 0; i < saliency.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(saliency[i] * 255)))
    srcImage.data[i * 4] = v
    srcImage.data[i * 4 + 1] = v
    srcImage.data[i * 4 + 2] = v
    srcImage.data[i * 4 + 3] = 255
  }

  srcCtx.putImageData(srcImage, 0, 0)

  const dstCanvas = document.createElement('canvas')
  dstCanvas.width = dstWidth
  dstCanvas.height = dstHeight
  const dstCtx = dstCanvas.getContext('2d')
  dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight)

  const dstData = dstCtx.getImageData(0, 0, dstWidth, dstHeight).data
  const mask = new Float32Array(dstWidth * dstHeight)

  for (let i = 0; i < mask.length; i++) {
    mask[i] = dstData[i * 4] / 255.0
  }

  return mask
}

/**
 * Segment the main subject in a Blob.
 * Returns { mask: Float32Array[width*height], width, height, threshold }
 * where mask values are in [0, 1].
 */
export async function segmentSubject(blob, onProgress, threshold = 0.5) {
  const session = await loadSegmentor(onProgress)
  const image = await blobToImage(blob)

  try {
    const input = preprocessImage(image)
    const tensor = new ort.Tensor('float32', input, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE])

    const results = await session.run({ [session.inputNames[0]]: tensor })
    // The fused saliency output is the first output.
    const outputName = session.outputNames[0]
    const output = results[outputName]
    const saliency = output.data

    const mask = resizeSaliency(saliency, MODEL_INPUT_SIZE, image.naturalWidth, image.naturalHeight)

    return {
      mask,
      width: image.naturalWidth,
      height: image.naturalHeight,
      threshold,
    }
  } finally {
    URL.revokeObjectURL(image.src)
  }
}

/**
 * Compute a bounding box from a binary mask.
 */
/**
 * Compute the centre of mass of a mask.
 */
export function maskCenterOfMass(mask, width, height, threshold = 0.5) {
  let sumX = 0
  let sumY = 0
  let total = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x] > threshold ? 1 : 0
      if (v > 0) {
        sumX += x * v
        sumY += y * v
        total += v
      }
    }
  }

  if (total === 0) return null

  return {
    x: sumX / total,
    y: sumY / total,
  }
}

export function maskToBoundingBox(mask, width, height, threshold = 0.5) {
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  let found = false

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > threshold) {
        found = true
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (!found) return null

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

/**
 * Estimate alignment shift from the offset between two subject boxes.
 */
export function estimateShift(leftBox, rightBox) {
  return {
    hShift: Math.round(rightBox.cx - leftBox.cx),
    vShift: Math.round(rightBox.cy - leftBox.cy),
  }
}

/**
 * Compute the intersection of two boxes.
 */
export function intersectBoxes(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)

  const width = Math.max(0, x2 - x1)
  const height = Math.max(0, y2 - y1)

  return { x: x1, y: y1, width, height }
}
