// Função para alternar entre as telas de login e cadastro
window.toggleForm = function () {
    const loginBox = document.getElementById('login-box');
    const signupBox = document.getElementById('signup-box');
    loginBox.classList.toggle('hidden');
    signupBox.classList.toggle('hidden');
};

import API_BASE_URL from "../config.js";

// Função para criar o usuário
async function createUser(name, email, password, phone) {
    try {
        // Logando os dados enviados para verificar o que está sendo enviado
        console.log("Enviando dados para criação de usuário:", { name, email, password, phone });

        const response = await fetch(`${API_BASE_URL}/create-user`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, email, password, phone }),
        });

        // Verificando a resposta da API
        const data = await response.json();
        console.log("Resposta da API:", data);

        if (data.success) {
            alert("Usuário criado com sucesso!");
            console.log("Usuário:", data.user);

            // Salvar o token e id no localStorage
            localStorage.setItem('userToken', data.user.token);
            localStorage.setItem('userId', data.user.id);

            // Redirecionar para a página 'newbussines'
            window.location.href = '/newbussines'; // ou o caminho correto para sua página
        } else {
            alert("Erro ao criar usuário: " + data.error);
        }
    } catch (error) {
        console.error("Erro na requisição:", error);
        alert("Erro ao conectar ao servidor.");
    }
}

// Adicionar evento de submit ao formulário de cadastro
document.getElementById("signup-form").addEventListener("submit", function (event) {
    event.preventDefault(); // Evita o recarregamento da página

    // Agora pegamos os dados do formulário de cadastro com os novos nomes
    const name = document.querySelector("input[name='signup-name']").value;
    const email = document.querySelector("input[name='signup-email']").value;
    const password = document.querySelector("input[name='signup-password']").value;
    const phone = document.querySelector("input[name='signup-phone']").value;

    // Logando os dados antes de enviar
    console.log("Dados do formulário de cadastro:", { name, email, password, phone });

    // Chama a função para criar o usuário
    createUser(name, email, password, phone);
});

// Adicionar evento de submit ao formulário de login
document.getElementById("login-form").addEventListener("submit", function (event) {
    event.preventDefault(); // Evita o recarregamento da página

    // Pegando os dados do formulário de login
    const email = document.querySelector("input[name='login-email']").value;
    const password = document.querySelector("input[name='login-password']").value;

    // Logando os dados do login antes de enviar
    console.log("Dados do login:", { email, password });

    // Aqui você pode implementar a lógica de login
});


// Função para logar o usuário
async function loginUser(email, password) {
    try {
        console.log("Tentando login com:", { email, password });

        const response = await fetch(`${API_BASE_URL}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ email, password }),
        });

        const data = await response.json();
        console.log("Resposta da API (login):", data);

        if (data.success) {
            alert("Login realizado com sucesso!");

            // Salvar ID e token no localStorage
            localStorage.setItem('userToken', data.user.token);
            localStorage.setItem('userId', data.user.id);

            // Redirecionar para a página principal
            window.location.href = '/dashboard'; // ou qualquer página após login
        } else {
            alert("Erro no login: " + data.error);
        }
    } catch (error) {
        console.error("Erro ao tentar logar:", error);
        alert("Erro ao conectar ao servidor.");
    }
}

// Adicionar evento de submit ao formulário de cadastro
document.getElementById("signup-form").addEventListener("submit", function (event) {
    event.preventDefault();

    const name = document.querySelector("input[name='signup-name']").value;
    const email = document.querySelector("input[name='signup-email']").value;
    const password = document.querySelector("input[name='signup-password']").value;
    const phone = document.querySelector("input[name='signup-phone']").value;

    console.log("Dados do formulário de cadastro:", { name, email, password, phone });

    createUser(name, email, password, phone);
});

// Adicionar evento de submit ao formulário de login
document.getElementById("login-form").addEventListener("submit", function (event) {
    event.preventDefault();

    const email = document.querySelector("input[name='login-email']").value;
    const password = document.querySelector("input[name='login-password']").value;

    console.log("Dados do login:", { email, password });

    loginUser(email, password);
});