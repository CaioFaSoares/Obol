export function calculateCardDueDate(transactionDateStr: string, closingDay: number, dueDay: number): string {
  const txnDate = new Date(transactionDateStr);
  
  // O padrão é a fatura vencer no mesmo mês da compra (Offset = 0)
  let monthOffset = 0; 
  
  const txnDay = txnDate.getUTCDate();

  // Regra 1: Se a compra for feita no dia ou após o dia de fecho, entra na próxima fatura (+1 mês)
  if (txnDay >= closingDay) {
    monthOffset += 1; 
  }

  // Regra 2: Se o dia de vencimento for MENOR que o dia de fecho (Ex: fecha a 28, vence a 08), 
  // isso significa que o vencimento recai naturalmente no mês seguinte ao fecho (+1 mês)
  if (dueDay < closingDay) {
    monthOffset += 1;
  }

  // Calcula a data final com a inteligência nativa do Date do Javascript (que lida com viradas de ano)
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

export function determineInvoiceStatus(
  transactions: any[], 
  dueDateStr: string, 
  closingDay: number, 
  dueDay: number
): 'OPEN' | 'CLOSED' | 'PAID' {
  
  // Se TODAS as transações deste agrupamento já foram realizadas, a fatura está paga.
  const allRealized = transactions.every(t => t.status === 'realized');
  if (allRealized && transactions.length > 0) return 'PAID';

  // Lógica para descobrir a data exata do fechamento:
  const dueDate = new Date(dueDateStr);
  let closingMonth = dueDate.getUTCMonth();
  let closingYear = dueDate.getUTCFullYear();

  // Se o dia de fechamento é MAIOR que o dia de vencimento (Ex: Fecha 28, Vence 05)
  // Significa que a data de fechamento ocorreu no mês ANTERIOR ao vencimento.
  if (closingDay > dueDay) {
    closingMonth -= 1;
    if (closingMonth < 0) {
      closingMonth = 11;
      closingYear -= 1;
    }
  }

  const closingDate = new Date(Date.UTC(closingYear, closingMonth, closingDay, 23, 59, 59));
  const today = new Date();

  // Se o dia de hoje já passou do dia de fechamento, a fatura está Fechada (esperando pagamento)
  if (today > closingDate) return 'CLOSED';

  // Caso contrário, ainda aceita novos gastos
  return 'OPEN';
}
