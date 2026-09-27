/** Explicações para falhas do harness, sem depender do provedor específico. */
export function describeFailure(message: string) {
  if (/requires more credits|insufficient (credits|balance)|credit.*(limit|exceeded)|402/i.test(message)) {
    const requested = message.match(/requested up to\s+([\d,]+)/i)?.[1]
    const available = message.match(/can only afford\s+([\d,]+)/i)?.[1]
    const tokens = requested && available
      ? ` A chamada pediu até ${Number(requested.replaceAll(",", "")).toLocaleString("pt-BR")} tokens; o saldo permite ${Number(available.replaceAll(",", "")).toLocaleString("pt-BR")} nessa chamada.`
      : ""
    return {
      title: "Créditos insuficientes para iniciar o turno",
      description: `O provedor recusou a chamada antes de gerar uma resposta.${tokens}`,
      action: "Adicione créditos ou reduza o limite de saída na configuração do modelo. Depois, retome a tarefa.",
      link: /openrouter\.ai/i.test(message) ? { href: "https://openrouter.ai/settings/credits", label: "Abrir créditos no OpenRouter" } : undefined,
    }
  }
  if (/issuer certificate|certificate verify|CERT_|self.signed|unable to verify/i.test(message)) {
    return {
      title: "Não foi possível validar a conexão segura",
      description: "A sandbox não conseguiu verificar o certificado do serviço.",
      action: "Configure os certificados confiáveis da rede na sandbox. Se a configuração mudou, crie uma nova tarefa.",
    }
  }
  if (/unauthorized|invalid.*(?:key|token)|authentication|\b401\b/i.test(message)) {
    return {
      title: "O provedor recusou a credencial",
      description: "O agente não conseguiu autenticar a chamada ao modelo.",
      action: "Confira a chave e as permissões do provedor. Se a chave da sandbox mudou, crie uma nova tarefa.",
    }
  }
  if (/rate.limit|too many requests|\b429\b/i.test(message)) {
    return {
      title: "Limite de chamadas atingido",
      description: "O provedor interrompeu o turno por excesso de chamadas.",
      action: "Aguarde antes de retomar ou ajuste o limite de chamadas no provedor.",
    }
  }
  return {
    title: "O turno foi interrompido por uma falha",
    description: "O agente parou antes de concluir o pedido.",
    action: "Confira os detalhes abaixo, corrija a causa e retome a tarefa.",
  }
}
