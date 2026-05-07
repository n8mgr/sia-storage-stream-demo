import type { ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthFlow } from './components/auth/AuthFlow'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/Toast'
import { SharePage } from './components/video/SharePage'
import { VideoZone } from './components/video/VideoZone'
import { WatchPage } from './components/video/WatchPage'
import { useAuthStore } from './stores/auth'

/**
 * Auth gate. Renders children only when the SDK is connected; otherwise
 * shows the connect/approve/recovery flow. Wraps every route so deep links
 * to /watch/:id still bounce through auth on a fresh session.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const step = useAuthStore((s) => s.step)
  return step === 'connected' ? children : <AuthFlow />
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <div className="flex-1 flex flex-col">
          <Routes>
            <Route
              path="/"
              element={
                <AuthGate>
                  <VideoZone />
                </AuthGate>
              }
            />
            <Route
              path="/watch/:id"
              element={
                <AuthGate>
                  <WatchPage />
                </AuthGate>
              }
            />
            <Route
              path="/share"
              element={
                <AuthGate>
                  <SharePage />
                </AuthGate>
              }
            />
          </Routes>
        </div>
        <Toasts />
      </div>
    </BrowserRouter>
  )
}
