export function calculateCardDueDate(transactionDateStr: string, closingDay: number, dueDay: number): string {
  const txnDate = new Date(transactionDateStr);
  let monthOffset = 1; // Por padrão, a fatura vence no mês seguinte
  
  // Extrai o dia da transação em UTC para evitar problemas de fuso horário
  const txnDay = txnDate.getUTCDate();

  // Se passou (ou é o dia) do fechamento, a fatura deste mês já "virou". Pula pro próximo ciclo.
  if (txnDay >= closingDay) {
    monthOffset = 2; 
  }

  // O Date do JavaScript é inteligente: se o mês passar de 11 (Dezembro), ele vira o ano automaticamente.
  const dueDate = new Date(Date.UTC(
    txnDate.getUTCFullYear(), 
    txnDate.getUTCMonth() + monthOffset, 
    dueDay
  ));

  return dueDate.toISOString(); 
}
