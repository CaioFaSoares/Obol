import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { monthKey, startOfUtcMonth, addUtcMonths } from '../../../domain/utils/dateUtils';
import { roundCurrency, sum } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

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
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      orphansFixed: 0,
      orphanDetails: [],
      invoicesRecalculated: 0,
      invoiceDetails: [],
      skippedPeriodsCleaned: 0
    };

    // Sweep 1: card transactions without an invoice. Their amount is not in
    // any invoice yet, so attaching them charges the resolved invoice once.
    const transactions = await this.transactionRepository.listAll();
    const orphans = transactions.filter(
      txn => txn.card_id && !txn.invoice_id && txn.is_simulated !== true
    );

    for (const txn of orphans) {
      const referenceDate = txn.purchase_date || txn.expected_date;
      if (!referenceDate) continue;

      const invoice = await this.syncInvoiceUseCase.execute(
        txn.card_id as string,
        referenceDate,
        txn.amount,
        txn.type
      );

      const updatePayload: Partial<typeof txn> = {
        invoice_id: invoice.id,
        expected_date: invoice.due_date
      };
      if (!txn.purchase_date) updatePayload.purchase_date = txn.expected_date;

      await this.transactionRepository.update(txn.id, updatePayload);

      report.orphansFixed += 1;
      report.orphanDetails.push(`${txn.title} -> invoice ${invoice.period}`);
    }

    // Sweep 2: recompute OPEN/CLOSED invoice totals from their children.
    const currentTransactions = await this.transactionRepository.listAll();
    const invoices = await this.invoiceRepository.listAll();
    for (const invoice of invoices) {
      if (invoice.status !== 'OPEN' && invoice.status !== 'CLOSED') continue;

      const children = currentTransactions.filter(txn => txn.invoice_id === invoice.id);

      let calculatedTotal = 0;
      for (const txn of children) {
        if (txn.type === 'expense') calculatedTotal = sum(calculatedTotal, txn.amount);
        if (txn.type === 'income') calculatedTotal = sum(calculatedTotal, -txn.amount);
      }

      const currentTotal = invoice.total_amount;
      if (Math.abs(currentTotal - calculatedTotal) > 0.01) {
        await this.invoiceRepository.update(invoice.id, {
          total_amount: calculatedTotal
        });
        report.invoicesRecalculated += 1;
        report.invoiceDetails.push(
          `Invoice ${invoice.period}: ${roundCurrency(currentTotal).toFixed(2)} -> ${roundCurrency(calculatedTotal).toFixed(2)}`
        );
      }
    }

    // Sweep 3: prune skipped periods older than three months. Weekly rows key
    // their skips by day (`YYYY-MM-DD`), so the comparison uses the month
    // prefix of every key and treats both shapes identically.
    const now = new Date(this.clock.now());
    const cutoffPeriod = monthKey(addUtcMonths(startOfUtcMonth(now), -3));

    const recurrences = await this.recurrenceRepository.listAll();
    for (const rec of recurrences) {
      if (rec.status !== 'active') continue;
      if (!rec.skipped_periods || rec.skipped_periods.length === 0) continue;

      const freshPeriods = rec.skipped_periods.filter(
        period => period.slice(0, 7) >= cutoffPeriod
      );
      if (freshPeriods.length < rec.skipped_periods.length) {
        await this.recurrenceRepository.update(rec.id, {
          skipped_periods: freshPeriods
        });
        report.skippedPeriodsCleaned += rec.skipped_periods.length - freshPeriods.length;
      }
    }

    return report;
  }
}
