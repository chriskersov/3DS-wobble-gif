import { useState, useCallback } from 'react'
import { parseMPO, blobToDataURL } from 'mpo-parser'
import { SYNTHETIC_FIXTURES } from 'mpo-parser/fixtures'
import { createOverlayUrl } from './overlay.js'

const EXAMPLE_FILES = [
  'example_1.MPO',
  'example_2.MPO',
  'example_3.MPO',
]

async function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsArrayBuffer(blob)
  })
}

function startsWithSOI(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

function endsWithEOI(bytes) {
  return (
    bytes.length >= 2 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  )
}

async function runFixtureTest(fixture) {
  const result = {
    name: fixture.name,
    description: fixture.description,
    expectedPass: fixture.shouldPass,
    passed: false,
    path: null,
    offset: null,
    leftSize: null,
    rightSize: null,
    leftUrl: null,
    rightUrl: null,
    overlayUrl: null,
    error: null,
  }

  const originalLog = console.log
  const originalWarn = console.warn

  try {
    const buffer = fixture.generate()

    // Capture which path the parser logs during the single parse call.
    let capturedPath = 'unknown'
    console.log = (...args) => {
      const msg = args.join(' ')
      if (msg.includes('MPF parsed successfully')) capturedPath = 'MPF'
      if (msg.includes('Fallback scan succeeded')) capturedPath = 'fallback'
      originalLog.apply(console, args)
    }
    console.warn = (...args) => {
      const msg = args.join(' ')
      if (msg.includes('Falling back to marker scan')) capturedPath = 'fallback'
      originalWarn.apply(console, args)
    }

    const { left, right } = parseMPO(buffer)

    console.log = originalLog
    console.warn = originalWarn

    result.path = capturedPath

    const leftBytes = new Uint8Array(await blobToArrayBuffer(left))
    const rightBytes = new Uint8Array(await blobToArrayBuffer(right))

    result.leftSize = leftBytes.length
    result.rightSize = rightBytes.length
    result.leftUrl = await blobToDataURL(left)
    result.rightUrl = await blobToDataURL(right)
    result.overlayUrl = await createOverlayUrl(result.leftUrl, result.rightUrl)

    const leftValid = startsWithSOI(leftBytes) && leftBytes.some((_, i) => leftBytes[i] === 0xff && leftBytes[i + 1] === 0xd9)
    const rightValid = startsWithSOI(rightBytes) && endsWithEOI(rightBytes)

    result.passed = leftValid && rightValid
  } catch (err) {
    console.log = originalLog
    console.warn = originalWarn
    result.error = err.message
    result.passed = !fixture.shouldPass
  }

  return result
}

async function runExampleTest(filename) {
  const result = {
    name: filename,
    description: 'Real 3DS example MPO',
    expectedPass: true,
    passed: false,
    path: null,
    leftSize: null,
    rightSize: null,
    leftUrl: null,
    rightUrl: null,
    overlayUrl: null,
    error: null,
  }

  const originalLog = console.log
  const originalWarn = console.warn

  try {
    const response = await fetch(`/examples/${filename}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filename}: ${response.status} ${response.statusText}`)
    }
    const buffer = await response.arrayBuffer()

    let capturedPath = 'unknown'
    console.log = (...args) => {
      const msg = args.join(' ')
      if (msg.includes('MPF parsed successfully')) capturedPath = 'MPF'
      if (msg.includes('Fallback scan succeeded')) capturedPath = 'fallback'
      originalLog.apply(console, args)
    }
    console.warn = (...args) => {
      const msg = args.join(' ')
      if (msg.includes('Falling back to marker scan')) capturedPath = 'fallback'
      originalWarn.apply(console, args)
    }

    const { left, right } = parseMPO(buffer)

    console.log = originalLog
    console.warn = originalWarn

    result.path = capturedPath
    result.leftSize = left.size
    result.rightSize = right.size
    result.leftUrl = await blobToDataURL(left)
    result.rightUrl = await blobToDataURL(right)
    result.overlayUrl = await createOverlayUrl(result.leftUrl, result.rightUrl)
    result.passed = true
  } catch (err) {
    console.log = originalLog
    console.warn = originalWarn
    result.error = err.message
    result.passed = false
  }

  return result
}

