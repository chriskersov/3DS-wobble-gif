import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import './index.css'
import App from './App.jsx'

// jpeg-js (used by mpo-parser's fixture generator) expects Buffer to be
// available as a global. This makes it work in the browser test UI.
globalThis.Buffer = Buffer

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
