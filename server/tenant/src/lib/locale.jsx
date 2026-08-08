import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { translate, detectLocale, rememberLocale, fmtMoney, fmtDate } from "./i18n.js";

/* Kept separate from main.jsx so pages can pull in useT without importing
   the app that imports them. */

const Ctx = createContext({ locale: "en", t: (k) => k });
export const useT = () => useContext(Ctx);

export function LocaleProvider({ children }) {
  const [locale, setLocale] = useState(detectLocale);
  const t = useCallback((k, p) => translate(locale, k, p), [locale]);
  const set = useCallback((l) => { setLocale(l); rememberLocale(l); }, []);

  useEffect(() => { document.documentElement.lang = locale === "zh" ? "zh-Hant" : "en"; }, [locale]);

  return (
    <Ctx.Provider value={{
      locale, t, setLocale: set,
      money: (n) => fmtMoney(locale, n),
      date: (d) => fmtDate(locale, d),
    }}>{children}</Ctx.Provider>
  );
}
