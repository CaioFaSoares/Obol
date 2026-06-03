import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { calculateCardDueDate } from '../../../domain/utils/dateUtils';
import { sum, sub } from '../../../domain/utils/mathUtils';
import { NotFoundError } from '../../../domain/errors';

export interface GetCardInvoicesResponse {
  period: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  totalSpent: number;
  status: 'OPEN' | 'CLOSED' | 'PAID' | 'PROJECTED';
  transactions: {
    id: string;
    title: string;
    amount: number;
    status: string;
    expected_date: string;
    purchase_date: string | null;
    recurrence_id: string | null;
  }[];
}

export class GetCardInvoicesUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly recurrenceRepository: RecurrenceRepository
  ) {}

  async execute(cardId: string): Promise<GetCardInvoicesResponse[]> {
    // 1. Busca as regras do cartão
    const card = await this.cardRepository.findById(cardId);
    if (!card) {
      throw new NotFoundError('Cartão não encontrado');
    }

    // 2. Busca todas as faturas físicas desse cartão
    const invoices = await this.invoiceRepository.listAll({
      filter: `card_id = '${card.id}'`,
      sort: '-period' // Ordena da mais recente pra mais antiga
    });

    // 3. Monta o DTO com as transações aninhadas
    const result: GetCardInvoicesResponse[] = [];
    for (const inv of invoices) {
      const txns = await this.transactionRepository.listAll({
        filter: `invoice_id = '${inv.id}'`,
        sort: 'expected_date'
      });

      // Calcula o gasto bruto (ignorando estornos para exibição)
      let totalSpent = 0;
      for (const txn of txns) {
        if (txn.type === 'expense') totalSpent = sum(totalSpent, txn.amount);
        if (txn.type === 'income' && !txn.title.toLowerCase().includes('pagamento')) {
          totalSpent = sub(totalSpent, txn.amount);
        }
      }

      result.push({
        period: inv.period,
        dueDate: inv.due_date,
        totalAmount: sub(inv.total_amount, inv.paid_amount || 0), // Saldo real devedor
        paidAmount: inv.paid_amount || 0,
        totalSpent: totalSpent,
        status: inv.status,
        transactions: txns.map(txn => ({
          id: txn.id,
          title: txn.title,
          amount: txn.amount,
          status: txn.status,
          expected_date: txn.expected_date,
          purchase_date: txn.purchase_date || null,
          recurrence_id: txn.recurrence_id || null
        }))
      });
    }

    // 4. Projeção de Recorrências nas Faturas Abertas e na Próxima (virtual)
    const recurrences = await this.recurrenceRepository.listAll({
      filter: `card_id = '${card.id}' && status = 'active'`
    });

    if (recurrences.length > 0) {
      // A. Injeta as recorrências faltantes nas faturas físicas que estão ABERTAS
      for (const inv of result) {
        if (inv.status === 'OPEN') {
          for (const rec of recurrences) {
            // Verifica se já existe uma transação real para esta recorrência nesta fatura
            const alreadyHas = inv.transactions.some((t: any) => t.recurrence_id === rec.id);
            if (!alreadyHas) {
              // Checa se o parcelamento já encerrou
              let installmentLabel = '';
              if (rec.total_installments && rec.total_installments > 0) {
                // Rough estimation baseada na data esperada
                const history = await this.transactionRepository.list({
                  page: 1,
                  perPage: 1,
                  filter: `recurrence_id = '${rec.id}' && expected_date < '${inv.dueDate}'`
                });
                const nextInstallment = history.totalItems + 1;
                if (nextInstallment > rec.total_installments) continue; // Parcelamento concluído antes dessa fatura
                installmentLabel = ` - Parcela ${nextInstallment}/${rec.total_installments}`;
              }

              const [iy, im] = inv.period.split('-').map(Number);
              
              // Generates dates for current and previous month based on period
              const d1 = new Date(Date.UTC(iy, im - 1, rec.payday));
              const d2 = new Date(Date.UTC(iy, im - 2, rec.payday));
              const d3 = new Date(Date.UTC(iy, im, rec.payday));
              
              const due1 = calculateCardDueDate(d1.toISOString(), card.closing_day, card.due_day);
              const due2 = calculateCardDueDate(d2.toISOString(), card.closing_day, card.due_day);
              const due3 = calculateCardDueDate(d3.toISOString(), card.closing_day, card.due_day);

              let recDateStr = '';
              if (due1.substring(0,10) === inv.dueDate.substring(0,10)) {
                recDateStr = d1.toISOString();
              } else if (due2.substring(0,10) === inv.dueDate.substring(0,10)) {
                recDateStr = d2.toISOString();
              } else if (due3.substring(0,10) === inv.dueDate.substring(0,10)) {
                recDateStr = d3.toISOString();
              }

              if (!recDateStr) continue; // This recurrence doesn't map to this invoice

              // Check if user manually skipped this recurrence for this invoice period
              if (rec.skipped_periods && rec.skipped_periods.includes(inv.period)) {
                continue;
              }

              const amount = rec.amount;
              const delta = rec.type === 'expense' ? amount : -amount;
              
              inv.totalAmount = sum(inv.totalAmount, delta);
              inv.totalSpent = sum(inv.totalSpent, delta);
              
              inv.transactions.push({
                id: `projected-${rec.id}-${inv.period}`,
                title: `${rec.name}${installmentLabel}`,
                amount: amount,
                status: 'projected',
                expected_date: recDateStr,
                purchase_date: null,
                recurrence_id: rec.id
              });
            }
          }
          // Reordena as transações por data para manter a visualização cronológica
          inv.transactions.sort((a: any, b: any) => new Date(a.expected_date).getTime() - new Date(b.expected_date).getTime());
        }
      }

      // B. Gera a PRÓXIMA fatura puramente virtual
      const now = new Date();
      const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      
      // Se houver uma fatura física, pegamos o período dela. Senão, usamos o mês atual.
      const latestPeriod = result.length > 0 ? result[0].period : currentPeriod;
      let [ly, lm] = latestPeriod.split('-').map(Number);
      
      const latestPeriodVal = ly * 12 + lm;
      const currentPeriodVal = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
      
      let nextMonth, nextYear;
      if (latestPeriodVal < currentPeriodVal) {
        nextYear = now.getUTCFullYear();
        nextMonth = now.getUTCMonth() + 1;
      } else {
        nextMonth = lm === 12 ? 1 : lm + 1;
        nextYear = lm === 12 ? ly + 1 : ly;
      }

      const nextPeriod = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

      // Garante que não duplica
      const alreadyExists = result.some(r => r.period === nextPeriod);
      
      if (!alreadyExists) {
        const projectedTxns: any[] = [];
        let projectedTotal = 0;

        for (const rec of recurrences) {
          let installmentLabel = '';
          if (rec.total_installments && rec.total_installments > 0) {
            const history = await this.transactionRepository.list({
              page: 1,
              perPage: 1,
              filter: `recurrence_id = '${rec.id}'`
            });
            const nextInstallment = history.totalItems + 1;
            if (nextInstallment > rec.total_installments) continue;
            installmentLabel = ` - Parcela ${nextInstallment}/${rec.total_installments}`;
          }

          const amount = rec.amount;
          const delta = rec.type === 'expense' ? amount : -amount;

          // Encontrar data de projeção correta para a fatura virtual
          const fakePurchaseDate = `${nextPeriod}-01T00:00:00.000Z`;
          const projectedDueDate = calculateCardDueDate(fakePurchaseDate, card.closing_day, card.due_day);

          const [ny, nm] = nextPeriod.split('-').map(Number);
          const d1 = new Date(Date.UTC(ny, nm - 1, rec.payday));
          const d2 = new Date(Date.UTC(ny, nm - 2, rec.payday));
          const d3 = new Date(Date.UTC(ny, nm, rec.payday));
          
          const due1 = calculateCardDueDate(d1.toISOString(), card.closing_day, card.due_day);
          const due2 = calculateCardDueDate(d2.toISOString(), card.closing_day, card.due_day);
          const due3 = calculateCardDueDate(d3.toISOString(), card.closing_day, card.due_day);

          let recDateStr = '';
          if (due1.substring(0,10) === projectedDueDate.substring(0,10)) {
            recDateStr = d1.toISOString();
          } else if (due2.substring(0,10) === projectedDueDate.substring(0,10)) {
            recDateStr = d2.toISOString();
          } else if (due3.substring(0,10) === projectedDueDate.substring(0,10)) {
            recDateStr = d3.toISOString();
          }

          if (!recDateStr) continue;

          if (rec.skipped_periods && rec.skipped_periods.includes(nextPeriod)) {
            continue;
          }

          projectedTotal = sum(projectedTotal, delta);

          projectedTxns.push({
            id: `projected-${rec.id}`,
            title: `${rec.name}${installmentLabel}`,
            amount: amount,
            status: 'projected',
            expected_date: recDateStr,
            purchase_date: null,
            recurrence_id: rec.id
          });
        }

        if (projectedTxns.length > 0) {
          const fakePurchaseDate = `${nextPeriod}-01T00:00:00.000Z`;
          const projectedDueDate = calculateCardDueDate(fakePurchaseDate, card.closing_day, card.due_day);

          result.unshift({
            period: nextPeriod,
            dueDate: projectedDueDate,
            totalAmount: projectedTotal,
            paidAmount: 0,
            totalSpent: projectedTotal,
            status: 'PROJECTED',
            transactions: projectedTxns
          });
        }
      }
    }

    return result;
  }
}
