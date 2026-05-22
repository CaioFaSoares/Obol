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

export function getCurrentMonthBoundaries() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  
  // O dia '0' do mês seguinte nos dá o último dia do mês atual
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString();
  const endOfMonth = new Date(Date.UTC(year, month, lastDay, 23, 59, 59, 999)).toISOString();

  return { startOfMonth, endOfMonth, year, month, lastDay };
}

export function calculateClampedDate(year: number, month: number, targetDay: number, lastDayOfMonth: number) {
  // Se o targetDay é 31 e estamos em Fev (28), o Math.min garante que retorne 28.
  const safeDay = Math.min(targetDay, lastDayOfMonth);
  return new Date(Date.UTC(year, month, safeDay, 0, 0, 0, 0)).toISOString();
}
