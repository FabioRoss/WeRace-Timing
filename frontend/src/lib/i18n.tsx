import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { IT } from './locales/it'

// Lightweight i18n. Source strings are English (used as the lookup key); the
// Italian dictionary (`locales/it.ts`) maps each to its translation. A missing
// entry falls back to the English source, so the app never shows a raw key.
// Default language is Italian; the choice persists in localStorage.
export type Lang = 'it' | 'en'

const STORAGE_KEY = 'wrb_lang'
const DICTS: Record<Lang, Record<string, string>> = { it: IT, en: {} }

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'it') return v
  } catch { /* no storage */ }
  return 'it'
}

interface LangCtx {
  lang: Lang
  setLang: (l: Lang) => void
}
const Ctx = createContext<LangCtx>({ lang: 'it', setLang: () => {} })

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = l
  }, [])
  // Reflect the active language on <html lang> (a11y + correct hyphenation).
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>
}

export function useLang() {
  return useContext(Ctx)
}

type Vars = Record<string, string | number>

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`))
}

/** Returns a `t(englishSource, vars?)` translator bound to the current language.
 * `{name}` placeholders in the source are filled from `vars`. */
export function useT() {
  const { lang } = useContext(Ctx)
  return useCallback(
    (en: string, vars?: Vars): string => {
      const translated = lang === 'en' ? en : (DICTS[lang][en] ?? en)
      return interpolate(translated, vars)
    },
    [lang],
  )
}

/** Compact IT / EN language toggle. Rendered in the shared header + landing. */
export function LangSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useLang()
  return (
    <div className={`inline-flex overflow-hidden rounded ring-1 ring-pit-600 ${className}`}>
      {(['it', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`px-2 py-1 text-[0.7rem] font-bold uppercase tracking-wider ${
            lang === l ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
