## 🗺️ Mapa de Batalha: Projeto Obol

### 🟢 TERRITÓRIO CONQUISTADO (Backend & Frontend)

* **Sprint 0: Fundação & IaC (100%)**
  * Orquestração em Docker Compose.
  * Migrações declarativas e automáticas do PocketBase.
  * Trava de segurança bloqueando acesso público às APIs.

* **Fase 1: Motor de Negócios (BFF) (100%)**
  * ElysiaJS com validação estrita (TypeBox).
  * Interceptador de Cartão de Crédito (Cálculo de Faturas).
  * Forecast Engine: Algoritmo iterativo de projeção de saldo diário.

* **Fase 2: Motor do Tempo (100%)**
  * Cron Job rodando em thread isolada.
  * Regra de *Clamping* para meses curtos e bissextos.
  * Idempotência matemática garantindo anti-duplicação.

* **Fase 3: A Ponte Frontend (Nuxt Foundation) (100%)**
  * **PRD 3.1: Inicialização e Eden Treaty:** Setup do Nuxt 3 e cliente API 100% tipado.
  * **PRD 3.2: Motores Visuais:** Nuxt UI, Vue-ECharts e Pretext implementados.
  * **PRD 3.3: Cache e Estado:** Pinia operando stores globais de finanças.

* **Fase 4: Telas e Fluxos de Usuário (100%)**
  * **PRD 4.1: O Dashboard Mestre:** Gráfico Forecast e Cards renderizados em `/`.
  * **PRD 4.2: O Fast-Entry:** Componente de Lançamento Rápido acessível via atalho global.
  * **PRD 4.3: Mini-ERP (Gestão):** Tela `/management` com abas modulares para Projetos, Recorrências, Orçamentos e Contas/Cartões.

---

### 🟡 PRÓXIMAS MISSÕES (Ajustes Finais)

#### Fase 5: Go-Live & Polimento
*A validação final antes de ir para o seu bolso.*
* **PRD 5.1:** Auditoria de usabilidade mobile (Touch targets, responsividade).
* **PRD 5.2:** Preparação do Docker Compose final e deploy produtivo (NixOS/Coolify).

---

### 🔮 VISÃO DE FUTURO (Épicos Planejados)

Após a conquista das fundações e do lançamento inicial (Go-Live), o Obol continuará evoluindo. Para não perdermos o foco, organizamos as próximas grandes expansões em Épicos de Produto, mapeando exatamente onde teremos que mexer em cada camada da Tríade.

#### 🛡️ Épico 1: Autenticação e Segurança (O Portão de Entrada)
*O sistema não pode ir para a web (Coolify) sem um cadeado.*
* **O Conceito:** Como o Obol é um software *self-hosted* para uso próprio, precisamos de um fluxo onde a primeira pessoa a acessar o site cria a conta mestre, e a partir daí, o sistema tranca a porta e só aceita login.
* **Banco (PocketBase):** A coleção `users` já existe nativamente. Precisaremos ajustar as *API Rules* para garantir que todas as requisições exijam autenticação.
* **BFF (Elysia):** Criar as rotas `POST /api/auth/setup` (para o primeiro registro) e `POST /api/auth/login`. O BFF devolverá o Token do PocketBase.
* **Frontend (Nuxt):** 
  * Criar uma `pages/login.vue` isolada.
  * Criar um Nuxt Middleware (`middleware/auth.global.ts`) que intercepta qualquer navegação. Se não houver token no cache/cookie, redireciona para a tela de login.

#### 💳 Épico 2: Gestão Avançada de Caixa e Cenários
*A inteligência de faturas e o poder de prever o futuro.*

**1. A Gestão de Cartões e Pagamento de Fatura**
* **O Conceito:** Uma aba dedicada para faturas. Ao "Pagar a Fatura", o sistema pega o dinheiro da Conta e "zera" o saldo negativo do cartão, iniciando o próximo ciclo.
* **Banco:** Não precisamos de tabelas novas! Pagar a fatura é simplesmente uma transferência (PRD 4.4) onde a origem é a sua Conta e o destino é o seu Cartão de Crédito.
* **BFF:** Uma rota específica para buscar as transações de um cartão separadas por "mês de fechamento".
* **Frontend:** Uma nova tela (`pages/cards.vue`). Lá você seleciona o cartão (ex: Nubank), vê a lista de gastos daquela fatura, pode editar um lançamento específico, e clica no botão gigante "Pagar Fatura com Conta X".

**2. O Master Ledger (Todos os Lançamentos) e Modo Simulação**
* **O Conceito:** Uma tabela com filtro absoluto (passado, presente e futuro). Criaremos o conceito de *Transação Simulada* para testar cenários (ex: "se eu comprar esse remédio de R$ 160 mês que vem?").
* **Banco:** Uma leve Migration V4 para adicionar a coluna booleana `is_simulated` (default: false) na tabela de transações.
* **BFF:** O motor de Forecast será atualizado para receber um parâmetro `?includeSimulations=true|false`.
* **Frontend:** Uma tela `pages/ledger.vue`. Nela você cadastra a despesa futura e marca "Apenas Simulação". No Dashboard principal, um *Toggle* "Mostrar simulações no gráfico". Ligando a chave, a linha do gráfico reflete o gasto simulado. Desligando, ela volta ao normal. Quando o gasto for real, basta editar tirando o status de simulação.

**3. Módulo de Investimentos (Semente para o Futuro)**
* **O Conceito:** Separar o dinheiro do dia a dia (contas) do patrimônio de longo prazo (renda fixa, ações).
* **Banco:** Criaremos, no futuro, as coleções `portfolios` (as corretoras/caixinhas) e `portfolio_transactions` (aportes e rendimentos).
* **BFF & Frontend:** Rotas separadas para não poluir o saldo da conta corrente. Um gráfico de crescimento passivo exclusivo para acompanhar o efeito dos juros compostos.