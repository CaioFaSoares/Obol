import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { ForecastQueryDTO, ForecastResponseDTO } from '../schemas/models';

export const forecastRoutes = new Elysia({ prefix: '/api/forecast' })
  .use(pbPlugin)
  .get('/', async ({ query, pb, set }) => {
    try {
      const { startDate, endDate } = query;

      // 1. Snapshot Atual: Soma de todas as contas (excluindo investimentos)
      const accounts = await pb.collection('accounts').getFullList({
        filter: "type != 'investment'"
      });
      
      let currentBalance = accounts.reduce((sum, account) => sum + account.initial_balance, 0);

      // 2. Carga de Futuro: Busca transações pendentes no range especificado
      const startFilter = `${startDate} 00:00:00.000Z`;
      const endFilter = `${endDate} 23:59:59.999Z`;
      
      const pendingTransactions = await pb.collection('transactions').getFullList({
        filter: `status = 'pending' && expected_date >= '${startFilter}' && expected_date <= '${endFilter}'`
      });

      // 3. Algoritmo de Timeline (Iteração Dia a Dia)
      const timeline = [];
      
      let currentDate = new Date(`${startDate}T00:00:00Z`);
      const finalDate = new Date(`${endDate}T00:00:00Z`);

      while (currentDate <= finalDate) {
        // Pega apenas o 'YYYY-MM-DD' em UTC para comparar
        const dateStr = currentDate.toISOString().split('T')[0];
        
        // Filtra as transações que caem EXATAMENTE neste dia
        const dailyTxns = pendingTransactions.filter(txn => 
          txn.expected_date.startsWith(dateStr)
        );

        // Aplica os impactos do dia
        for (const txn of dailyTxns) {
          if (txn.type === 'income') currentBalance += txn.amount;
          if (txn.type === 'expense') currentBalance -= txn.amount;
        }

        // Grava o snapshot do final do dia
        timeline.push({
          date: dateStr,
          balance: currentBalance
        });

        // Avança +1 dia
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }

      return timeline;

    } catch (err: any) {
      set.status = 500;
      return { error: 'Falha ao gerar projeção', details: err.message };
    }
  }, {
    query: ForecastQueryDTO, // Valida entrada
    response: { 
      200: ForecastResponseDTO,
      500: t.Object({ error: t.String(), details: t.Optional(t.String()) })
    } 
  });
