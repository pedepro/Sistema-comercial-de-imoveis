console.log("Arquivo clientespdv.js carregado com sucesso!");

// O resto do código do clientespdv.js...







// Fecha o popup quando o botão de fechar for clicado
document.getElementById("closePopup")?.addEventListener("click", function() {
    const popup = document.getElementById("popup");
    if (popup) {
        popup.style.visibility = "hidden"; // Esconde o popup
        console.log("Popup fechado.");
    }

});

// Fechar o popup quando clicar fora da área de conteúdo
window.addEventListener("click", function(event) {
    const popup = document.getElementById("popup");
    if (popup && event.target === popup) {
        popup.style.visibility = "hidden"; // Esconde o popup
        console.log("Popup fechado ao clicar fora.");
    }
});

document.getElementById("closePopup")?.addEventListener("click", function() {
    // Remove o script
    const script = document.querySelector('script[src="components/clientespdv/clientespdv.js"]');
    if (script) {
        script.remove();
        console.log("Script clientespdv.js removido.");
    }

    // Remove o CSS
    const link = document.querySelector('link[href="components/clientespdv/clientespdv.css"]');
    if (link) {
        link.remove();
        console.log("CSS clientespdv.css removido.");
    }

    // Remove o HTML (ou apenas o popup)
    const popup = document.getElementById("popup");
    if (popup) {
        popup.remove();
        console.log("Popup removido.");
    }
});
