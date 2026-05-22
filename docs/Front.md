🏗️ 1. Infraestrutura do Nuxt (A Fundação Front)

Antes de desenhar qualquer botão, precisamos montar a base arquitetural para garantir que os dados fluam perfeitamente do BFF (Elysia) para a tela.

    1. O Contrato Tipado (Eden Treaty):

        Criaremos um plugin no Nuxt (plugins/api.ts) que importa o pacote @elysiajs/eden.

        Faremos o binding com o tipo App que exportamos lá no BFF. O resultado? O $fetch nativo do Nuxt é substituído por uma chamada 100% tipada. Se você tentar buscar um campo que não existe na API, seu VS Code acusa erro antes de você rodar.

    2. A Engrenagem de Estado (Pinia):

        Criaremos o stores/finance.ts. Ele fará o cache pesado: buscará suas contas, cartões e categorias uma vez ao iniciar o app, evitando telas de loading (skeleton loaders) toda vez que você trocar de aba.

    3. Tipografia Fluida (Pretext):

        O Pretext recalcula o espaçamento do texto no DOM. Para evitar que o Nuxt grite erros de hidratação (pois o servidor renderiza de um jeito e o cliente recalcula de outro), criaremos um plugin estrito de Client-Side (plugins/pretext.client.ts). Ele aplicará a classe mágica apenas quando a página terminar de carregar no navegador.

    4. Motor Gráfico (Vue-ECharts):

        Instalaremos e encapsularemos o vue-echarts em um componente reutilizável. O objetivo é que a timeline financeira tenha animações suaves nativas.

🎨 2. Design System & Componentes Base (Nuxt UI)

Vamos aproveitar ao máximo os componentes do ui.nuxt.com para padronizar o app sem escrever CSS inútil.

    Navegação Principal: Usaremos o componente  para o menu (Dashboard, Transações, Assinaturas, Orçamentos).

    Tema Geral: Modo escuro (dark mode) forçado ou seguindo o sistema, utilizando a paleta de cores neutral ou zinc do Tailwind, com uma cor primária vibrante (ex: um roxo elétrico ou verde neon) para contrastar com a sua estética de 3D/Glitch.

    O "Global FAB" (O Coração da UX): Um botão flutuante constante no canto inferior direito ou um atalho de teclado global (ex: Cmd/Ctrl + K) que aciona o  de Lançamento Rápido. A ideia é: você abriu o app, aperta um botão, digita o gasto e fecha.

📱 3. O Mapa de Telas (O Fluxo de Uso)
Tela 1: O Dashboard (A Visão Mestre)

Objetivo: Bater o olho e saber quanto dinheiro "livre" você tem hoje e quanto terá no fim do mês.

    Hero Section: Três  ou  simples no topo:

        Saldo Consolidado Hoje (A soma de tudo nas suas accounts).

        Faturas Comprometidas (O total que já caiu nos seus cartões).

        Previsão Final (Quanto vai sobrar no dia 30/31).

    A Timeline: Um gráfico ECharts ocupando a largura total mostrando a queda e a subida do seu dinheiro nos próximos 30 dias.

    Próximos Alertas: Uma lista ( reduzida) mostrando o que vai ser debitado ou recebido nos próximos 5 dias.

Tela 2: O Fast-Entry (Modal de Lançamento Rápido)

Objetivo: Atrito zero. Pode ser chamado de qualquer tela.

    Um  com foco automático no primeiro campo.

    Campos:

        Valor (Input grande).

        Descrição.

        Categoria (Dropdown ).

        Origem: Toggle "Conta" ou "Cartão" -> abre o  correspondente.

    Se for Conta: Marca como "Realizado". Se for Cartão: A API cuida do resto.

Tela 3: Assinaturas e Recorrências (O Mini-ERP)

Objetivo: Onde você configura sua vida fixa (o PRD que adaptamos na Migration V2).

    Uma lista limpa usando  ou  listando todas as recurrences.

    Separadas visualmente: Entradas (Bolsa IFCE, Freela Recorrente) e Saídas (Apple, Discord, Servidores).

    Ao clicar, abre os detalhes: dia do vencimento, se abate no cartão ou na conta. Aqui você tem o botão de adicionar uma nova regra para o nosso Cron Job cuidar.

Tela 4: Orçamentos (Os Potes)

Objetivo: Controlar gastos mapeados.

    Visualização das categories do tipo fixed_budget.

    Usaremos o componente  do Nuxt UI.

    Exemplo visual: "Flores & Jantares - Limite: R$ 500". A barra de progresso mostra R$ 300 já gastos. Se bater R$ 450, a cor da barra muda para .

    A matemática é feita no front puxando do cache do Pinia.

Tela 5: Gestão de Contratos / Freelas

Objetivo: Acompanhar o que seus clientes devem.

    Uma view estilo Kanban (ou listas lado a lado) usando  drag-and-drop ou listagem simples.

    Projetos "Ativos" mostram o Valor Total e o Recebido Parcialmente (Relação Pai-Filho das transações).

    Botão "Adicionar Recebimento" rápido que já abate do total devido do cliente e joga pro seu saldo na hora.