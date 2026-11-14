import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/app.css'

// Collected so the headless self-test can assert the renderer booted cleanly
// rather than merely "without crashing the process".
declare global {
  interface Window {
    __wcErrors?: string[]
  }
}
window.__wcErrors = []
window.addEventListener('error', (e) => {
  window.__wcErrors?.push(e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  window.__wcErrors?.push(String(e.reason))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
