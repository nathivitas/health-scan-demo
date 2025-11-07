console.log('[ui] mounting…');
window.addEventListener('error', (e) => console.error('[ui] window error:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[ui] unhandled:', e.reason));
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')).render(<App />)
