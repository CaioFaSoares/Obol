import type PocketBase from 'pocketbase';
import { syncInvoice } from './invoiceService';
import { sum, sub } from '../utils/mathUtils';

interface ReconciliationReport {
  orphansFixed: number;
  orphanDetails: string[];
  invoicesRecalculated: number;
  invoiceDetails: string[];
  skippedPeriodsCleaned: number;
}

/**
 * Motor de Auto-Reconciliação do Obol.
 * 
 * Detecta e corrige inconsistências relacionais causadas por manipulação
 * direta no banco de dados ou bugs anteriores. Deve ser executado ANTES
 * do motor de recorrências para garantir um estado limpo.
 */
export async function reconcileInvoices(pb: PocketBase): Promise<ReconciliationReport> {
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

    const orphans = await pb.collection('transactions').getFullList({
      filter: `card_id != "" && (invoice_id = "" || invoice_id = null)`
    });

    for (const txn of orphans) {
      try {
        // Usa purchase_date como referência; fallback para expected_date
        const referenceDate = txn.purchase_date || txn.expected_date;

        if (!referenceDate) {
          console.warn(`⚠️  Transação [${txn.title}] sem data de referência. Pulando.`);
          continue;
        }

        // Descobre/cria a fatura correta usando o mesmo motor do sistema
        const invoice = await syncInvoice(pb, txn.card_id, referenceDate, 0, txn.type);
        // Nota: passamos amount=0 para NÃO somar novamente no total_amount da fatura.
        // A Varredura 2 vai recalcular o total correto logo em seguida.

        // Vincula a transação à fatura encontrada
        const updatePayload: any = {
          invoice_id: invoice.id,
          expected_date: invoice.due_date
        };

        // Salva purchase_date se estava em branco
        if (!txn.purchase_date && txn.expected_date) {
          updatePayload.purchase_date = txn.expected_date;
        }

        await pb.collection('transactions').update(txn.id, updatePayload);

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

    const invoices = await pb.collection('invoices').getFullList({
      filter: `status = 'OPEN' || status = 'CLOSED'`
    });

    for (const invoice of invoices) {
      try {
        // Busca TODAS as transações vinculadas a esta fatura
        const txns = await pb.collection('transactions').getFullList({
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

        if (diff > 0.01) { // Tolerância de 1 centavo para floating point
          await pb.collection('invoices').update(invoice.id, {
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

    const recurrences = await pb.collection('recurrences').getFullList({
      filter: `status = 'active'`
    });

    for (const rec of recurrences) {
      if (!rec.skipped_periods || rec.skipped_periods.length === 0) continue;

      const freshPeriods = rec.skipped_periods.filter((p: string) => p >= cutoffPeriod);

      if (freshPeriods.length < rec.skipped_periods.length) {
        const removed = rec.skipped_periods.length - freshPeriods.length;
        await pb.collection('recurrences').update(rec.id, {
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
