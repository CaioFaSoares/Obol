Como seu PO, declaro o sprint zero oficialmente concluído com a criação do repositório e da infraestrutura base.

Para chegarmos ao "Done" — o momento em que você vai abrir o app no seu celular e lançar o primeiro gasto real — precisamos de uma ordem de execução cirúrgica. Se pularmos etapas, vamos quebrar a tipagem de ponta a ponta ou reescrever código.

Aqui está o nosso mapa de voo, do banco de dados até o deploy final:

**1.Modelagem de Dados:** PocketBase.

Onde definimos a "física" do nosso sistema.

- [x] Criar script de migração automática JS para PocketBase v0.23+.
- [x] Criar o superusuário admin de forma silenciosa e "Zero-Touch".
- [x] Definir as 6 coleções base: `accounts`, `cards`, `categories`, `recurring_incomes`, `projects`, e `transactions`.
- [x] Garantir as relações no modelo "Pai-Filho" usando two-pass validation e trancar as API Rules (`null`).
    

**2.Fundação do BFF e Tipagem:** ElysiaJS.

O cérebro começa a operar e a expor os primeiros contratos.

*   Conectar o Elysia ao PocketBase usando o SDK oficial do servidor.
    
*   Criar as rotas de CRUD básicas para contas, cartões e projetos.
    
*   Validar as entradas (Payloads) usando o sistema de validação embutido do Elysia (t.Object, t.String, etc.) para gerar os tipos do TypeScript automaticamente.
    

**3.Motor Financeiro:** ElysiaJS.

Implementação da lógica de negócios pesada.

*   **Roteador de Faturas:** Criar a função que avalia a data de uma transação e o "closing\_day" do cartão para decidir em qual fatura o gasto vai cair.
    
*   **Motor de Projeção:** Escrever o endpoint /api/forecast que calcula as receitas e despesas pendentes e devolve um array com o saldo projetado dia a dia.
    
*   **Automação:** Configurar um cron job no Bun/Elysia para rodar de madrugada e "clonar" as transações marcadas como is\_recurring para o mês seguinte.
    

**4.A Ponte e a Infraestrutura Front:** Nuxt 3.

Conectando os mundos e preparando o terreno visual.

*   Importar o Eden Treaty do Elysia para dentro do Nuxt. Essa é a mágica que fará o frontend saber exatamente quais rotas existem no BFF e qual o formato dos dados.
    
*   Configurar o Nuxt UI (tema, cores base).
    
*   Instalar e configurar o vue-echarts para o gráfico de projeção.
    
*   Adicionar o plugin client-side da biblioteca pretext para garantir o controle tipográfico responsivo sem quebrar a hidratação (SSR).
    

**5.Estado Global e Componentes Base:** Nuxt 3 + Pinia.

Preparando o cache de dados para atrito zero.

*   Criar stores no Pinia para manter os saldos das contas em cache.
    
*   Criar o componente "Global Fab" (Floating Action Button) ou atalho de teclado que abre o **Modal Rápido de Lançamentos** de qualquer lugar do app.
    
*   Desenhar o formulário de lançamento com os selects puxando cartões e contas do backend.
    

**6.As Telas Principais:** Nuxt 3.

Construindo as views que você vai usar todo dia.

*   **Dashboard:** Implementar o gráfico da linha do tempo (vue-echarts) e os cards indicando o "Caixa Atual" e "Previsão Fim do Mês".
    
*   **Projetos & Freelas:** A tela de gestão "pai-filho", onde você vê o valor total de um freela e pode adicionar um recebimento parcial com um clique.
    
*   **Potes & Orçamentos:** A interface visual que mostra quanto limite ainda resta no seu orçamento de "Jantares" ou "Remédios".
    

**7.Polimento e Deploy:**

O ajuste final antes de ir para a vida real.

*   Auditoria de responsividade (garantir que o dashboard e os modais funcionam perfeitamente na tela do seu celular).
    
*   Tratamento de erros: Adicionar toasts do Nuxt UI quando a rede falha ou a API do Elysia recusa algo.
    
*   Ajustar as variáveis de ambiente (.env) e rodar o docker-compose up -d na sua máquina de produção (NixOS/Coolify).
    

O projeto atinge a definição de "Done" para a versão 1.0 no exato momento em que você concluir a Etapa 7 e conseguir registrar o seu primeiro gasto do dia a dia diretamente pelo celular, alimentando o gráfico de projeção.