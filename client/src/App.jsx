import { useState, useEffect, useCallback } from 'react'
import { parseMPO, blobToDataURL } from 'mpo-parser'
import { cropBlob, computeDiff, createOverlayUrl } from './imageUtils.js'

function App() {
  const [error, setError] = useState(null)
  const [leftBlob, setLeftBlob] = useState(null)
  const [rightBlob, setRightBlob] = useState(null)
  const [cropPx, setCropPx] = useState(0)
  const [maxCrop, setMaxCrop] = useState(0)
  const [overlayUrl, setOverlayUrl] = useState(null)
  const [diffUrl, setDiffUrl] = useState(null)
  const [diffScore, setDiffScore] = useState(null)
  const [loading, setLoading] = useState(false)

  const updateDerivedImages = useCallback(async (lBlob, rBlob, crop) => {
    if (!lBlob || !rBlob) return

    setLoading(true)
    try {
      const leftCropped = await cropBlob(lBlob, crop, 'left')
      const rightCropped = await cropBlob(rBlob, crop, 'right')

      const [lUrl, rUrl] = await Promise.all([
        blobToDataURL(leftCropped),
        blobToDataURL(rightCropped),
      ])

      const [overlay, { diffUrl: dUrl, diffScore: score }] = await Promise.all([
        createOverlayUrl(lUrl, rUrl),
        computeDiff(leftCropped, rightCropped),
      ])

      setOverlayUrl(overlay)
      setDiffUrl(dUrl)
      setDiffScore(score)
    } catch (err) {
      console.error('Failed to compute derived images:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return

    setError(null)
    setOverlayUrl(null)
    setDiffUrl(null)
    setDiffScore(null)
    setLoading(true)

    try {
      const buffer = await file.arrayBuffer()
      const { left, right } = parseMPO(buffer)

      const [leftImg, rightImg] = await Promise.all([
        createImageBitmap(left),
        createImageBitmap(right),
      ])

      const maxCropValue = Math.min(leftImg.width, rightImg.width) - 1

      setLeftBlob(left)
      setRightBlob(right)
      setCropPx(0)
      setMaxCrop(Math.max(0, maxCropValue))

      await updateDerivedImages(left, right, 0)
    } catch (err) {
      console.error('parseMPO failed:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (leftBlob && rightBlob) {
      updateDerivedImages(leftBlob, rightBlob, cropPx)
    }
  }, [cropPx, leftBlob, rightBlob, updateDerivedImages])

  function adjustCrop(delta) {
    setCropPx((prev) => Math.max(0, Math.min(maxCrop, prev + delta)))
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
      <h2>3DS MPO Wobble Tool</h2>

      <div style={{ marginBottom: '20px' }}>
        <input
          type="file"
          accept=".mpo,.MPO"
          onChange={handleFile}
          disabled={loading}
        />
      </div>

      {error && (
        <div style={{ color: 'red', marginBottom: '20px', padding: '10px', border: '1px solid red' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {overlayUrl && (
        <>
          <div style={{ marginBottom: '20px', textAlign: 'center' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
              Symmetric crop: {cropPx}px
            </label>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                maxWidth: '600px',
                margin: '0 auto',
              }}
            >
              <button onClick={() => adjustCrop(-1)} disabled={cropPx <= 0 || loading} style={{ padding: '8px 12px' }}>
                ◀
              </button>
              <input
                type="range"
                min={0}
                max={maxCrop}
                value={cropPx}
                onChange={(e) => setCropPx(Number(e.target.value))}
                disabled={loading}
                style={{ flex: 1 }}
              />
              <button onClick={() => adjustCrop(1)} disabled={cropPx >= maxCrop || loading} style={{ padding: '8px 12px' }}>
                ▶
              </button>
            </div>
          </div>

          {diffScore !== null && (
            <div style={{ marginBottom: '20px', fontWeight: 'bold', textAlign: 'center' }}>
              Diff score: {diffScore.toFixed(1)} / 255
            </div>
          )}

          <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ textAlign: 'center' }}>Overlay</h3>
              <img src={overlayUrl} alt="Overlay" style={{ maxWidth: '400px', border: '1px solid #ccc' }} />
            </div>
            <div>
              <h3 style={{ textAlign: 'center' }}>Diff</h3>
              <img src={diffUrl} alt="Diff" style={{ maxWidth: '400px', border: '1px solid #ccc' }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default App
