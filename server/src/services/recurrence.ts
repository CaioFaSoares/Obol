import type PocketBase from 'pocketbase';
import { getCurrentMonthBoundaries, calculateClampedDate } from '../utils/dateUtils';
import { syncInvoice } from './invoiceService';

export async function processMonthlyRecurrences(pb: PocketBase) {
  console.log(`⏳ [CRON] Iniciando varredura de contratos recorrentes...`);
  let processed = 0;
  let skipped = 0;
  const generatedNames: string[] = [];

  try {
    const { startOfMonth, endOfMonth, year, month, lastDay } = getCurrentMonthBoundaries();
    const now = new Date();

    // 1. Busca todos os contratos (bolsas, salários, assinaturas) ativos
    const incomes = await pb.collection('recurrences').getFullList({
      filter: "status = 'active'"
    });

    for (const income of incomes) {
      // 2. Verifica se a bolsa/contrato já expirou
      if (income.end_date && now > new Date(income.end_date)) {
        // Atualiza status para 'ended' no banco para não processar mais
        await pb.collection('recurrences').update(income.id, { status: 'ended' });
        console.log(`⏸️  Contrato [${income.name}] expirado. Ignorando.`);
        continue;
      }

      // LÓGICA DE PARCELAMENTO FINITO
      let transactionTitle = `${income.name} - ${month + 1}/${year}`; // Título padrão

      if (income.total_installments && income.total_installments > 0) {
        // Utilizamos o getList(1, 1) do PocketBase pois ele devolve o totalItems de forma muito mais rápida
        const history = await pb.collection('transactions').getList(1, 1, {
          filter: `recurrence_id = '${income.id}'`
        });
        
        const currentInstallment = history.totalItems + 1;

        // Se a parcela atual ultrapassar o total acordado, desativamos o contrato e abortamos
        if (currentInstallment > income.total_installments) {
          await pb.collection('recurrences').update(income.id, { status: 'ended' });
          console.log(`⏸️  Parcelamento [${income.name}] concluído. Contrato encerrado.`);
          continue; 
        }

        // Formata o título de forma elegante: "Computador - Parcela 2/10"
        transactionTitle = `${income.name} - Parcela ${currentInstallment}/${income.total_installments}`;
      }

      // 3. A Regra de Idempotência: Já geramos essa transação este mês?
      const existingTxns = await pb.collection('transactions').getFullList({
        filter: `recurrence_id = '${income.id}' && expected_date >= '${startOfMonth}' && expected_date <= '${endOfMonth}'`,
        $cancelKey: `check_${income.id}` // Evita cancelamento automático de requests paralelos pelo SDK do PB
      });

      if (existingTxns.length > 0) {
        skipped++;
        continue; // Já existe! Pula pro próximo sem duplicar.
      }

      // 4. Clamping de Calendário (Garante que dia 31 em Fev vire dia 28/29)
      const expectedDate = calculateClampedDate(year, month, income.payday, lastDay);

      // 5. Geração da Transação
      const txnPayload: any = {
        title: transactionTitle,
        amount: income.amount,
        type: income.type,
        status: 'pending',
        expected_date: expectedDate,
        is_recurring: true,
        recurrence_id: income.id,
        account_id: income.account_id || null,
        card_id: income.card_id || null
      };

      // 5b. Se for cartão de crédito, sincroniza com a fatura física
      if (income.card_id) {
        const invoice = await syncInvoice(pb, income.card_id, expectedDate, income.amount, income.type);
        txnPayload.invoice_id = invoice.id;
        txnPayload.expected_date = invoice.due_date; // Usa a data de vencimento da fatura
      }

      await pb.collection('transactions').create(txnPayload);

      processed++;
      generatedNames.push(`${income.name}`);
      console.log(`✅ Transação gerada: [${income.name}] para ${expectedDate.split('T')[0]}`);
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
    return { success: false, error: error.message };
  }
}
