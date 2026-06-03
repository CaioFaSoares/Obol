import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { sum, sub, roundCurrency } from '../../../domain/utils/mathUtils';

interface ForecastQuery {
  startDate: string;
  endDate: string;
  includeSimulations?: string;
}

interface ForecastTimelineEntry {
  date: string;
  balance: number;
}

interface ForecastInvoiceEntry {
  card_id: string;
  card_name: string;
  dateStr: string;
  amount: number;
  status: string;
}

interface ForecastResponse {
  timeline: ForecastTimelineEntry[];
  upcomingInvoices: ForecastInvoiceEntry[];
}

export class GenerateForecastUseCase {
  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly invoiceRepository: InvoiceRepository
  ) {}

  async execute(query: ForecastQuery): Promise<ForecastResponse> {
    const { startDate, endDate } = query;

    // 1. Snapshot Atual: Soma de todas as contas (excluindo investimentos)
    const accounts = await this.accountRepository.listAll({
      filter: "type != 'investment'"
    });
    
    let currentBalance = accounts.reduce((total, account) => total + account.initial_balance, 0);

    // 2. Definimos o range de cálculo (sempre partindo de hoje no mínimo para não quebrar o futuro)
    const todayStr = new Date().toISOString().split('T')[0];
    const calcStartDateStr = startDate < todayStr ? startDate : todayStr;
    const startFilter = `${calcStartDateStr} 00:00:00.000Z`;

    // 3. Busca todas as transações relevantes (pendentes, realizadas a partir do início, ou recorrências do mês atual em diante)
    const startOfMonthStr = `${calcStartDateStr.substring(0, 7)}-01 00:00:00.000Z`;
    
    let baseFilter = `(status = 'pending' || realized_date >= '${startFilter}' || (recurrence_id != "" && expected_date >= '${startOfMonthStr}'))`;

    if (query.includeSimulations !== 'true') {
      baseFilter += ` && is_simulated = false`;
    }

    const transactions = await this.transactionRepository.listAll({
      filter: baseFilter
    });

    // 4. Busca Recorrências
    const activeRecurrences = await this.recurrenceRepository.listAll({
      filter: "status = 'active'"
    });

    // 4.5. Busca Faturas Físicas Abertas/Fechadas
    const invoices = await this.invoiceRepository.listAll({
      filter: "status != 'PAID'",
      expand: 'card_id'
    });
    
    const upcomingInvoices: ForecastInvoiceEntry[] = [];

    for (const invoice of invoices) {
      const amountDue = sub(invoice.total_amount, invoice.paid_amount || 0);
      
      if (amountDue > 0) {
        // Obter nome do cartão expandido do SDK do Pocketbase com fallback seguro
        const expandedCard = (invoice as any).expand?.card_id;
        
        upcomingInvoices.push({
          card_id: invoice.card_id,
          card_name: expandedCard?.name || 'Cartão',
          dateStr: invoice.due_date.substring(0, 10),
          amount: amountDue,
          status: invoice.status
        });
      }
    }

    // 5. Rollback: Encontrar o Saldo Inicial verdadeiro no calcStartDateStr
    let runningBalance = currentBalance;
    const realizedSinceStart = transactions.filter(
      t => t.status === 'realized' && t.realized_date! >= startFilter && !t.card_id && !t.is_silent
    );
    for (const txn of realizedSinceStart) {
      if (txn.type === 'income') runningBalance = sub(runningBalance, txn.amount);
      if (txn.type === 'expense') runningBalance = sum(runningBalance, txn.amount);
    }
    
    // 6. Algoritmo de Timeline (Iteração Dia a Dia)
    const timeline: ForecastTimelineEntry[] = [];
    let currentDate = new Date(`${calcStartDateStr}T00:00:00Z`);
    const finalDate = new Date(`${endDate}T00:00:00Z`);

    while (currentDate <= finalDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // 1. TRANSAÇÕES REALIZADAS (Apenas do passado até hoje, baseadas na realized_date)
      if (dateStr <= todayStr) {
        const dailyRealized = transactions.filter(t => 
          t.status === 'realized' && 
          t.realized_date!.startsWith(dateStr) && 
          !t.card_id && !t.is_silent
        );
        for (const txn of dailyRealized) {
          if (txn.type === 'income') runningBalance = sum(runningBalance, txn.amount);
          if (txn.type === 'expense') runningBalance = sub(runningBalance, txn.amount);
        }
      }

      // 2. TRANSAÇÕES PENDENTES (Processadas estritamente a partir de hoje e no futuro)
      if (dateStr >= todayStr) {
        const dailyPending = transactions.filter(t => 
          t.status === 'pending' && 
          t.expected_date.startsWith(dateStr) && 
          !t.card_id
        );
        for (const txn of dailyPending) {
          if (txn.type === 'income') runningBalance = sum(runningBalance, txn.amount);
          if (txn.type === 'expense') runningBalance = sub(runningBalance, txn.amount);
        }
      }
      
      // 3. FATURAS DE CARTÃO DE CRÉDITO (Aplicadas estritamente na data de vencimento)
      const dailyInvoices = upcomingInvoices.filter(i => i.dateStr === dateStr);
      for (const inv of dailyInvoices) {
        runningBalance = sub(runningBalance, inv.amount);
      }

      // 4. SIMULAÇÃO DE RECORRÊNCIAS FUTURAS
      if (dateStr >= todayStr) {
        const dayOfMonth = currentDate.getUTCDate();
        const currentMonthStr = dateStr.substring(0, 7); 
        
        for (const rec of activeRecurrences) {
          if (rec.payday === dayOfMonth) {
            const alreadyLaunched = transactions.some(t => 
              t.recurrence_id === rec.id && 
              ((t.purchase_date && t.purchase_date.startsWith(currentMonthStr)) || t.expected_date.startsWith(currentMonthStr))
            );

            if (!alreadyLaunched) {
              if (rec.type === 'income') runningBalance = sum(runningBalance, rec.amount);
              if (rec.type === 'expense') runningBalance = sub(runningBalance, rec.amount);
            }
          }
        }
      }

      // HIGIENE MATEMÁTICA E INJEÇÃO NA TIMELINE
      timeline.push({
        date: dateStr,
        balance: roundCurrency(runningBalance)
      });

      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return {
      timeline: timeline.filter(t => t.date >= startDate && t.date <= endDate),
      upcomingInvoices: upcomingInvoices
    };
  }
}
