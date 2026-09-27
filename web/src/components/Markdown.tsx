// Texto dos agentes (mensagens, reasoning, board) é markdown. react-markdown não interpreta HTML cru,
// então conteúdo vindo do modelo não vira HTML na página.

import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

const components: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** Reasoning do agente: recolhível, aberto por padrão, com a primeira linha como resumo. */
export function Thinking({ text, label = "Pensando" }: { text: string; label?: string }) {
  const first = text.trim().split("\n")[0]!.replace(/^[#>*\-\s]+/, "")
  return (
    <details className="thinking" open>
      <summary>
        <span className="label">{label}</span>
        <span className="thinking-first">{first}</span>
      </summary>
      <Markdown text={text} />
    </details>
  )
}
