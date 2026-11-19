
import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
export const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const supabaseKey = supabasePublishableKey

if (!supabaseUrl || !supabaseKey) {
  console.error("Falta configuración necesaria para iniciar la aplicación.", {
    missingUrl: !supabaseUrl,
    missingKey: !supabaseKey,
  })
  throw new Error('No se pudo iniciar la aplicación. Contacta con soporte.')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
