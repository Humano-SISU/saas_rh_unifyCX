import React, { createContext } from 'react'
import { AppProps } from 'next/app'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import localFont from 'next/font/local'
import { ToastContainer } from '../lib/toast'
import { cn } from '../lib/utils'
import {
  isPublicMarketingRoute,
  isPublicKioskDisabledRoute,
  isPublicTenantLandingRoute,
} from '../lib/seo/public-ssr-routes'
import MarketingAnalytics from '../components/marketing/MarketingAnalytics'
import CookieBanner from '../components/marketing/CookieBanner'
import { LandingPreferencesProvider } from '../components/landing/LandingPreferencesProvider'
import '../styles/globals.css'
import '../styles/templates.css'

const AppAuthenticatedProviders = dynamic(
  () => import('../components/AppAuthenticatedProviders'),
  { ssr: true }
)

// Self-hosted (Google Fonts latin subset, variable weight) so the build does not
// depend on fetching fonts.googleapis.com, which failed intermittently in CI.
const montserrat = localFont({
  src: '../styles/fonts/montserrat-latin-variable.woff2',
  weight: '400 700',
  display: 'swap',
  preload: true,
  variable: '--font-montserrat',
  adjustFontFallback: 'Arial',
})

// Load environment variables at the top level
if (typeof window === 'undefined') {
  // Server-side: load environment variables
  require('dotenv').config()
}

// Create a context for Supabase client (using new SSR client)
export const SupabaseContext = createContext<any>(null)

export default function App({ Component, pageProps }: AppProps) {
  const [isClient, setIsClient] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    setIsClient(true)
  }, [])

  // After a new deploy, soft-nav can request stale /_next/static chunks and hang on
  // next/dynamic "Cargando…" placeholders. Force a full reload once to pick up the new build.
  React.useEffect(() => {
    const key = 'chunk-load-reload'
    const onError = (err: Error) => {
      const msg = err?.message || ''
      if (!/ChunkLoadError|Loading chunk [\d]+ failed|Failed to fetch dynamically imported module/i.test(msg)) {
        return
      }
      if (sessionStorage.getItem(key) === '1') return
      sessionStorage.setItem(key, '1')
      window.location.reload()
    }
    const clearReloadFlag = () => sessionStorage.removeItem(key)
    router.events.on('routeChangeError', onError)
    router.events.on('routeChangeComplete', clearReloadFlag)
    return () => {
      router.events.off('routeChangeError', onError)
      router.events.off('routeChangeComplete', clearReloadFlag)
    }
  }, [router.events])

  const isMeshAppRoute =
    router.pathname.startsWith('/app') &&
    router.pathname !== '/app/login' &&
    router.pathname !== '/app/forgot-password'

  const isAuthEntryRoute =
    router.pathname === '/app/login' || router.pathname === '/app/forgot-password'

  const asPathBare = router.asPath.split('#')[0].split('?')[0]
  const isMarketingRoute = isPublicMarketingRoute(router.pathname)
  const isKioskDisabledRoute = isPublicKioskDisabledRoute(router.pathname)
  const isTenantLandingRoute =
    isPublicTenantLandingRoute(router.pathname) ||
    isPublicTenantLandingRoute(asPathBare) ||
    pageProps?.publicTenantLanding === true

  // SSR completo solo en landings SEO; shell /app y rutas legacy esperan hidratación.
  const shouldRenderImmediately =
    isMarketingRoute || isAuthEntryRoute || isKioskDisabledRoute || isTenantLandingRoute

  const needsClientHydrationGate = !shouldRenderImmediately

  if (needsClientHydrationGate && !isClient) {
    return (
      <div className={cn('min-h-screen flex items-center justify-center', !isMeshAppRoute && 'bg-app')}>
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
      </div>
    )
  }

  const fontShellClass = cn(
    montserrat.variable,
    'min-h-screen font-sans',
    // La landing del tenant pinta su propio fondo desde el tema del JSON.
    !isMeshAppRoute && !isMarketingRoute && !isTenantLandingRoute && 'bg-app'
  )

  const page = (
    <div className={fontShellClass}>
      {/* Variable de fuente en :root para que portales (toasts, modales) hereden Montserrat */}
      <style jsx global>{`
        :root {
          --font-montserrat: ${montserrat.style.fontFamily};
        }
      `}</style>
      <Component {...pageProps} />
    </div>
  )

  if (isKioskDisabledRoute || isTenantLandingRoute) {
    return (
      <SupabaseContext.Provider value={null}>
        {page}
      </SupabaseContext.Provider>
    )
  }

  // Marketing: skip Auth/Notification; gtag/Meta wait for cookie opt-in.
  if (isMarketingRoute) {
    return (
      <SupabaseContext.Provider value={null}>
        <LandingPreferencesProvider>
          <div className={cn(montserrat.variable, 'font-sans')}>
            {page}
            <ToastContainer />
            <CookieBanner />
            <MarketingAnalytics />
          </div>
        </LandingPreferencesProvider>
      </SupabaseContext.Provider>
    )
  }

  return (
    <SupabaseContext.Provider value={null}>
      <AppAuthenticatedProviders showSessionWarning={router.pathname.startsWith('/app')}>
        {page}
      </AppAuthenticatedProviders>
    </SupabaseContext.Provider>
  )
}
