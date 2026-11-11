
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("Falta configuración necesaria para iniciar la aplicación.", {
    missingUrl: !supabaseUrl,
    missingKey: !supabaseKey,
  })
  throw new Error('No se pudo iniciar la aplicación. Contacta con soporte.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)
