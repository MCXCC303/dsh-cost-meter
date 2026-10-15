/** The browser locale face is optional; Host DSH exposes its saved preference through settings. */
export function supportedLocale(value) {
  if (typeof value !== 'string') return null
  const language = value.trim().toLowerCase().split(/[-_]/)[0]
  return language === 'zh' || language === 'en' ? language : null
}

export function hostLocaleOf(ctx) {
  try {
    const locale = ctx?.get?.('locale')
    const active = supportedLocale(locale?.getSnapshot?.().active)
    if (active) return active
  } catch { /* Older hosts have no locale face. */ }
  try {
    const settings = ctx?.get?.('settings')
    // Read only the public, redacted descriptor; never inspect storage files or credentials.
    const rows = settings?.describe?.({ redactSecrets: true })
    return supportedLocale(Array.isArray(rows) ? rows.find(row => row?.ns === 'locale')?.value?.preference : undefined)
  } catch { return null }
}

export function localeOf(config, ctx) {
  if (config?.locale === 'zh' || config?.locale === 'en') return config.locale
  // An unset preference/native bootstrap can be browser-local. Host cannot infer it.
  return hostLocaleOf(ctx) ?? 'zh'
}
