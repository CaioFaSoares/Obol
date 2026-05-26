import type PocketBase from 'pocketbase';
import { calculateCardDueDate } from '../utils/dateUtils';
import { sum } from '../utils/mathUtils';

/**
 * Sincroniza o saldo de uma transação com a sua respectiva fatura física.
 * @param pb Instância do PocketBase
 * @param card_id ID do Cartão
 * @param expected_date Data em que a compra ocorreu (antes ou depois do fechamento)
 * @param amount Valor da transação (absoluto)
 * @param type 'expense' ou 'income'
 * @returns A fatura atualizada ou recém-criada
 */
export async function syncInvoice(pb: PocketBase, card_id: string, expected_date: string, amount: number, type: string) {
  // 1. Busca regras do cartão e calcula o vencimento
  const card = await pb.collection('cards').getOne(card_id);
  const projectedDueDate = calculateCardDueDate(expected_date, card.closing_day, card.due_day);
  const period = projectedDueDate.substring(0, 7); // Ex: "2026-05"

  // 2. Busca se a fatura já existe
  let invoice;
  try {
    invoice = await pb.collection('invoices').getFirstListItem(`card_id = '${card_id}' && period = '${period}'`);
  } catch (err) {
    // Fatura não existe para esse período.
    invoice = null;
  }

  // 3. Calcula o impacto no saldo (Despesa soma, Receita subtrai)
  const amountDelta = type === 'expense' ? amount : -amount;

  if (invoice) {
    // 4a. Atualiza a fatura existente
    const newTotal = sum(invoice.total_amount, amountDelta);
    return await pb.collection('invoices').update(invoice.id, {
      total_amount: newTotal
    });
  } else {
    // 4b. Cria uma nova fatura
    return await pb.collection('invoices').create({
      card_id,
      period,
      due_date: projectedDueDate,
      status: 'OPEN',
      total_amount: amountDelta,
      paid_amount: 0
    });
  }
}
