// Função para criar a slug a partir do nome do restaurante
function gerarSlug(nome) {
    return nome
        .toLowerCase()                          // Transforma em minúsculas
        .normalize("NFD")                       // Normaliza para decompor caracteres acentuados
        .replace(/[\u0300-\u036f]/g, "")        // Remove os acentos
        .replace(/[^a-z0-9-\s]/g, "")           // Remove caracteres especiais
        .trim()                                 // Remove espaços extras
        .replace(/\s+/g, "-");                  // Substitui espaços por hífens
}

// Preenche automaticamente o campo de slug quando o nome do restaurante é alterado
document.getElementById('restaurant-name').addEventListener('input', function() {
    const restaurantName = this.value;
    const slug = gerarSlug(restaurantName);
    
    // Atualiza o campo de slug e a exibição
    document.getElementById('custom-link').value = slug;
    document.getElementById('slug-display').textContent = slug;
});

// Atualiza o link preview quando o usuário digita diretamente no campo de slug
document.getElementById('custom-link').addEventListener('input', function() {
    const customSlug = this.value;
    
    // Atualiza o link no preview
    document.getElementById('slug-display').textContent = customSlug;
});

// Função que será chamada quando a página carregar
window.onload = function() {
    // Recupera o token do usuário do localStorage
    const userToken = localStorage.getItem('userToken');
    
    console.log("Token do usuário recuperado:", userToken); // Log do token para verificar se ele existe

    // Verifica se o token existe
    if (!userToken) {
        alert("Token de usuário não encontrado. Faça login novamente.");
        window.location.href = "login.html"; // Redireciona para a página de login
    } else {
        // Faz a requisição para obter os dados do usuário
        fetch('https://backend.pedepro.com.br/api/rest/getuser/bytoken', {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
            },
            body: JSON.stringify({ "token": userToken })
        })
        .then(response => {
            console.log("Resposta da API para obter usuário:", response); // Log da resposta bruta da API
            return response.json(); // Retorna a resposta como JSON
        })
        .then(data => {
            console.log("Dados recebidos da API:", data); // Log dos dados recebidos

            // Verifica se o usuário foi encontrado
            if (data.user && data.user.length > 0) {  // Ajuste para acessar o array de usuários diretamente
                const user = data.user[0]; // Obtém os dados do usuário
                const userEmail = user.email; // Obtém o email do usuário
                console.log("Usuário encontrado:", user);

                // Exibe o email do usuário na tela no elemento #user-email
                document.getElementById('user-email').textContent = userEmail;

                // A partir daqui, você tem o userId que pode ser usado no cadastro do restaurante
                document.getElementById('restaurant-form').addEventListener('submit', function(e) {
                    e.preventDefault(); // Impede o envio padrão do formulário

                    // Obtém os dados do formulário
                    const restaurantName = document.getElementById('restaurant-name').value;
                    const cnpj = document.getElementById('cnpj-cpf').value;
                    const slug = document.getElementById('custom-link').value;
                    const phone = document.getElementById('whatsapp').value;
                    const type = document.getElementById('business-type').value; // Obtém o tipo de restaurante

                    console.log("Dados do restaurante a ser cadastrado:", {
                        name: restaurantName,
                        cnpj: cnpj,
                        slug: slug,
                        phone: phone,
                        type: type,
                        user: user.id // Passa o userId do usuário
                    });

                    // Faz a requisição para criar o restaurante
                    fetch('https://backend.pedepro.com.br/api/rest/creater/restaurante', {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
                        },
                        body: JSON.stringify({
                            name: restaurantName,
                            cnpj: cnpj,
                            slug: slug,
                            phone: phone,
                            type: type,
                            user: user.id // Passa o userId do usuário
                        })
                    })
                    .then(response => response.json())
                    .then(data => {
                        console.log("Resposta da API ao criar restaurante:", data); // Log da resposta ao criar o restaurante
                        
                        // Verifica se o restaurante foi criado com sucesso
                        if (data.insert_restaurantes && data.insert_restaurantes.returning && data.insert_restaurantes.returning.length > 0) {
                            alert("Restaurante cadastrado com sucesso!");
                            window.location.href = "dashboard.html"; // Redireciona para o dashboard ou outra página
                        } else {
                            alert("Erro ao cadastrar o restaurante. Tente novamente.");
                        }
                    })
                    .catch(error => {
                        console.error("Erro ao cadastrar o restaurante:", error);
                        alert("Ocorreu um erro ao cadastrar o restaurante.");
                    });
                });
            } else {
                alert("Usuário não encontrado.");
            }
        })
        .catch(error => {
            console.error("Erro ao obter o usuário:", error);
            alert("Ocorreu um erro ao obter os dados do usuário.");
        });
    }
};


