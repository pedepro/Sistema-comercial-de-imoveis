const API_BASE_URL = "http://localhost:3000";

// Pegando o userId salvo no localStorage
const userId = localStorage.getItem("userId");

async function fetchUserData() {
    try {
        if (!userId) {
            throw new Error("Usuário não autenticado.");
        }

        const response = await fetch(`${API_BASE_URL}/user-data/${userId}`);
        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error);
        }

        console.log("Dados do usuário:", data.user);
        console.log("Dados do restaurante:", data.restaurant);

        // Salvando os dados no localStorage
        localStorage.setItem("userData", JSON.stringify({
            user: data.user,
            restaurant: data.restaurant,
        }));

        // Atualizar o título da página com os dados do restaurante
        atualizarTituloPagina();

    } catch (error) {
        console.error("Erro ao buscar os dados:", error);
    }
}

// Chamar a função ao carregar a página
fetchUserData();

function atualizarTituloPagina() {
  // Recupera os dados do usuário e do restaurante do localStorage
  const userData = JSON.parse(localStorage.getItem("userData"));

  if (userData && userData.restaurant) {
    const nomeRestaurante = userData.restaurant.name;
    document.title = `${nomeRestaurante} - PedePro`;
  } else {
    console.error("Dados do restaurante não encontrados no localStorage.");
  }
}










// Funções para carregar os arquivos pedidos e clientes
function pedidos() {
  // Carrega o CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'pedidos/pedidos.css';
  document.head.appendChild(link);

  // Carrega o HTML
  fetch('pedidos/pedidos.html')
    .then(response => response.text())
    .then(html => {
      document.getElementById('dashboard-container').innerHTML = html;

      // Carrega o JS
      const script = document.createElement('script');
      script.src = 'pedidos/pedidos.js';
      document.body.appendChild(script);
    })
    .catch(error => console.error("Erro ao carregar o HTML pedidos:", error));
}

function clientes() {
  // Carrega o CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'clientes/clientes.css';
  document.head.appendChild(link);

  // Carrega o HTML
  fetch('clientes/clientes.html')
    .then(response => response.text())
    .then(html => {
      document.getElementById('dashboard-container').innerHTML = html;

      // Carrega o JS
      const script = document.createElement('script');
      script.src = 'clientes/clientes.js';
      document.body.appendChild(script);
    })
    .catch(error => console.error("Erro ao carregar o HTML clientes:", error));
}


