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
