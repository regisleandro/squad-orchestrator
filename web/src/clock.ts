// "Agora" da tela: Date.now ao vivo; no replay, o relógio virtual da reprodução.
// Halos de atividade e "há Ns" comparam timestamps dos eventos com este relógio.

import { createContext, useContext } from "react"

export const NowContext = createContext<() => number>(Date.now)

export function useNow() {
  return useContext(NowContext)
}