export default function App() {
  const [results, setResults] = useState([])
  const [exampleResults, setExampleResults] = useState([])
  const [running, setRunning] = useState(false)
  const [loadingExamples, setLoadingExamples] = useState(false)
  const [uploadResult, setUploadResult] = useState(null)

  const runAll = useCallback(async () => {
    setRunning(true)
    setResults([])
    const all = []
    for (const fixture of SYNTHETIC_FIXTURES) {
      all.push(await runFixtureTest(fixture))
      setResults([...all])
    }
    setRunning(false)
  }, [])

  const loadExamples = useCallback(async () => {
    setLoadingExamples(true)
    setExampleResults([])
    const all = []
    for (const filename of EXAMPLE_FILES) {
      all.push(await runExampleTest(filename))
      setExampleResults([...all])
    }
    setLoadingExamples(false)
  }, [])

  async function handleUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploadResult(null)
    try {
      const buffer = await file.arrayBuffer()
      const { left, right } = parseMPO(buffer)
      const leftUrl = await blobToDataURL(left)
      const rightUrl = await blobToDataURL(right)
      setUploadResult({
        name: file.name,
        passed: true,
        leftSize: left.size,
        rightSize: right.size,
        leftUrl,
        rightUrl,
        overlayUrl: await createOverlayUrl(leftUrl, rightUrl),
      })
    } catch (err) {
      setUploadResult({ name: file.name, passed: false, error: err.message })
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>MPO Parser Test Runner</h1>
      <p>
        Runs the parser against synthetic fixtures and real example MPOs in the
        browser. Each fixture tests a different path or edge case.
      </p>

      <div style={{ marginBottom: '20px' }}>
        <button onClick={runAll} disabled={running} style={{ fontSize: '16px', padding: '10px 20px' }}>
          {running ? 'Running…' : 'Run all synthetic tests'}
        </button>
      </div>

      <div style={{ marginBottom: '30px' }}>
        <h3>Or upload a real .MPO file</h3>
        <input type="file" accept=".mpo,.MPO" onChange={handleUpload} />
        {uploadResult && (
          <div
            style={{
              marginTop: '10px',
              padding: '10px',
              border: `1px solid ${uploadResult.passed ? 'green' : 'red'}`,
              background: uploadResult.passed ? '#f0fff0' : '#fff0f0',
            }}
          >
            <strong>{uploadResult.name}</strong> — {uploadResult.passed ? 'parsed' : `failed: ${uploadResult.error}`}
            {uploadResult.passed && (
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Left</div>
                  <img src={uploadResult.leftUrl} alt="Left" style={{ maxWidth: '200px', border: '1px solid #ccc' }} />
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Right</div>
                  <img src={uploadResult.rightUrl} alt="Right" style={{ maxWidth: '200px', border: '1px solid #ccc' }} />
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Overlay</div>
                  <img src={uploadResult.overlayUrl} alt="Overlay" style={{ maxWidth: '200px', border: '1px solid #ccc' }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {results.length > 0 && (
        <>
          <h2>Synthetic fixtures</h2>
          <ResultsTable results={results} />
        </>
      )}

      <div style={{ marginTop: '40px', marginBottom: '20px' }}>
        <h2>Real example MPOs</h2>
        <button
          onClick={loadExamples}
          disabled={loadingExamples}
          style={{ fontSize: '16px', padding: '10px 20px' }}
        >
          {loadingExamples ? 'Loading…' : 'Load example MPOs'}
        </button>
      </div>

      {exampleResults.length > 0 && <ResultsTable results={exampleResults} />}
    </div>
  )
}

function ResultsTable({ results }) {
  const passedCount = results.filter((r) => r.passed).length

  return (
    <>
      <p style={{ fontWeight: 'bold' }}>
        {passedCount}/{results.length} passed
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Name</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Expected</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Actual</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Path</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Sizes</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Images</th>
            <th style={{ padding: '10px', borderBottom: '2px solid #ddd' }}>Error</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.name} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '10px' }}>
                <strong>{r.name}</strong>
                <br />
                <small style={{ color: '#666' }}>{r.description}</small>
              </td>
              <td style={{ padding: '10px' }}>{r.expectedPass ? 'pass' : 'fail'}</td>
              <td style={{ padding: '10px' }}>
                <span style={{ color: r.passed ? 'green' : 'red', fontWeight: 'bold' }}>
                  {r.passed ? 'PASS' : 'FAIL'}
                </span>
              </td>
              <td style={{ padding: '10px' }}>{r.path || '—'}</td>
              <td style={{ padding: '10px' }}>
                {r.leftSize !== null && (
                  <>
                    L: {r.leftSize}
                    <br />
                    R: {r.rightSize}
                  </>
                )}
              </td>
              <td style={{ padding: '10px' }}>
                {r.leftUrl && (
                  <div style={{ display: 'flex', gap: '5px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: '#666' }}>L</div>
                      <img src={r.leftUrl} alt="Left" style={{ maxWidth: '70px', border: '1px solid #ccc' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: '#666' }}>R</div>
                      <img src={r.rightUrl} alt="Right" style={{ maxWidth: '70px', border: '1px solid #ccc' }} />
                    </div>
                    {r.overlayUrl && (
                      <div>
                        <div style={{ fontSize: '10px', color: '#666' }}>Overlay</div>
                        <img src={r.overlayUrl} alt="Overlay" style={{ maxWidth: '70px', border: '1px solid #ccc' }} />
                      </div>
                    )}
                  </div>
                )}
              </td>
              <td style={{ padding: '10px', color: 'red', fontSize: '13px' }}>{r.error || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
