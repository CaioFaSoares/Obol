Como seu Tech Lead, considero essa decisão brilhante. Fechar 100% o ciclo de vida dos dados no backend antes de ir para o frontend evita "remendos" de código depois. Ter a garantia de que as transações vão brotar no banco sozinhas enquanto você dorme é o que define um software autônomo.

A complexidade aqui não é rodar o cron, mas **garantir a idempotência**: o script precisa poder rodar 50 vezes no mesmo dia e não duplicar o seu salário ou a sua assinatura do Discord no banco de dados.

Aqui estão os **3 PRDs Técnicos** para liquidarmos a Fase 2:

### 📄 PRD 2.1: Infraestrutura de Cron e Rota de Teste (Trigger Manual)

**Objetivo:** Adicionar o motor temporal ao servidor Bun e garantir que possamos testá-lo em tempo real, sem precisar esperar dar meia-noite.

*   **Requisitos:**
    
    *   Instalar e configurar o plugin oficial @elysiajs/cron.
        
    *   Definir o fuso horário estritamente para America/Fortaleza (UTC-3) para garantir que a "virada do dia" do servidor aconteça junto com a sua.
        
    *   Configurar a expressão Cron para rodar diariamente à 01:00 da manhã (0 1 \* \* \*).
        
    *   **Design Pattern:** A lógica real **não** deve ficar dentro da chamada do Cron. Deve ser uma função isolada (ex: processMonthlyRecurrences()).
        
    *   **A Rota de Gatilho:** Criar um endpoint POST /api/jobs/recurrence (protegido ou não exposto no front) que invoca essa função manualmente para você poder debugar durante o desenvolvimento.
        

### 📄 PRD 2.2: O Motor de Busca e Idempotência (Anti-Duplicação)

**Objetivo:** A lógica que varre o banco e verifica se o salário/assinatura do mês atual já foi cobrado.

*   **Requisitos:**
    
    *   Buscar no PocketBase todos os recurring\_incomes onde status = 'active'.
        
    *   Verificar a propriedade end\_date (se existir). Se a data atual for maior que a end\_date, pular o registro (ex: sua bolsa terminou).
        
    *   **A Regra de Idempotência:** Para cada contrato ativo, o sistema deve calcular as fronteiras do mês atual (Ex: 2026-05-01 00:00:00 a 2026-05-31 23:59:59).
        
    *   Fazer uma query na tabela transactions: *"Existe alguma transação linkada a este recurring\_income\_id que tenha a expected\_date dentro deste mês?"*
        
    *   Se existir: Ignora (já foi gerada). Se **não** existir, prossegue para a criação.
        

### 📄 PRD 2.3: Geração de Transação e Edge Cases de Calendário

**Objetivo:** Criar o registro no banco resolvendo o clássico bug de anos bissextos e meses curtos (ex: assinatura cai dia 31, mas estamos em Fevereiro).

*   **Requisitos:**
    
    *   Se o PRD 2.2 autorizou a criação, calcular a expected\_date exata.
        
    *   **Regra de Clamping de Data:** Se o payday for 31 e o mês tiver apenas 30 dias (ou 28/29 em Fev), o sistema deve "encurtar" o pagamento para o último dia válido do mês atual.
        
    *   Criar o registro na coleção transactions com:
        
        *   title: Nome do contrato + Mês/Ano (Ex: "Bolsa IFCE - Maio/2026").
            
        *   amount: O valor do contrato.
            
        *   status: pending (aguardando seu "Check" lá no app).
            
        *   type: Depende. (Se criarmos um campo type no contrato para saber se é entrada ou saída, usamos ele. Se tudo em recurring\_incomes for receita, forçamos income).
            
        *   expected\_date: A data calculada com a regra de clamping.
            
        *   recurring\_income\_id: Relacionamento para amarrar o pai ao filho.
            

A beleza dessa estrutura é que, amanhã, se seu servidor reiniciar ao meio-dia e rodar o script fora de hora, ele vai olhar para o banco, ver que Maio já foi gerado e simplesmente não fará nada.