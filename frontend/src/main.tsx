import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { SessionProvider } from './context/SessionContext'
import { ClientProvider } from './context/ClientContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ClientProvider>
          <App />
        </ClientProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
