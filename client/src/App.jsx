import { useState, useEffect, useCallback, useRef } from 'react'
import { parseMPO, blobToDataURL } from 'mpo-parser'
import {
  alignImages,
  computeDiff,
  createOverlayUrl,
  generateWobbleGif,
  createAnaglyphBlob,
  downloadBlob,
} from './imageUtils.js'
import './App.css'

function App() {
  const [screen, setScreen] = useState('upload')
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [leftBlob, setLeftBlob] = useState(null)
  const [rightBlob, setRightBlob] = useState(null)

  const [hCrop, setHCrop] = useState(0)
  const [maxHCrop, setMaxHCrop] = useState(0)
  const [vShift, setVShift] = useState(0)
  const [maxVShift, setMaxVShift] = useState(0)

  const [overlayUrl, setOverlayUrl] = useState(null)
  const [diffUrl, setDiffUrl] = useState(null)
  const [diffScore, setDiffScore] = useState(null)

  const [gifUrl, setGifUrl] = useState(null)
  const [gifLoading, setGifLoading] = useState(false)

  const fileInputRef = useRef(null)

  const updateDerivedImages = useCallback(async (lBlob, rBlob, h, v) => {
    if (!lBlob || !rBlob) return

    try {
      const { left: leftAligned, right: rightAligned } = await alignImages(lBlob, rBlob, h, v)

      const [lUrl, rUrl] = await Promise.all([
        blobToDataURL(leftAligned),
        blobToDataURL(rightAligned),
      ])

      const [overlay, { diffUrl: dUrl, diffScore: score }] = await Promise.all([
        createOverlayUrl(lUrl, rUrl),
        computeDiff(leftAligned, rightAligned),
      ])

      setOverlayUrl(overlay)
      setDiffUrl(dUrl)
      setDiffScore(score)
    } catch (err) {
      console.error('Failed to compute derived images:', err)
      setError(err.message)
    }
  }, [])

  async function processFile(file) {
    if (!file) return

    setError(null)
    setOverlayUrl(null)
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)

    try {
      const buffer = await file.arrayBuffer()
      const { left, right } = parseMPO(buffer)

      const [leftImg, rightImg] = await Promise.all([
        createImageBitmap(left),
        createImageBitmap(right),
      ])

      const maxH = Math.min(200, Math.max(0, Math.min(leftImg.width, rightImg.width) - 1))
      const maxV = Math.max(0, Math.min(leftImg.height, rightImg.height) - 1)

      setLeftBlob(left)
      setRightBlob(right)
      setHCrop(0)
      setMaxHCrop(maxH)
      setVShift(0)
      setMaxVShift(maxV)

      await updateDerivedImages(left, right, 0, 0)
      setScreen('preview')
    } catch (err) {
      console.error('parseMPO failed:', err)
      setError(err.message)
    }
  }

  function handleFileChange(e) {
    processFile(e.target.files[0])
  }

  function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0])
    }
  }

  function handleDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
  }

  function handleBackToUpload() {
    setLeftBlob(null)
    setRightBlob(null)
    setHCrop(0)
    setMaxHCrop(0)
    setVShift(0)
    setMaxVShift(0)
    setOverlayUrl(null)
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setScreen('upload')
  }

  async function handleCreateGif() {
    if (!leftBlob || !rightBlob) return

    setGifLoading(true)
    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hCrop, vShift)
      const url = await generateWobbleGif(left, right)
      setGifUrl(url)
      setScreen('gif')
    } catch (err) {
      console.error('Failed to generate GIF:', err)
      setError(err.message)
    } finally {
      setGifLoading(false)
    }
  }

  async function handleDownloadAnaglyph() {
    if (!leftBlob || !rightBlob) return

    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hCrop, vShift)
      const blob = await createAnaglyphBlob(left, right)
      downloadBlob(blob, 'wobble-anaglyph.png')
    } catch (err) {
      console.error('Failed to generate anaglyph:', err)
      setError(err.message)
    }
  }

  function handleDownloadGif() {
    if (!gifUrl) return
    const a = document.createElement('a')
    a.href = gifUrl
    a.download = 'wobble.gif'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  useEffect(() => {
    if (leftBlob && rightBlob) {
      updateDerivedImages(leftBlob, rightBlob, hCrop, vShift)
    }
  }, [hCrop, vShift, leftBlob, rightBlob, updateDerivedImages])

  function adjustHCrop(delta) {
    setHCrop((prev) => Math.max(0, Math.min(maxHCrop, prev + delta)))
  }

  function adjustVShift(delta) {
    setVShift((prev) => Math.max(-maxVShift, Math.min(maxVShift, prev + delta)))
  }

  return (
    <div className="app">
      {error && (
        <div className="error-banner">
          <strong>ERROR:</strong> {error}
        </div>
      )}

      {screen === 'upload' && (
        <div className="upload-screen">
          <h1>3DS Wigglegram Maker</h1>

          <div
            className={`upload-zone ${dragActive ? 'active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mpo,.MPO"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <div className="upload-icon">📁</div>
            <div className="upload-title">Upload .MPO File</div>
            <div className="upload-hint">Drag & drop or click to choose</div>
          </div>

          <p style={{ textAlign: 'center', color: 'var(--gb-text-light)', maxWidth: '500px' }}>
            All processing happens locally in your browser. No images are uploaded.
          </p>
        </div>
      )}

      {screen === 'preview' && (
        <div className="preview-screen">
          <div className="slider-row">
            <label className="slider-label">Horizontal</label>
            <div className="slider-controls">
              <button onClick={() => adjustHCrop(-1)} disabled={hCrop <= 0}>-</button>
              <input
                type="range"
                min={0}
                max={maxHCrop}
                value={hCrop}
                onInput={(e) => setHCrop(Number(e.target.value))}
              />
              <button onClick={() => adjustHCrop(1)} disabled={hCrop >= maxHCrop}>+</button>
            </div>
          </div>

          <div className="preview-stage">
            <div className="vertical-slider-group">
              <label className="slider-label">Vertical</label>
              <div className="vertical-slider-wrap">
                <button onClick={() => adjustVShift(1)} disabled={vShift >= maxVShift}>+</button>
                <div className="vertical-slider-track">
                  <input
                    type="range"
                    className="green-thumb"
                    min={-maxVShift}
                    max={maxVShift}
                    value={vShift}
                    onInput={(e) => setVShift(Number(e.target.value))}
                  />
                </div>
                <button onClick={() => adjustVShift(-1)} disabled={vShift <= -maxVShift}>-</button>
              </div>
            </div>

            <div className="preview-right">
              <div className="image-stack">
                <div className="image-panel">
                  <h3>Overlay</h3>
                  <div className="retro-screen">
                    <img src={overlayUrl} alt="Overlay" />
                  </div>
                </div>

                <div className="image-panel">
                  <h3>Diff</h3>
                  <div className="retro-screen">
                    <img src={diffUrl} alt="Diff" />
                  </div>
                </div>
              </div>

              {diffScore !== null && (
                <div className="diff-score">DIFF SCORE: {diffScore.toFixed(1)} / 255</div>
              )}

              <div className="action-row">
                <button className="red" onClick={handleCreateGif} disabled={gifLoading}>
                  {gifLoading ? 'WORKING…' : 'CREATE GIF'}
                </button>
                <button className="grey" onClick={handleBackToUpload}>
                  BACK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {screen === 'gif' && (
        <div className="gif-screen">
          <h2>Your Wobble GIF</h2>

          <div className="retro-screen gif-preview">
            {gifUrl && <img src={gifUrl} alt="Wobble GIF" />}
          </div>

          <div className="action-row">
            <button className="blue" onClick={handleDownloadGif}>
              DOWNLOAD GIF
            </button>
            <button className="yellow" onClick={handleDownloadAnaglyph}>
              ANAGLYPH
            </button>
            <button onClick={() => setScreen('preview')}>BACK</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
