import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { getCurrentMonthBoundaries, calculateClampedDate } from '../../../domain/utils/dateUtils';
import { Transaction } from '../../../domain/entities/Transaction';

export interface ProcessRecurrencesResult {
  success: boolean;
  processed: number;
  skipped: number;
  generatedNames: string[];
  message: string;
  error?: string;
}

export class ProcessMonthlyRecurrencesUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase
  ) {}

  async execute(): Promise<ProcessRecurrencesResult> {
    console.log(`⏳ [CRON] Iniciando varredura de contratos recorrentes...`);
    let processed = 0;
    let skipped = 0;
    const generatedNames: string[] = [];

    try {
      const { startOfMonth, endOfMonth, year, month, lastDay } = getCurrentMonthBoundaries();
      const now = new Date();

      // 1. Busca todos os contratos ativos
      const activeRecurrences = await this.recurrenceRepository.listAll({
        filter: "status = 'active'"
      });

      for (const rec of activeRecurrences) {
        // 2. Verifica se o contrato já expirou
        if (rec.end_date && now > new Date(rec.end_date)) {
          await this.recurrenceRepository.update(rec.id, { status: 'ended' });
          console.log(`⏸️  Contrato [${rec.name}] expirado. Ignorando.`);
          continue;
        }

        // LÓGICA DE PARCELAMENTO FINITO
        let transactionTitle = `${rec.name} - ${month + 1}/${year}`;

        if (rec.total_installments && rec.total_installments > 0) {
          const history = await this.transactionRepository.list({
            page: 1,
            perPage: 1,
            filter: `recurrence_id = '${rec.id}'`
          });
          
          const currentInstallment = history.totalItems + 1;

          if (currentInstallment > rec.total_installments) {
            await this.recurrenceRepository.update(rec.id, { status: 'ended' });
            console.log(`⏸️  Parcelamento [${rec.name}] concluído. Contrato encerrado.`);
            continue; 
          }

          transactionTitle = `${rec.name} - Parcela ${currentInstallment}/${rec.total_installments}`;
        }

        // 3. A Regra de Idempotência: Já geramos essa transação este mês?
        const existingTxns = await this.transactionRepository.listAll({
          filter: `recurrence_id = '${rec.id}' && ( (purchase_date != "" && purchase_date >= '${startOfMonth}' && purchase_date <= '${endOfMonth}') || (purchase_date = "" && expected_date >= '${startOfMonth}' && expected_date <= '${endOfMonth}') )`
        });

        if (existingTxns.length > 0) {
          skipped++;
          continue;
        }

        // Verifica se o usuário pulou manualmente esta competência
        const periodStr = `${year}-${String(month + 1).padStart(2, '0')}`;
        if (rec.skipped_periods && rec.skipped_periods.includes(periodStr)) {
          console.log(`⏸️  Recorrência [${rec.name}] pulada manualmente neste mês (${periodStr}).`);
          skipped++;
          continue;
        }

        // 4. Clamping de Calendário
        const expectedDate = calculateClampedDate(year, month, rec.payday, lastDay);

        // 5. Geração da Transação
        const txnPayload: Partial<Transaction> = {
          title: transactionTitle,
          amount: rec.amount,
          type: rec.type,
          status: 'pending',
          expected_date: expectedDate,
          purchase_date: expectedDate,
          is_recurring: true,
          recurrence_id: rec.id,
          account_id: rec.account_id || undefined,
          card_id: rec.card_id || undefined
        };

        // 5b. Se for cartão de crédito, sincroniza com a fatura física
        if (rec.card_id) {
          const invoice = await this.syncInvoiceUseCase.execute(
            rec.card_id,
            expectedDate,
            rec.amount,
            rec.type
          );
          txnPayload.invoice_id = invoice.id;
          txnPayload.expected_date = invoice.due_date;
        }

        await this.transactionRepository.create(txnPayload);

        processed++;
        generatedNames.push(`${rec.name}`);
        console.log(`✅ Transação gerada: [${rec.name}] para ${expectedDate.split('T')[0]}`);
      }

      console.log(`🏁 [CRON] Varredura concluída: ${processed} criadas | ${skipped} ignoradas.`);
      
      return { 
        success: true, 
        processed,
        skipped,
        generatedNames,
        message: 'Motor de recorrências executado com sucesso.' 
      };

    } catch (error: any) {
      console.error(`❌ [CRON ERROR] Falha no motor de recorrência:`, error);
      return { success: false, error: error.message, processed, skipped, generatedNames, message: 'Falha no motor de recorrência.' };
    }
  }
}
