# 🗺️ Mapa Atualizado do Projeto Obol

## ✅ FASES CONCLUÍDAS (O Alicerce e o Cérebro)

### Sprint 0: Fundação & IaC (✅ 100%)
- **Docker Compose** orquestrando as redes.
- **PocketBase** persistente com Admin via `.env`.
- **Migrations** automáticas rodando (DDL) e travando a segurança pública (Regras de API restritas).

### Fase 1: Motor de Negócios BFF (✅ 100%)
- **ElysiaJS** rodando no Bun conectado via SDK com top-level await.
- **Tipagem estrita** E2E configurada (DTOs no TypeBox).
- **Interceptador de Transações** (Regras de cartão e saldo em tempo real).
- **A Joia da Coroa**: O Forecast Engine gerando a linha do tempo matemática diária.

---

## ⏳ FASES PENDENTES (O Tempo e a Interface)

### Fase 2: O Motor do Tempo (Automação)
*O cérebro já sabe calcular o futuro, mas precisa saber virar o mês sozinho.*
- **Cron Job**: Implementar um agendador interno no Elysia (ex: rodando toda madrugada).
- **Gerador de Recorrência**: O script varre as bolsas, salários e assinaturas ativas (`recurring_incomes`) e cria as transações pendentes automaticamente para o mês corrente, caso ainda não existam.

### Fase 3: A Ponte Frontend (Nuxt 3 Foundation)
*Conectando os mundos e preparando as ferramentas visuais.*
- **Setup Inicial**: Iniciar o Nuxt 3 e plugar o Eden Treaty usando o tipo `App` exportado pelo Elysia.
- **Ferramentas Base**: Instalar o Nuxt UI para componentes, `vue-echarts` para renderizar nossa projeção, e configurar o `pretext` no client-side para responsividade tipográfica.
- **Estado Global**: Criar a store do Pinia para armazenar saldos e faturas em cache, garantindo navegação instantânea.

### Fase 4: Telas e Fluxos (A Experiência)
*A interface de atrito zero para o seu dia a dia.*
- **Dashboard Mestre**: A tela principal consumindo a rota de Forecast e desenhando o ECharts com o seu saldo projetado.
- **O "Fast-Entry"**: Modal acessível globalmente (atalho ou FAB) para registrar um gasto em menos de 3 segundos.
- **Gestão de Potes & Contratos**: Telas para você dar "Check" na sua bolsa do IFCE, receber seus freelas e monitorar quanto sobrou do orçamento de jantares.

### Fase 5: Go-Live
*Auditoria e deploy final.*
- **Revisão de responsividade** mobile (UX no celular).
- **Ajustes finais** no Coolify/NixOS para o uso diário real.