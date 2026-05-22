## 🗺️ Mapa de Batalha: Projeto Obol

### 🟢 TERRITÓRIO CONQUISTADO (Backend)

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

---

### 🟡 PRÓXIMAS MISSÕES (Frontend & UI/UX)

#### Fase 3: A Ponte Frontend (Nuxt Foundation)
*Onde conectamos o cérebro à interface e preparamos as ferramentas visuais.*
* **PRD 3.1: Inicialização e Eden Treaty:** Setup do Nuxt 3 e importação do tipo App do Elysia para garantir autocomplete perfeito de todas as rotas (RPC).
* **PRD 3.2: Motores Visuais:** Configuração do Nuxt UI (Design System), Vue-ECharts (para a timeline) e Pretext (para responsividade tipográfica Client-Side).
* **PRD 3.3: Cache e Estado:** Configuração do Pinia para armazenar saldos e o array de projeção na memória do navegador, permitindo transições de tela instantâneas.

#### Fase 4: Telas e Fluxos de Usuário
*Onde construímos o aplicativo que você usará no dia a dia.*
* **PRD 4.1: O Dashboard Mestre:** Consumo da rota de forecast e renderização do gráfico principal e dos cards de "Saldo Atual" e "Faturas Abertas".
* **PRD 4.2: O Fast-Entry (Lançamento Rápido):** Um Modal ou Drawer flutuante (FAB) desenhado para você registrar um gasto no cartão em menos de 3 segundos, de qualquer lugar do app.
* **PRD 4.3: Mini-ERP (Gestão de Contratos e Potes):** A tela para gerenciar as "Entidades Pai". Visualizar o progresso de um freela, o limite do pote de jantares e dar "Check" na bolsa do IFCE do mês.

#### Fase 5: Go-Live & Polimento
*A validação final antes de ir para o seu bolso.*
* **PRD 5.1:** Auditoria de usabilidade mobile (Touch targets, responsividade).
* **PRD 5.2:** Preparação do Docker Compose final e deploy produtivo (NixOS/Coolify).