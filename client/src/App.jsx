import { useState, useEffect, useCallback, useRef } from 'react'
import { parseMPO, blobToDataURL } from 'mpo-parser'
import {
  alignImages,
  computeDiff,
  generateWobbleGif,
  createAnaglyphBlob,
  downloadBlob,
  getImageDimensions,
} from './imageUtils.js'
import './App.css'

const HORIZONTAL_LIMIT = 200
const VIEWPORT_WIDTH = 300
const VIEWPORT_HEIGHT = 225

/**
 * Draw the original left/right stereo pair into a fixed-size canvas with
 * equal 50% contribution from both images. Drawing on a black background with
 * additive blending means the overlapping region is a true 50/50 blend and
 * neither image appears more opaque than the other.
 */
function OverlayCanvas({ leftUrl, rightUrl, width, height, hShift, vShift }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const leftImg = new Image()
    const rightImg = new Image()

    leftImg.onload = () => {
      rightImg.onload = () => {
        const scaleX = width > 0 ? VIEWPORT_WIDTH / width : 1
        const scaleY = height > 0 ? VIEWPORT_HEIGHT / height : 1

        const hOffset = (Math.abs(hShift) / 2) * scaleX
        const vOffset = (Math.abs(vShift) / 2) * scaleY
        const hSign = hShift >= 0 ? 1 : -1
        const vSign = vShift >= 0 ? 1 : -1

        const leftTx = hSign * hOffset
        const leftTy = vSign * vOffset
        const rightTx = -hSign * hOffset
        const rightTy = -vSign * vOffset

        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalAlpha = 0.5
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(leftImg, leftTx, leftTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(rightImg, rightTx, rightTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
      rightImg.onerror = () => {}
      rightImg.src = rightUrl
    }
    leftImg.onerror = () => {}
    leftImg.src = leftUrl
  }, [leftUrl, rightUrl, width, height, hShift, vShift])

  return <canvas ref={canvasRef} width={VIEWPORT_WIDTH} height={VIEWPORT_HEIGHT} />
}

/**
 * Show the computed diff image at the exact size of the overlap region shown
 * in OverlayCanvas, centred inside the fixed viewport with black bars.
 */
function DiffViewport({ diffUrl, width, height, hShift, vShift }) {
  const hCrop = Math.abs(hShift)
  const vCrop = Math.abs(vShift)
  const scaleX = width > 0 ? VIEWPORT_WIDTH / width : 1
  const scaleY = height > 0 ? VIEWPORT_HEIGHT / height : 1

  const imgWidth = Math.max(1, width - hCrop) * scaleX
  const imgHeight = Math.max(1, height - vCrop) * scaleY
  const tx = (VIEWPORT_WIDTH - imgWidth) / 2
  const ty = (VIEWPORT_HEIGHT - imgHeight) / 2

  return (
    <div className="viewport" style={{ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }}>
      <img
        src={diffUrl}
        alt="Diff"
        className="viewport-img"
        style={{
          width: imgWidth,
          height: imgHeight,
          transform: `translate(${tx}px, ${ty}px)`,
        }}
      />
    </div>
  )
}

/**
 * Game Boy cartridge slot page switcher.
 */
function CartridgeSwitcher({ page, onChange }) {
  return (
    <div className="cartridge-switcher">
      <button
        className={`cartridge ${page === 'simple' ? 'inserted' : ''}`}
        onClick={() => onChange('simple')}
        aria-pressed={page === 'simple'}
      >
        <span className="cartridge-label">SIMPLE</span>
      </button>
      <button
        className={`cartridge ${page === 'advanced' ? 'inserted' : ''}`}
        onClick={() => onChange('advanced')}
        aria-pressed={page === 'advanced'}
      >
        <span className="cartridge-label">ADVANCED</span>
      </button>
    </div>
  )
}

/**
 * Horizontal shift slider placed between the overlay and diff images.
 */
function HorizontalSlider({ hShift, onHShiftChange }) {
  function adjust(delta) {
    onHShiftChange((prev) => Math.max(-HORIZONTAL_LIMIT, Math.min(HORIZONTAL_LIMIT, prev + delta)))
  }

  return (
    <div className="horizontal-slider">
      <div className="slider-label-row">
        <label className="slider-label">Horizontal</label>
        <button className="reset-button" onClick={() => onHShiftChange(0)}>
          RESET
        </button>
      </div>
      <div className="slider-controls">
        <button onClick={() => adjust(-1)} disabled={hShift <= -HORIZONTAL_LIMIT}>
          -
        </button>
        <input
          type="range"
          min={-HORIZONTAL_LIMIT}
          max={HORIZONTAL_LIMIT}
          value={hShift}
          onInput={(e) => onHShiftChange(Number(e.target.value))}
        />
        <button onClick={() => adjust(1)} disabled={hShift >= HORIZONTAL_LIMIT}>
          +
        </button>
      </div>
    </div>
  )
}

/**
 * Vertical shift slider placed in the left column next to the previews.
 */
function VerticalSlider({ vShift, maxVShift, onVShiftChange }) {
  function adjust(delta) {
    onVShiftChange((prev) => Math.max(-maxVShift, Math.min(maxVShift, prev + delta)))
  }

  return (
    <div className="vertical-slider">
      <label className="slider-label">Vertical</label>
      <button onClick={() => adjust(1)} disabled={vShift >= maxVShift}>
        +
      </button>
      <div className="vertical-slider-track">
        <input
          type="range"
          className="green-thumb"
          min={-maxVShift}
          max={maxVShift}
          value={vShift}
          onInput={(e) => onVShiftChange(Number(e.target.value))}
        />
      </div>
      <button onClick={() => adjust(-1)} disabled={vShift <= -maxVShift}>
        -
      </button>
      <button className="reset-button" onClick={() => onVShiftChange(0)}>
        RESET
      </button>
    </div>
  )
}

/**
 * Side-by-side overlay and diff preview panels.
 */
function PreviewPanels({ leftOriginalUrl, rightOriginalUrl, originalDims, hShift, vShift, diffUrl }) {
  return (
    <div className="image-stack">
      <div className="image-panel">
        <h3>Overlay</h3>
        <div className="retro-screen fixed-screen">
          <OverlayCanvas
            leftUrl={leftOriginalUrl}
            rightUrl={rightOriginalUrl}
            width={originalDims.width}
            height={originalDims.height}
            hShift={hShift}
            vShift={vShift}
          />
        </div>
      </div>

      <div className="image-panel">
        <h3>Diff</h3>
        <div className="retro-screen fixed-screen">
          <DiffViewport
            diffUrl={diffUrl}
            width={originalDims.width}
            height={originalDims.height}
            hShift={hShift}
            vShift={vShift}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Advanced GIF generation settings panel.
 */
function GifSettings({ settings, onChange }) {
  return (
    <div className="gif-settings">
      <h3>GIF Settings</h3>

      <div className="setting-row">
        <label>Frame delay</label>
        <div className="setting-control">
          <input
            type="range"
            min={50}
            max={1000}
            step={50}
            value={settings.delayMs}
            onInput={(e) => onChange({ ...settings, delayMs: Number(e.target.value) })}
          />
          <span>{settings.delayMs} ms</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Cycles</label>
        <div className="setting-control">
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={settings.cycles}
            onInput={(e) => onChange({ ...settings, cycles: Number(e.target.value) })}
          />
          <span>{settings.cycles}</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Crossfade</label>
        <div className="setting-control">
          <input
            type="range"
            min={0}
            max={8}
            step={1}
            value={settings.crossfadeSteps}
            onInput={(e) => onChange({ ...settings, crossfadeSteps: Number(e.target.value) })}
          />
          <span>{settings.crossfadeSteps} frames</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Scale</label>
        <div className="setting-control">
          <input
            type="range"
            min={0.25}
            max={1.0}
            step={0.05}
            value={settings.scale}
            onInput={(e) => onChange({ ...settings, scale: Number(e.target.value) })}
          />
          <span>{Math.round(settings.scale * 100)}%</span>
        </div>
      </div>

      <div className="setting-row loop-row">
        <label>Loop forever</label>
        <button
          className={`loop-toggle ${settings.loop ? 'on' : 'off'}`}
          onClick={() => onChange({ ...settings, loop: !settings.loop })}
        >
          {settings.loop ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  )
}

/**
 * Line graph: diff score vs horizontal shift at the current vertical shift.
 */
/**
 * Create a canvas containing the subject mask as an RGBA image.
 */
function App() {
  const [screen, setScreen] = useState('upload')
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [leftBlob, setLeftBlob] = useState(null)
  const [rightBlob, setRightBlob] = useState(null)
  const [leftOriginalUrl, setLeftOriginalUrl] = useState(null)
  const [rightOriginalUrl, setRightOriginalUrl] = useState(null)
  const [originalDims, setOriginalDims] = useState({ width: 0, height: 0 })

  const [hShift, setHShift] = useState(0)
  const [vShift, setVShift] = useState(0)
  const [maxVShift, setMaxVShift] = useState(0)

  const [diffUrl, setDiffUrl] = useState(null)
  const [diffScore, setDiffScore] = useState(null)

  const [gifUrl, setGifUrl] = useState(null)
  const [gifLoading, setGifLoading] = useState(false)

  const [page, setPage] = useState('simple')

  const [gifSettings, setGifSettings] = useState({
    delayMs: 300,
    cycles: 1,
    crossfadeSteps: 0,
    scale: 1.0,
    loop: true,
  })

  const fileInputRef = useRef(null)

  const updateDerivedImages = useCallback(async (lBlob, rBlob, h, v) => {
    if (!lBlob || !rBlob) return

    try {
      const { left: leftAligned, right: rightAligned } = await alignImages(lBlob, rBlob, h, v)
      const { diffUrl: dUrl, diffScore: score } = await computeDiff(leftAligned, rightAligned)

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
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)

    try {
      const buffer = await file.arrayBuffer()
      const { left, right } = parseMPO(buffer)

      const [dims, lUrl, rUrl] = await Promise.all([
        getImageDimensions(left),
        blobToDataURL(left),
        blobToDataURL(right),
      ])

      const maxV = Math.max(0, Math.round(dims.height * 0.05))

      setLeftBlob(left)
      setRightBlob(right)
      setLeftOriginalUrl(lUrl)
      setRightOriginalUrl(rUrl)
      setOriginalDims(dims)
      setHShift(0)
      setVShift(0)
      setMaxVShift(maxV)
      setPage('simple')

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
    setLeftOriginalUrl(null)
    setRightOriginalUrl(null)
    setOriginalDims({ width: 0, height: 0 })
    setHShift(0)
    setVShift(0)
    setMaxVShift(0)
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setScreen('upload')
  }

  async function generateGifWithSettings(settings) {
    if (!leftBlob || !rightBlob) return

    setGifLoading(true)
    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hShift, vShift)
      const url = await generateWobbleGif(left, right, settings)
      setGifUrl(url)
      setScreen('gif')
    } catch (err) {
      console.error('Failed to generate GIF:', err)
      setError(err.message)
    } finally {
      setGifLoading(false)
    }
  }

  async function handleCreateGif() {
    await generateGifWithSettings({
      delayMs: 300,
      cycles: 1,
      crossfadeSteps: 0,
      scale: 1.0,
      loop: true,
    })
  }

  async function handleGenerateAdvancedGif() {
    await generateGifWithSettings(gifSettings)
  }

  async function handleDownloadAnaglyph() {
    if (!leftBlob || !rightBlob) return

    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hShift, vShift)
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
      updateDerivedImages(leftBlob, rightBlob, hShift, vShift)
    }
  }, [hShift, vShift, leftBlob, rightBlob, updateDerivedImages])

  const sharedVerticalSlider = (
    <VerticalSlider
      vShift={vShift}
      maxVShift={maxVShift}
      onVShiftChange={setVShift}
    />
  )

  const sharedHorizontalSlider = (
    <HorizontalSlider hShift={hShift} onHShiftChange={setHShift} />
  )

  const sharedPreviewPanels = (
    <PreviewPanels
      leftOriginalUrl={leftOriginalUrl}
      rightOriginalUrl={rightOriginalUrl}
      originalDims={originalDims}
      hShift={hShift}
      vShift={vShift}
      diffUrl={diffUrl}
    />
  )

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

          <p className="privacy-hint">
            All processing happens locally in your browser. No images are uploaded.
          </p>
        </div>
      )}

      {screen === 'preview' && (
        <div className="preview-screen">
          <CartridgeSwitcher page={page} onChange={setPage} />

          {page === 'simple' ? (
            <div className="page-content simple-page">
              {sharedHorizontalSlider}

              <div className="preview-body">
                {sharedVerticalSlider}
                {sharedPreviewPanels}
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
          ) : (
            <div className="page-content advanced-page">
              <GifSettings settings={gifSettings} onChange={setGifSettings} />

              {sharedHorizontalSlider}

              <div className="preview-body">
                {sharedVerticalSlider}
                {sharedPreviewPanels}
              </div>

              {diffScore !== null && (
                <div className="diff-score">DIFF SCORE: {diffScore.toFixed(1)} / 255</div>
              )}

              <div className="action-row">
                <button
                  className="red"
                  onClick={handleGenerateAdvancedGif}
                  disabled={gifLoading}
                >
                  {gifLoading ? 'WORKING…' : 'GENERATE GIF'}
                </button>
                <button className="grey" onClick={handleBackToUpload}>
                  BACK
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === 'gif' && (
        <div className="gif-screen">
          <CartridgeSwitcher page={page} onChange={setPage} />

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
