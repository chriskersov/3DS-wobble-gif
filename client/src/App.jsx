import { useState } from 'react'
import { parseMPO, blobToDataURL } from './lib/mpoParser'

function App() {
  const [error, setError] = useState(null)
  const [images, setImages] = useState({ left: null, right: null })

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return

    console.log('File:', file.name, 'Size:', file.size, 'bytes')
    setError(null)
    setImages({ left: null, right: null })
    
    try {
      const buffer = await file.arrayBuffer()
      
      console.log('🔧 Attempting parseMPO...')
      const { left, right } = parseMPO(buffer)
      
      console.log('Left blob size:', left.size)
      console.log('Right blob size:', right.size)

      const leftURL = await blobToDataURL(left)
      const rightURL = await blobToDataURL(right)
      
      setImages({ left: leftURL, right: rightURL })
    } catch (err) {
      console.error('parseMPO failed:', err)
      setError(err.message)
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
      <h2>3DS MPO Viewer</h2>
      <input 
        type="file" 
        accept=".mpo,.MPO" 
        onChange={handleFile} 
        style={{ marginBottom: '20px' }}
      />
      
      {error && (
        <div style={{ color: 'red', marginBottom: '20px', padding: '10px', border: '1px solid red' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '20px' }}>
        {images.left && (
          <div>
            <h3>Left Eye</h3>
            <img src={images.left} alt="Left eye view" style={{ width: '100%', maxWidth: '600px', border: '1px solid #ccc' }} />
          </div>
        )}
        {images.right && (
          <div>
            <h3>Right Eye</h3>
            <img src={images.right} alt="Right eye view" style={{ width: '100%', maxWidth: '600px', border: '1px solid #ccc' }} />
          </div>
        )}
      </div>
    </div>
  )
}

export default App