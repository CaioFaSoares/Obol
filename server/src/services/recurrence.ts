import type PocketBase from 'pocketbase';
import { getCurrentMonthBoundaries, calculateClampedDate } from '../utils/dateUtils';

export async function processMonthlyRecurrences(pb: PocketBase) {
  console.log(`⏳ [CRON] Iniciando varredura de contratos recorrentes...`);
  let processed = 0;
  let skipped = 0;

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
      await pb.collection('transactions').create({
        title: `${income.name} - ${month + 1}/${year}`,
        amount: income.amount,
        type: income.type, // Agora ele sabe se a internet é despesa e a bolsa é receita
        status: 'pending',
        expected_date: expectedDate,
        is_recurring: true,
        recurrence_id: income.id,
        account_id: income.account_id || null, // Se for Pix/Débito automático
        card_id: income.card_id || null        // Se for a Apple caindo no cartão
      });

      processed++;
      console.log(`✅ Transação gerada: [${income.name}] para ${expectedDate.split('T')[0]}`);
    }

    console.log(`🏁 [CRON] Varredura concluída: ${processed} criadas | ${skipped} ignoradas.`);
    
    return { 
      success: true, 
      processed,
      skipped,
      message: 'Motor de recorrências executado com sucesso.' 
    };

  } catch (error: any) {
    console.error(`❌ [CRON ERROR] Falha no motor de recorrência:`, error);
    return { success: false, error: error.message };
  }
}
