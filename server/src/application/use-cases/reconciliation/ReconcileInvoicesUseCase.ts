import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { sum, sub } from '../../../domain/utils/mathUtils';

interface ReconciliationReport {
  orphansFixed: number;
  orphanDetails: string[];
  invoicesRecalculated: number;
  invoiceDetails: string[];
  skippedPeriodsCleaned: number;
}

export class ReconcileInvoicesUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase
  ) {}

  async execute(): Promise<ReconciliationReport> {
    console.log(`🔧 [RECONCILIAÇÃO] Iniciando varredura de integridade...`);

    const report: ReconciliationReport = {
      orphansFixed: 0,
      orphanDetails: [],
      invoicesRecalculated: 0,
      invoiceDetails: [],
      skippedPeriodsCleaned: 0
    };

    try {
      // =========================================================================
      // VARREDURA 1: Transações Órfãs (têm card_id mas invoice_id vazio)
      // =========================================================================
      console.log(`🔍 [VARREDURA 1] Buscando transações órfãs...`);

      const orphans = await this.transactionRepository.listAll({
        filter: `card_id != "" && (invoice_id = "" || invoice_id = null)`
      });

      for (const txn of orphans) {
        try {
          const referenceDate = txn.purchase_date || txn.expected_date;

          if (!referenceDate) {
            console.warn(`⚠️  Transação [${txn.title}] sem data de referência. Pulando.`);
            continue;
          }

          // Descobre/cria a fatura correta usando o mesmo motor do sistema
          const invoice = await this.syncInvoiceUseCase.execute(txn.card_id!, referenceDate, 0, txn.type);

          // Vincula a transação à fatura encontrada
          const updatePayload: any = {
            invoice_id: invoice.id,
            expected_date: invoice.due_date
          };

          if (!txn.purchase_date && txn.expected_date) {
            updatePayload.purchase_date = txn.expected_date;
          }

          await this.transactionRepository.update(txn.id, updatePayload);

          report.orphansFixed++;
          report.orphanDetails.push(`${txn.title} → Fatura ${invoice.period}`);
          console.log(`✅ Órfã curada: [${txn.title}] vinculada à fatura ${invoice.period}`);
        } catch (err: any) {
          console.error(`❌ Falha ao reconciliar órfã [${txn.title}]:`, err.message);
        }
      }

      // =========================================================================
      // VARREDURA 2: Recalcular Totais de Faturas (OPEN ou CLOSED)
      // =========================================================================
      console.log(`🔍 [VARREDURA 2] Verificando totais de faturas...`);

      const invoices = await this.invoiceRepository.listAll({
        filter: `status = 'OPEN' || status = 'CLOSED'`
      });

      for (const invoice of invoices) {
        try {
          // Busca TODAS as transações vinculadas a esta fatura
          const txns = await this.transactionRepository.listAll({
            filter: `invoice_id = '${invoice.id}'`
          });

          // Recalcula o total a partir do zero
          let calculatedTotal = 0;
          for (const txn of txns) {
            if (txn.type === 'expense') {
              calculatedTotal = sum(calculatedTotal, txn.amount);
            } else if (txn.type === 'income') {
              calculatedTotal = sub(calculatedTotal, txn.amount);
            }
          }

          // Compara com o valor salvo na fatura
          const currentTotal = invoice.total_amount;
          const diff = Math.abs(currentTotal - calculatedTotal);

          if (diff > 0.01) {
            await this.invoiceRepository.update(invoice.id, {
              total_amount: calculatedTotal
            });

            report.invoicesRecalculated++;
            report.invoiceDetails.push(
              `Fatura ${invoice.period}: R$ ${currentTotal.toFixed(2)} → R$ ${calculatedTotal.toFixed(2)} (Δ ${diff.toFixed(2)})`
            );
            console.log(`🔄 Fatura ${invoice.period} recalculada: ${currentTotal} → ${calculatedTotal}`);
          }
        } catch (err: any) {
          console.error(`❌ Falha ao recalcular fatura ${invoice.period}:`, err.message);
        }
      }

      // =========================================================================
      // VARREDURA 3: Limpeza de skipped_periods antigos (> 3 meses)
      // =========================================================================
      console.log(`🔍 [VARREDURA 3] Limpando skipped_periods obsoletos...`);

      const now = new Date();
      const threeMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
      const cutoffPeriod = `${threeMonthsAgo.getUTCFullYear()}-${String(threeMonthsAgo.getUTCMonth() + 1).padStart(2, '0')}`;

      const recurrences = await this.recurrenceRepository.listAll({
        filter: `status = 'active'`
      });

      for (const rec of recurrences) {
        if (!rec.skipped_periods || rec.skipped_periods.length === 0) continue;

        const freshPeriods = rec.skipped_periods.filter((p: string) => p >= cutoffPeriod);

        if (freshPeriods.length < rec.skipped_periods.length) {
          const removed = rec.skipped_periods.length - freshPeriods.length;
          await this.recurrenceRepository.update(rec.id, {
            skipped_periods: freshPeriods
          });
          report.skippedPeriodsCleaned += removed;
          console.log(`🧹 Recorrência [${rec.name}]: ${removed} período(s) antigo(s) limpo(s)`);
        }
      }

      console.log(`🏁 [RECONCILIAÇÃO] Concluída: ${report.orphansFixed} órfãs curadas | ${report.invoicesRecalculated} faturas recalculadas | ${report.skippedPeriodsCleaned} períodos limpos`);

      return report;

    } catch (error: any) {
      console.error(`❌ [RECONCILIAÇÃO ERROR] Falha crítica:`, error);
      throw error;
    }
  }
}
