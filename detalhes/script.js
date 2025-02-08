document.addEventListener("DOMContentLoaded", async () => {
    const params = new URLSearchParams(window.location.search);
    const imovelId = params.get("id");

    if (!imovelId) {
        document.getElementById("detalhes-imovel").innerHTML = "<p>Imóvel não encontrado.</p>";
        return;
    }

    try {
        const response = await fetch(`http://localhost:3000/get-imovel/${imovelId}`);
        const imovel = await response.json();

        if (!imovel.id) {
            document.getElementById("detalhes-imovel").innerHTML = "<p>Imóvel não encontrado.</p>";
            return;
        }

        document.getElementById("titulo-imovel").textContent = imovel.texto_principal;

        document.getElementById("detalhes-imovel").innerHTML = `
            <div class="imovel-detalhes">
                <img src="${imovel.imagens[0] || 'https://source.unsplash.com/600x400/?house'}" alt="Imagem do imóvel">
                <h2>${imovel.texto_principal}</h2>
                <p><strong>Tipo:</strong> ${imovel.tipo}</p>
                <p><strong>Endereço:</strong> ${imovel.endereco}</p>
                <p><strong>Descrição:</strong> ${imovel.descricao}</p>
                <p><strong>Quartos:</strong> ${imovel.quartos}</p>
                <p><strong>Banheiros:</strong> ${imovel.banheiros}</p>
                <p><strong>Área:</strong> ${imovel.metros_quadrados} m²</p>
                <p><strong>Andar:</strong> ${imovel.andar}</p>
                <p><strong>Mobiliado:</strong> ${imovel.mobiliado ? "Sim" : "Não"}</p>
                <p><strong>Valor:</strong> R$ ${imovel.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
            </div>
        `;
    } catch (error) {
        console.error("Erro ao carregar detalhes do imóvel:", error);
        document.getElementById("detalhes-imovel").innerHTML = "<p>Erro ao carregar detalhes.</p>";
    }
});
