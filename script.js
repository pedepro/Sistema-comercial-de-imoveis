document.addEventListener("DOMContentLoaded", function () {
    const menuToggle = document.querySelector(".menu-toggle");
    const sidebar = document.querySelector(".sidebar");
    const imoveisLink = document.getElementById("imoveis-link");
    const clientesLink = document.getElementById("clientes-link");
    const imoveisContainer = document.getElementById("imoveis-container");
    const clientesContainer = document.createElement("div"); // Criando container para clientes
    clientesContainer.id = "clientes-container";
    clientesContainer.classList.add("container");
    clientesContainer.style.display = "none"; // Inicialmente escondido
    document.querySelector(".main-content").appendChild(clientesContainer);

    // Alternar visibilidade do sidebar
    menuToggle.addEventListener("click", function () {
        sidebar.classList.toggle("open");
    });

    // Fechar sidebar ao clicar em "Imóveis"
    imoveisLink.addEventListener("click", function () {
        sidebar.classList.remove("open");
        imoveisContainer.style.display = "flex"; // Exibir imóveis
        clientesContainer.style.display = "none"; // Esconder clientes
    });

    // Alternar para exibição de clientes ao clicar em "Leads (Clientes)"
    clientesLink.addEventListener("click", function () {
        sidebar.classList.remove("open");
        clientesContainer.style.display = "flex"; // Exibir clientes
        imoveisContainer.style.display = "none"; // Esconder imóveis
        carregarClientes();
    });

    async function carregarImoveis() {
        try {
            const response = await fetch("http://localhost:3000/list-imoveis");
            const data = await response.json();
            const imoveis = Array.isArray(data) ? data : data.imoveis || [];
        
            imoveisContainer.innerHTML = ""; // Limpa antes de adicionar os imóveis
        
            imoveis.forEach(imovel => {
                const card = document.createElement("div");
                card.classList.add("card");
        
                const imagem = imovel.imagens.length > 0 
                    ? imovel.imagens[0] 
                    : "https://source.unsplash.com/400x300/?house";
        
                // Define a URL base estaticamente e adiciona o id como parâmetro, incluindo explicitamente o index.html
                const detalhesUrl = "http://127.0.0.1:5500/detalhes/index.html?id=" + imovel.id;
        
                card.innerHTML = `
                    <img src="${imagem}" alt="Imóvel">
                    <h2>${imovel.texto_principal}</h2>
                    <p>${imovel.quartos} quartos, ${imovel.banheiros} banheiros, ${imovel.metros_quadrados}m²</p>
                    <p>R$ ${imovel.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                    <button class="btn-detalhes" onclick="window.location.href='${detalhesUrl}'">
                        Ver Detalhes
                    </button>
                `;
        
                imoveisContainer.appendChild(card);
            });
        } catch (error) {
            console.error("Erro ao carregar imóveis:", error);
        }
    }
    
    

    async function carregarClientes() {
        try {
            const response = await fetch("http://localhost:3000/list-clientes");
            const data = await response.json();
            const clientes = Array.isArray(data) ? data : data.clientes || [];
    
            clientesContainer.innerHTML = ""; // Limpa antes de adicionar os clientes
    
            clientes.forEach(cliente => {
                const card = document.createElement("div");
                card.classList.add("card-cliente");
    
                card.innerHTML = `
                    <h2>${cliente.nome}</h2>
                    <p><strong>Interesse:</strong> ${cliente.interesse}</p>
                    <p><strong>Tipo:</strong> ${cliente.tipo_imovel}</p>
                    <p><strong>Valor desejado:</strong> R$ ${cliente.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                    <p><strong>WhatsApp:</strong> ${cliente.whatsapp}</p>
                    <button class="btn-detalhes" onclick="window.location.href='cliente.html?id=${cliente.id}'">
                        Ver Detalhes
                    </button>
                `;
                clientesContainer.appendChild(card);
            });
        } catch (error) {
            console.error("Erro ao carregar clientes:", error);
        }
    }

    carregarImoveis(); // Carregar imóveis ao iniciar
});
