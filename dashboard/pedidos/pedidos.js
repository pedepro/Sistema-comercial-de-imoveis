// Função de alteração de status via API
async function alterarStatus(id, currentStatus) {
    let newStatus = "";
    let setFields = { status: "", acceptance_date: "now()" };  // Campos a serem atualizados

    // Define o novo status com base no status atual
    if (currentStatus === "PENDENTE") {
        newStatus = "ACEITO";
    } else if (currentStatus === "ACEITO") {
        newStatus = "A CAMINHO"; // Ou PRONTO PARA RETIRADA, conforme necessário
        setFields.date_ready = "now()";  // Atualiza date_ready quando o status for A CAMINHO ou PRONTO PARA RETIRADA
    } else if (["A CAMINHO", "PRONTO PARA RETIRADA"].includes(currentStatus)) {
        newStatus = "FINALIZADO";
        setFields.date_end = "now()";  // Atualiza date_end quando o status for FINALIZADO
    }

    // Se o novo status foi definido, atualiza o campo status
    if (newStatus) {
        setFields.status = newStatus;
    }

    // Fazendo a chamada API para atualizar o status via Hasura
    const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
        },
        body: JSON.stringify({
            query: `
                mutation UpdateOrderStatusAndDate($id: Int!, $setFields: order_set_input!) {
                    update_order(
                        where: {id: {_eq: $id}}, 
                        _set: $setFields
                    ) {
                        affected_rows
                        returning {
                            id
                            status
                            acceptance_date
                            date_ready
                            date_end
                        }
                    }
                }
            `,
            variables: {
                id: id,
                setFields: setFields
            }
        })
    });

    const result = await response.json();

    // Verificando a resposta da API
    console.log("Resposta da API:", result);

    // Verificando se a estrutura da resposta contém a propriedade 'update_order'
    if (result.data && result.data.update_order) {
        if (result.data.update_order.affected_rows > 0) {
            console.log(`Status do pedido #${id} alterado para ${newStatus}.`);
        } else {
            console.error("Erro ao atualizar status no servidor.");
        }
    } else {
        console.error("Resposta da API não contém update_order:", result);
    }
}



const websocketUrl = "ws://localhost:3001"; // Nova URL do servidor WebSocket

// Usando a biblioteca WebSocket para criar uma conexão
const client = new WebSocket(websocketUrl);

client.onopen = function () {
    console.log("Conexão com o servidor WebSocket aberta!");

    const restaurantId = window.dadosHasura?.restaurantes?.[0]?.id;

    if (!restaurantId) {
        console.error("ID do restaurante não encontrado no window.dadosHasura");
        return;
    }

    // Enviar dados para se inscrever na tabela 'restaurantes', buscando pelo ID do restaurante
    client.send(JSON.stringify({
        table: 'restaurantes',
        column: 'id',
        value: restaurantId
    }));

    console.log(`Inscrição realizada para a tabela 'restaurantes' onde id = ${restaurantId}`);
};

let previousOrders = [];  // Inicializando a variável previousOrders fora do onmessage

client.onmessage = function (event) {
    console.log("Mensagem recebida do servidor WebSocket:", event.data);

    // Verifica se a mensagem é um Blob
    if (event.data instanceof Blob) {
        event.data.text().then(text => {
            console.log("Mensagem convertida para texto:", text);
            try {
                const response = JSON.parse(text);
                processResponse(response);
            } catch (e) {
                console.error("Erro ao tentar parsear JSON:", e);
            }
        }).catch(error => {
            console.error("Erro ao ler o Blob como texto:", error);
        });
    } else {
        try {
            const response = JSON.parse(event.data);
            processResponse(response);
        } catch (e) {
            console.error("Erro ao tentar parsear JSON:", e);
        }
    }
};

function processResponse(response) {
    if (response.table === 'restaurantes') {
        const restaurantes = response.data;

        // Verifica se 'restaurantes' é um array e possui dados
        if (Array.isArray(restaurantes) && restaurantes.length > 0) {
            const restaurantData = restaurantes[0]; // Como filtramos por ID, deve haver apenas um restaurante

            const orders = restaurantData.orders || [];
            const productCards = restaurantData.product_cards || [];

            window.productCards = productCards.map(card => {
                const variations = card.selected_variations.map(variation => ({
                    id: variation.id,
                    quantity: variation.qnt,
                    totalValue: variation.total_value,
                    variationName: variation.variationByVariation.name
                }));

                return {
                    ...card,
                    variations: variations
                };
            });

            window.totalcardvaluesemdescontoa = window.productCards.reduce((total, produto) => {
                return total + (produto.total_value || 0);
            }, 0);
            console.log("Total do carrinho sem desconto a:", window.totalcardvaluesemdescontoa);
            atualizarTotalValueProducts();

            function atualizarTotalValueProducts() {
                const totalValue = window.totalcardvaluesemdescontoa || 0;
                const totalValueElement = document.getElementById("totalvalueproducts");

                if (totalValueElement) {
                    totalValueElement.textContent = `R$ ${totalValue.toFixed(2).replace('.', ',')}`;
                } else {
                    console.error('Elemento com ID "totalvalueproducts" não encontrado.');
                }
            }

            window.totaldiscountoprodutos = window.productCards.reduce((total, produto) => {
                return total + (produto.discount || 0);
            }, 0);
            console.log("Total de desconto do carrinho a:", window.totaldiscountoprodutos);

            window.totalcardvalues = window.productCards.reduce((total, produto) => {
                const valorProduto = produto.total_value || 0;
                const descontoProduto = produto.discount || 0;
                return total + (valorProduto - descontoProduto);
            }, 0);

            console.log("Total do carrinho com desconto a:", window.totalcardvalues);

            calcularTotalDesconto();

            // Log para depuração
            console.log("Orders recebidos:", orders);
            console.log("Product Cards com variações:", window.productCards);

            if (Array.isArray(orders)) {
                const updatedOrderIds = getUpdatedOrderIds(previousOrders, orders);
                renderizarPedidos(orders, updatedOrderIds);
            } else {
                console.error("Erro: 'orders' não é um array ou está vazio.");
            }

            renderCarrinhoProducts(window.productCards);

            previousOrders = [...orders];
        } else {
            console.error("Erro: Nenhum restaurante encontrado ou resposta inválida.");
        }
    }
};

client.onerror = function (error) {
    console.error("Erro na conexão WebSocket:", error);
};




// Função para renderizar os produtos do carrinho
function renderCarrinhoProducts(productCards) {
  // Ordena os produtos do carrinho pelo campo created_at (mais antigo ao mais novo)
  productCards.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at) : new Date(0); // Define como mais antigo se vazio
      const dateB = b.created_at ? new Date(b.created_at) : new Date(0); // Define como mais antigo se vazio
      return dateA - dateB;
  });

  const carrinhoDiv = document.querySelector("#carrinhopdv");
  carrinhoDiv.innerHTML = ""; // Limpa a div antes de renderizar

  if (productCards.length > 0) {
      carrinhoDiv.innerHTML = productCards.map(productCard => `
          <div class="product-card-cart">
              <div class="infoscardproductcarrinho">
                  <div class="principalcardprodutocard">
                      <!-- Nome do produto -->
                      <p class="product-name-cart">${productCard.productByProduct.name}</p>
                  </div>  
                  <!-- Quantidade do produto -->
                  <div class="quantity-control-cart">
                      <button class="quantity-minus-cart">-</button>
                      <p class="product-quantity-cart">${productCard.qnt}</p>
                      <button class="quantity-plus-cart">+</button>
                      <!-- Preço total do produto -->
                      <p class="product-price-cart">R$ ${productCard.total_value.toFixed(2)}</p>
                  </div>
              </div>      
              <!-- Botão para expandir para ver as variações -->
              <button class="expand-button-cart">Ver Variações</button>
              <!-- Área para exibir as variações -->
              <div class="variations-container" style="display: none;">
                  ${productCard.selected_variations.map(variation => `
                      <div class="variation-item">
                          <span class="variation-quantity">${variation.qnt}x</span>
                          <span class="variation-name">${variation.variationByVariation.name}</span>
                          <span class="variation-total-value">R$ ${variation.total_value.toFixed(2)}</span>
                      </div>
                  `).join('')}
              </div>
          </div>
      `).join(''); // Junta todos os produtos em uma única string HTML

      // Adicionando os eventos para os botões de mais e menos
      const minusButtons = carrinhoDiv.querySelectorAll('.quantity-minus-cart');
      const plusButtons = carrinhoDiv.querySelectorAll('.quantity-plus-cart');
      
      minusButtons.forEach((button, index) => {
          button.addEventListener('click', () => {
              // Função de diminuir a quantidade e atualizar o total
              updateProductQuantity(productCards, index, -1);
          });
      });

      plusButtons.forEach((button, index) => {
          button.addEventListener('click', () => {
              // Função de aumentar a quantidade e atualizar o total
              updateProductQuantity(productCards, index, 1);
          });
      });

      // Adicionando o evento para expandir/contrair variações
      const expandButtons = carrinhoDiv.querySelectorAll('.expand-button-cart');
      const variationsContainers = carrinhoDiv.querySelectorAll('.variations-container');
      expandButtons.forEach((button, index) => {
          button.addEventListener('click', () => {
              expandProductVariations(button, variationsContainers[index]);
          });
      });
  } else {
      carrinhoDiv.innerHTML = `<p>Nenhum produto no carrinho.</p>`;
  }
}


// Função para atualizar a quantidade de um produto no carrinho
async function updateProductQuantity(productCards, index, change) {
    const productCard = productCards[index]; // Garantir que estamos atualizando o produto correto
    const newQuantity = productCard.qnt + change;

    if (newQuantity <= 0) {
        // Se a quantidade for 0 ou menor, remover o produto
        deleteProductFromCart(productCard.id);
    } else {
        // Atualizar a quantidade do produto e o total_value
        productCard.qnt = newQuantity;
        const unitValue = productCard.unit_value;
        const unitDiscount = productCard.unit_discount || 0; // Garantir que unit_discount esteja definido
        productCard.total_value = unitValue * newQuantity;

        // Calcular o desconto total
        const totalDiscount = unitDiscount * newQuantity;

        // Atualizar a renderização do carrinho
        renderCarrinhoProducts(productCards);

        // Atualizar os dados no backend (quantidade, valor total e desconto)
        await updateProductInCart(productCard.id, newQuantity, productCard.total_value, totalDiscount);
    }
}

// Função para atualizar os dados do produto no carrinho no backend
async function updateProductInCart(productId, newQuantity, newTotalValue, newDiscount) {
    try {
        const response = await fetch('https://backend.pedepro.com.br/v1/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-admin-secret': 'dz9uee0D8fyyYzQsv2piE1MLcVZklkc7'
            },
            body: JSON.stringify({
                query: `
                    mutation UpdateProductInCart($productId: Int!, $newQuantity: Int!, $newTotalValue: numeric!, $newDiscount: numeric!) {
                        update_product_card(
                            where: {id: {_eq: $productId}},
                            _set: {qnt: $newQuantity, total_value: $newTotalValue, discount: $newDiscount}
                        ) {
                            affected_rows
                        }
                    }
                `,
                variables: {
                    productId: productId,
                    newQuantity: newQuantity,
                    newTotalValue: newTotalValue,
                    newDiscount: newDiscount
                }
            })
        });

        const data = await response.json();
        if (data.errors) {
            console.error("Erro ao atualizar produto no carrinho:", data.errors);
        } else {
            console.log("Produto atualizado com sucesso!");
            calculateTotalOrderValue();

        }
    } catch (error) {
        console.error('Erro ao atualizar produto no carrinho:', error);
    }
}


// Função para excluir um produto do carrinho
async function deleteProductFromCart(productId) {
    try {
        const response = await fetch('https://backend.pedepro.com.br/v1/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-admin-secret': 'dz9uee0D8fyyYzQsv2piE1MLcVZklkc7'
            },
            body: JSON.stringify({
                query: `
                    mutation DeleteProductFromCart($productId: Int!) {
                        delete_product_card(where: {id: {_eq: $productId}}) {
                            affected_rows
                        }
                    }
                `,
                variables: {
                    productId: productId
                }
            })
        });

        const data = await response.json();
        if (data.errors) {
            console.error("Erro ao excluir produto:", data.errors);
        } else {
            console.log("Produto excluído com sucesso!");
            calculateTotalOrderValue();

        }
    } catch (error) {
        console.error('Erro ao excluir produto do carrinho:', error);
    }
}

// Função para expandir ou contrair as variações de um produto
function expandProductVariations(button, variationsContainer) {
    if (variationsContainer.style.display === "none") {
        variationsContainer.style.display = "block";
        button.textContent = "Esconder Variações";
    } else {
        variationsContainer.style.display = "none";
        button.textContent = "Ver Variações";
    }
}







// Função para identificar quais pedidos foram atualizados
function getUpdatedOrderIds(previousOrders, currentOrders) {
    const updatedIds = [];

    currentOrders.forEach(currentOrder => {
        const previousOrder = previousOrders.find(order => order.id === currentOrder.id);

        // Verificar se o pedido foi alterado (com base no status)
        if (previousOrder && previousOrder.status !== currentOrder.status) {
            updatedIds.push(currentOrder.id);
        }
    });

    return updatedIds;
}

// Função para renderizar os pedidos
function renderizarPedidos(orders, updatedOrderIds) {
  console.log("Renderizando pedidos:", orders);

  const containers = {
      pendentes: document.querySelector("#pendentes .pedido-lista"),
      aceitos: document.querySelector("#aceitos .pedido-lista"),
      "a-caminho-pronto": document.querySelector("#a-caminho-pronto .pedido-lista"),
  };

  // Validar containers
  if (!containers.pendentes || !containers.aceitos || !containers["a-caminho-pronto"]) {
      console.error("Um ou mais containers de pedidos não foram encontrados no DOM.");
      return;
  }

  // Limpa os containers antes de renderizar
  Object.values(containers).forEach(container => (container.innerHTML = ""));

  // Ordenando os pedidos
  const pendentes = orders
      .filter(order => order.status === "PENDENTE")
      .sort((a, b) => new Date(b.creation_date) - new Date(a.creation_date));

  const aceitos = orders
      .filter(order => order.status === "ACEITO")
      .sort((a, b) => new Date(b.date_ready || b.creation_date) - new Date(a.date_ready || a.creation_date));

  const aCaminhoPronto = orders
      .filter(order => ["A CAMINHO", "PRONTO PARA RETIRADA"].includes(order.status))
      .sort((a, b) => new Date(b.date_ready || b.creation_date) - new Date(a.date_ready || a.creation_date));

  console.log("Pedidos pendentes:", pendentes);
  console.log("Pedidos aceitos:", aceitos);
  console.log("Pedidos a caminho/pronto:", aCaminhoPronto);

  // Função para renderizar uma lista de pedidos
  function renderPedidosEmContainer(containerKey, ordersList) {
      ordersList.forEach(order => {
          const card = document.createElement("div");
          card.classList.add("pedido-card");

          const buttonText = {
              PENDENTE: "Aceitar Pedido",
              ACEITO: "Avançar",
              "A CAMINHO": "Finalizar Pedido",
              "PRONTO PARA RETIRADA": "Finalizar Pedido",
          };

          const paymentInfo = order.payments
              ?.map(payment => `${payment.type}: R$ ${payment.value.toFixed(2)}`)
              .join("<br>") || "Pagamento não especificado";

          card.innerHTML = `
              <h4>Pedido #${order.id} - ${order.customer_name || "Cliente não identificado"}</h4>
              <p class="pedido-info">
                  WhatsApp: ${order.customer_phone || "Telefone não disponível"}<br>
                  Entrega: ${order.type || "Tipo não especificado"}<br>
                  Pagamento:<br>${paymentInfo}
              </p>
              <div class="pedido-acoes">
                  <button onclick="handleAlterarStatus(${order.id}, '${order.status}')">${buttonText[order.status]}</button>
                  <div class="icons">
                      <i class="fas fa-print" title="Imprimir"></i>
                      <i class="fas fa-ellipsis-v" title="Menu"></i>
                  </div>
              </div>
          `;

          containers[containerKey].appendChild(card);

          // Adicionar a animação de pulo apenas para o pedido atualizado
          if (updatedOrderIds.includes(order.id)) {
              setTimeout(() => {
                  card.classList.add("card-pulando"); // Adiciona a classe para animar o pulo

                  // Remove a classe após 3 segundos para parar a animação
                  setTimeout(() => {
                      card.classList.remove("card-pulando");
                  }, 3000);
              }, 100);
          }
      });
  }

  // Renderiza os pedidos de acordo com a ordem
  renderPedidosEmContainer("pendentes", pendentes);
  renderPedidosEmContainer("aceitos", aceitos);
  renderPedidosEmContainer("a-caminho-pronto", aCaminhoPronto);
}

// Definir a função handleAlterarStatus fora de onmessage para garantir que seja acessível globalmente
window.handleAlterarStatus = function (id, currentStatus) {
    alterarStatus(id, currentStatus); // Só faz a chamada API, sem atualizar o estado local
};


// Seleciona os elementos
const novopedido = document.getElementById('novo-pedido');
const pdv = document.getElementById('pdv');
const categorysDiv = document.getElementById('categorys'); // Div de categorias
const productsDiv = document.getElementById('products'); // Div de produtos
const detalhesDiv = document.getElementById('detalhesproducts'); // Div de detalhes dos produtos

// Variáveis para controlar estado
let apiCalled = false;
let selectedCategory = null; // Categoria selecionada

// Função para criar cards de produtos
function renderProducts(products) {
  // Limpa os produtos anteriores
  productsDiv.innerHTML = '';

  // Cria um card para cada produto
  products.forEach(product => {
      const productCard = document.createElement('div');
      productCard.className = 'product-card';

      // Calcula o preço final com desconto
      const discountValue = product.discount || 0;
      const discountedPrice = product.price - discountValue;

      // Calcula o percentual de desconto
      const discountPercentage = discountValue > 0 
          ? (discountValue / product.price) * 100 
          : 0;

      // Atualiza o HTML do card do produto
      productCard.innerHTML = `
          <div class="product-image" style="position: relative;">
              <img src="${product.image?.[0]?.url || 'https://via.placeholder.com/150'}" alt="${product.name}" />
              ${
                  discountValue > 0 
                      ? `<div style="
                          position: absolute;
                          top: 5px;
                          left: 5px;
                          background-color:rgb(141, 141, 141);
                          color: white;
                          font-size: 12px;
                          font-weight: bold;
                          padding: 2px 5px;
                          border-radius: 3px;
                        ">
                        ${discountPercentage.toFixed(0)}% OFF
                        </div>` 
                      : ''
              }
          </div>
          <div class="product-info">
              <h3>${product.name}</h3>
              <p>
                  ${discountValue > 0 
                      ? `<span style="text-decoration: line-through; color: #999;">R$ ${product.price.toFixed(2)}</span> ` 
                      : ''}
                  <span style="font-weight: bold; color: ${discountValue > 0 ? '#e74c3c' : '#000'};">R$ ${discountedPrice.toFixed(2)}</span>
              </p>
          </div>
      `;

      // Adiciona evento de clique no card de produto
      productCard.addEventListener('click', () => openProductDetails(product));

      productsDiv.appendChild(productCard);
  });
}




let baseProductPrice = 0; // Preço base do produto
let totalVariationsPrice = 0; // Soma dos preços das variações selecionadas
let productQuantity = 1; // Quantidade do produto
let productCardId = null; // ID do produto no carrinho
let requiredGroups = []; // Grupos obrigatórios (min > 0)

// Função principal para abrir os detalhes do produto
async function openProductDetails(product) {
    detalhesDiv.style.display = 'block';
    detalhesDiv.style.width = '1100px';
    detalhesDiv.style.height = '550px';

    baseProductPrice = product.price; // Armazena o preço base
    totalVariationsPrice = 0; // Reinicia o preço das variações
    productQuantity = 1; // Reinicia a quantidade do produto

    const groupOrders = await fetchGroupOrders(product.id);
    if (!groupOrders) return;

    // Filtra e armazena grupos obrigatórios no estado global
    requiredGroups = groupOrders.filter(group => group.group_variation.min > 0);
    console.log("Grupos obrigatórios armazenados em requiredGroups:", requiredGroups);


    renderProductDetails(product, groupOrders);
    updateTotalPrice(); // Inicializa o preço total
}

// Função para buscar os group_orders do produto
async function fetchGroupOrders(productId) {
    try {
        const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
            },
            body: JSON.stringify({
                query: `
                    query MyQuery {
                        group_orders(where: {product: {_eq: ${productId}}}) {
                            id
                            order
                            group_variation {
                                id
                                max
                                min
                                name
                                surname
                                variations {
                                    name
                                    description
                                    id
                                    max
                                    price
                                }
                            }
                        }
                    }
                `
            })
        });

        if (!response.ok) {
            console.error("Erro na chamada à API:", response.statusText);
            return null;
        }

        const data = await response.json();
        return data.data.group_orders;

    } catch (error) {
        console.error("Erro ao buscar os group_orders:", error);
        return null;
    }
}

// Função para renderizar os detalhes do produto
function renderProductDetails(product, groupOrders) {
    detalhesDiv.innerHTML = `
        <div class="product-details-container">
            <div class="product-image2">
                <img src="${product.image?.[0]?.url || 'https://via.placeholder.com/300'}" alt="${product.name}" />
            </div>
            <div class="principal">
                <div class="product-info2">
                <div class="nomeproduct">${product.name}</div>
                   <p>${product.description || 'Sem descrição disponível.'}</p>
                   <div class="precoprincipal">Preço: R$ ${product.price.toFixed(2)}</div>
                   ${product.discount ? `<p>Desconto: ${product.discount}%</p>` : ''}
                   <hr />
                   ${groupOrders.map(renderGroupOrder).join('')}
                   <textarea class="product-observations" placeholder="Observações (opcional)"></textarea>
                </div>
                <div class="add-to-cart">
                    <div class="quantity-controls">
                        <button class="quantity-button" onclick="updateQuantity(-1)">-</button>
                        <span id="quantity">1</span>
                        <button class="quantity-button" onclick="updateQuantity(1)">+</button>
                    </div>
                    <button class="add-to-cart-button" id="addToCartBtn">Adicionar ao carrinho (R$ <span id="totalPrice">${product.price.toFixed(2)}</span>)</button>
                </div>
            </div>
        <button id="closeDetails" class="close-button">Fechar</button>
    `;

    document.getElementById('closeDetails').addEventListener('click', () => {
        detalhesDiv.style.display = 'none';
    });

    // Adiciona o evento para o botão "Adicionar ao carrinho"
        document.querySelector('.add-to-cart-button').addEventListener('click', async () => {
            console.log("requiredGroups:", requiredGroups); // Log para inspecionar os grupos obrigatórios
        if (requiredGroups.length > 0) {
            scrollToIncompleteGroup();
        } else {
            await addToCart(product);
        }
    });
}



// Função para renderizar cada grupo de variação
function renderGroupOrder(group) {
    const groupMax = group.group_variation.max;

    return `
        <div class="group-order" id="group-${group.group_variation.id}">
            <h4>${group.group_variation.name}</h4>
            <p class="selected-count" id="group-${group.group_variation.id}-count">0/${groupMax}</p>
            <div class="variations">
                ${group.group_variation.variations.map(variation => `
                    <div class="variation multi-choice">
                        <div class="variation-details">
                            <span class="variation-name" data-id="${variation.id}">${variation.name}</span>
                            <p class="variation-description">${variation.description || ''}</p>
                        </div>
                        <div class="quantity-price-control">
                            <span class="variation-price">R$ ${variation.price.toFixed(2)}</span>
                            <div class="quantity-control">
                                <button class="btn-quantity" 
                                        data-group-id="${group.group_variation.id}"
                                        data-variation-id="${variation.id}"
                                        data-group='${JSON.stringify(group)}'
                                        onclick="updateVariationQuantity(this, -1)">-</button>
                                <span id="variation-${variation.id}-quantity">0</span>
                                <button class="btn-quantity" 
                                        data-group-id="${group.group_variation.id}"
                                        data-variation-id="${variation.id}"
                                        data-group='${JSON.stringify(group)}'
                                        onclick="updateVariationQuantity(this, 1)">+</button>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// Função para atualizar a quantidade da variação
function updateVariationQuantity(button, change) {
    const groupId = button.getAttribute('data-group-id');
    const variationId = button.getAttribute('data-variation-id');
    const group = JSON.parse(button.getAttribute('data-group')); // Reparse the group object from the data attribute

    const quantitySpan = document.getElementById(`variation-${variationId}-quantity`);
    const countSpan = document.getElementById(`group-${groupId}-count`);

    let currentQuantity = parseInt(quantitySpan.textContent);
    let groupMax = parseInt(countSpan.textContent.split('/')[1]);

    // Soma total do grupo
    let groupTotal = Array.from(document.querySelectorAll(`#group-${groupId} .quantity-control span`))
        .reduce((sum, span) => sum + parseInt(span.textContent), 0);

    if (groupTotal + change <= groupMax && currentQuantity + change >= 0) {
        quantitySpan.textContent = currentQuantity + change;
        groupTotal += change;
        countSpan.textContent = `${groupTotal}/${groupMax}`;

        updateTotalVariationsPrice();

        // Verifica se a quantidade mínima foi alcançada ou se precisa adicionar ou remover o grupo da lista de requiredGroups
        const groupIndex = requiredGroups.findIndex(item => item.group_variation.id === group.group_variation.id);

        if (groupTotal >= group.group_variation.min) {
            // Se a quantidade selecionada for maior ou igual ao mínimo, remove o grupo da lista requiredGroups
            if (groupIndex > -1) {
                requiredGroups.splice(groupIndex, 1);
            }
        } else {
            // Se a quantidade selecionada for menor que o mínimo, adiciona o grupo à lista requiredGroups
            if (groupIndex === -1) {
                requiredGroups.push(group);
            }
        }

        console.log("Estado dos requiredGroups após atualização:", requiredGroups); // Log para verificar a alteração no estado

    }
}





// Função para calcular o preço total das variações
function updateTotalVariationsPrice() {
    totalVariationsPrice = 0;

    document.querySelectorAll('.variations .quantity-control span').forEach(span => {
        const quantity = parseInt(span.textContent);
        const variationPrice = parseFloat(span.closest('.variation').querySelector('.variation-price').textContent.replace('R$', '').trim());

        totalVariationsPrice += quantity * variationPrice;
    });

    updateTotalPrice();
}

// Função para atualizar a quantidade do produto
function updateQuantity(change) {
    const quantitySpan = document.getElementById('quantity');
    const newQuantity = Math.max(1, productQuantity + change);

    if (newQuantity !== productQuantity) {
        productQuantity = newQuantity;
        quantitySpan.textContent = productQuantity;
        updateTotalPrice();
    }
}

// Função para calcular o preço total das variações
function updateTotalVariationsPrice() {
    totalVariationsPrice = 0;

    document.querySelectorAll('.variations .quantity-control span').forEach(span => {
        const quantity = parseInt(span.textContent);
        const variationPrice = parseFloat(span.closest('.variation').querySelector('.variation-price').textContent.replace('R$', '').trim());

        totalVariationsPrice += quantity * variationPrice;
    });

    updateTotalPrice();
}

// Função para atualizar a quantidade do produto
function updateQuantity(change) {
    const quantitySpan = document.getElementById('quantity');
    const newQuantity = Math.max(1, productQuantity + change);

    if (newQuantity !== productQuantity) {
        productQuantity = newQuantity;
        quantitySpan.textContent = productQuantity;
        updateTotalPrice();
    }
}

// Função para calcular o preço total
function updateTotalPrice() {
    const totalPrice = (baseProductPrice + totalVariationsPrice) * productQuantity;
    document.getElementById('totalPrice').textContent = totalPrice.toFixed(2);
}

// Função para adicionar o produto e as variações ao carrinho
async function addToCart(product) {
    // Verifica se o restaurantId está disponível
    const restaurantId = window.dadosHasura?.restaurantes?.[0]?.id;
    if (!restaurantId) {
        console.error("ID do restaurante não encontrado no window.dadosHasura");
        return;
    }

    // Cálculo do unit_value: Preço das variações vezes a quantidade das variações + preço base do produto
    const unitValue = totalVariationsPrice + baseProductPrice;

    // Cálculo do total_value: unit_value vezes a quantidade do produto
    const totalValue = unitValue * productQuantity;

    // Calcula o desconto total
    const discountPerProduct = product.discount || 0; // Assumindo que o desconto por produto vem do objeto product
    const totalDiscount = discountPerProduct * productQuantity;

    console.log("Produto ID:", product.id);
    console.log("Quantidade do Produto:", productQuantity);
    console.log("ID do Restaurante:", restaurantId);
    console.log("Preço Unitário (unit_value):", unitValue);
    console.log("Preço Total (total_value):", totalValue.toFixed(2)); // Preço total (unit_value * quantidade do produto)
    console.log("Desconto Total (discount):", totalDiscount);

    // Criação do produto no carrinho com os campos unit_value, total_value e discount
    const productCardInput = [
        {
            qnt: productQuantity, // Quantidade do produto
            product: product.id,  // ID do produto
            restaurant: restaurantId, // Incluindo o ID do restaurante
            unit_value: unitValue, // Preço unitário
            total_value: totalValue, // Preço total
            discount: totalDiscount, // Desconto total
            unit_discount: discountPerProduct
        }
    ];

    try {
        // Chamada API para criar o produto no carrinho
        const response = await fetch('https://backend.pedepro.com.br/v1/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-admin-secret': 'dz9uee0D8fyyYzQsv2piE1MLcVZklkc7'
            },
            body: JSON.stringify({
                query: `
                    mutation CreateProductCard($productCardInput: [product_card_insert_input!]!) {
                        insert_product_card(objects: $productCardInput) {
                            returning {
                                id
                                qnt
                                product
                                restaurant
                                unit_value
                                total_value
                                discount
                            }
                        }
                    }
                `,
                variables: {
                    productCardInput: productCardInput
                }
            })
        });

        const data = await response.json();
        console.log("Resposta da API:", data); // Verificar a resposta da API

        if (data.errors) {
            console.error("Erros da API:", data.errors); // Exibir erros detalhados
            throw new Error('Erro ao adicionar produto no carrinho');
        }

        // Armazena o ID do produto criado no carrinho
        const productCardId = data.data.insert_product_card.returning[0].id;
        console.log('Produto no carrinho criado, ID:', productCardId);

        // Agora, insira as variações
        await addSelectedVariations(productCardId);
    } catch (error) {
        console.error('Erro ao criar o produto no carrinho:', error);
        alert('Ocorreu um erro ao adicionar o produto ao carrinho.');
    }
}


// Função para adicionar as variações selecionadas ao carrinho
async function addSelectedVariations(productCardId) {
    const selectedVariations = [];

    // Coletar as variações selecionadas e suas quantidades
    document.querySelectorAll('.variation').forEach(variationElement => {
        const variationId = variationElement.querySelector('.variation-name').getAttribute('data-id');
        const variationQuantity = parseInt(variationElement.querySelector('.quantity-control span').textContent);

        if (variationQuantity > 0) {
            const variationPrice = parseFloat(variationElement.querySelector('.variation-price').textContent.replace('R$', '').trim());
            selectedVariations.push({
                qnt: variationQuantity,
                variation: variationId,
                total_value: variationQuantity * variationPrice,
                product_card: productCardId // Usando o ID do produto no carrinho
            });
        }
    });

    if (selectedVariations.length > 0) {
        try {
            const response = await fetch('https://backend.pedepro.com.br/v1/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-hasura-admin-secret': 'dz9uee0D8fyyYzQsv2piE1MLcVZklkc7'
                },
                body: JSON.stringify({
                    query: `
                        mutation CreateSelectedVariations($selectedVariations: [selected_variations_insert_input!]!) {
                            insert_selected_variations(objects: $selectedVariations) {
                                returning {
                                    id
                                    qnt
                                    variation
                                    total_value
                                    product_card
                                }
                            }
                        }
                    `,
                    variables: {
                        selectedVariations: selectedVariations
                    }
                })
            });

            const data = await response.json();
            console.log('Variações adicionadas ao carrinho:', data);
            alert('Produto e variações adicionados ao carrinho!');
        } catch (error) {
            console.error('Erro ao adicionar variações ao carrinho:', error);
            alert('Erro ao adicionar as variações ao carrinho.');
        }
    }
}

// Função para alternar a habilitação do botão de adicionar ao carrinho
function toggleAddToCartButton() {
    const button = document.getElementById('addToCartBtn');
    if (requiredGroups.length === 0) {
        button.removeAttribute('disabled');
    } else {
        button.setAttribute('disabled', 'true');
    }
}

// Função para rolar até o grupo incompleto
function scrollToIncompleteGroup() {
    console.log("Função scrollToIncompleteGroup foi chamada."); // Log para verificar a chamada da função

    if (requiredGroups.length > 0) {
        console.log("Grupos obrigatórios restantes:", requiredGroups); // Log dos grupos obrigatórios

        // Obtém o primeiro grupo incompleto
        const firstIncompleteGroup = requiredGroups[0];
        const groupId = firstIncompleteGroup.group_variation?.id || firstIncompleteGroup.id;

        console.log("ID do grupo incompleto:", groupId); // Log do ID do grupo incompleto

        if (groupId) {
            const incompleteGroupElement = document.getElementById(`group-${groupId}`);
            if (incompleteGroupElement) {
                console.log("Elemento encontrado, executando scroll:", incompleteGroupElement); // Log do elemento encontrado
                incompleteGroupElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                console.warn(`Elemento com ID group-${groupId} não encontrado.`);
            }
        } else {
            console.warn("ID do grupo incompleto não foi encontrado.");
        }
    } else {
        console.log("Nenhum grupo obrigatório restante."); // Log caso não haja grupos obrigatórios
    }
}



// Adiciona o evento de clique ao botão
novopedido.addEventListener('click', async () => {
    // Torna o PDV visível com animação
    if (!pdv.classList.contains('visible')) {
        pdv.style.display = 'flex'; // Mostra o PDV com o layout flex
        requestAnimationFrame(() => {
            pdv.classList.add('visible'); // Adiciona a classe para a animação
        });
    }

    // Se a API já foi chamada, não faz a chamada novamente
    if (apiCalled) return;

    // Obtém o ID do restaurante de forma dinâmica
    const restaurantId = window.dadosHasura?.restaurantes?.[0]?.id;

    if (!restaurantId) {
        console.error("ID do restaurante não encontrado no window.dadosHasura");
        return;
    }

    // Faz a chamada à API
    try {
        const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
            },
            body: JSON.stringify({
                query: `
                    query MyQuery {
                        category(where: {restaurant: {_eq: ${restaurantId}}, available: {_eq: true}}) {
                            available
                            id
                            name
                            order
                            products {
                                discount
                                id
                                name
                                price
                                slug
                                image {
                                    url
                                    id
                                }
                            }
                        }
                    }
                `
            })
        });

        if (!response.ok) {
            throw new Error(`Erro na chamada à API: ${response.statusText}`);
        }

        const data = await response.json();

        // Armazena os dados no objeto `window` para reutilização
        window.apiResponseData = data;
        console.log("Dados obtidos da API:", data);

        // Cria elementos para cada categoria
        const categories = data.data.category;

        // Seleciona automaticamente a primeira categoria
        if (categories.length > 0) {
            selectedCategory = categories[0];
            renderProducts(selectedCategory.products); // Renderiza os produtos da primeira categoria
        }

        categories.forEach(category => {
            const categoryElement = document.createElement('div');
            categoryElement.className = 'category-item'; // Adiciona uma classe para estilização
            categoryElement.textContent = category.name; // Insere o nome da categoria

            // Adiciona evento de clique ao elemento
            categoryElement.addEventListener('click', () => {
                // Atualiza a variável de categoria selecionada
                selectedCategory = category;
                console.log("Categoria selecionada:", selectedCategory);

                // Remove a classe 'selected' de todos os elementos
                document.querySelectorAll('.category-item').forEach(item => {
                    item.classList.remove('selected');
                });

                // Adiciona a classe 'selected' ao elemento clicado
                categoryElement.classList.add('selected');

                // Renderiza os produtos da categoria clicada
                renderProducts(category.products);
            });

            // Adiciona o elemento à div de categorias
            categorysDiv.appendChild(categoryElement);
        });

        // Destaca visualmente a primeira categoria
        const firstCategoryElement = categorysDiv.querySelector('.category-item');
        if (firstCategoryElement) {
            firstCategoryElement.classList.add('selected');
        }


        // Marca que a API já foi chamada
        apiCalled = true;

    } catch (error) {
        console.error("Erro ao fazer a chamada à API:", error);
    }
});










// Seleciona o botão, sem redeclarar o pdv
const botaoFecharPdv = document.querySelector('#botaofecharpdv');

// Adiciona o evento de clique ao botão para esconder o PDV
botaofecharpdv.addEventListener('click', () => {
    if (pdv.classList.contains('visible')) {
        pdv.classList.remove('visible');
        pdv.classList.add('hidden');
    }
});


// Função para excluir todos os produtos do carrinho de um restaurante
async function deleteAllProductsFromCart(restaurantId) {
    try {
        const response = await fetch('https://backend.pedepro.com.br/v1/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-admin-secret': 'dz9uee0D8fyyYzQsv2piE1MLcVZklkc7'
            },
            body: JSON.stringify({
                query: `
                    mutation DeleteAllProductsFromCart($restaurantId: Int!) {
                        delete_product_card(where: {restaurant: {_eq: $restaurantId}}) {
                            affected_rows
                        }
                    }
                `,
                variables: {
                    restaurantId: restaurantId // Usando o campo 'restaurant'
                }
            })
        });

        const data = await response.json();
        if (data.errors) {
            console.error("Erro ao excluir produtos:", data.errors);
        } else {
            console.log("Todos os produtos foram excluídos com sucesso!");
        }
    } catch (error) {
        console.error('Erro ao excluir todos os produtos do carrinho:', error);
    }
}


document.querySelector('#excluirpdv').addEventListener('click', async () => {
    try {
        const restaurantId = window.dadosHasura?.restaurantes?.[0]?.id;

        if (!restaurantId) {
            console.error("ID do restaurante não encontrado no window.dadosHasura");
            return;
        }

        // Chama a função para excluir todos os produtos do carrinho do restaurante
        await deleteAllProductsFromCart(restaurantId);

    } catch (error) {
        console.error("Erro ao tentar excluir todos os produtos do carrinho:", error);
    }
});



// Configuração inicial do cabeçalho da API
const GRAPHQL_URL = "https://backend.pedepro.com.br/v1/graphql";
const HEADERS = {
  "Content-Type": "application/json",
  "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
};

// Variáveis de controle de paginação
let currentPage = 1; // Página inicial
let totalPages = 1; // Total de páginas (inicialmente 1)

// Função para buscar os clientes da API com paginação
async function fetchCustomers(filter = "", page = 1) {
  const restaurantId = window.dadosHasura?.restaurantes?.[0]?.id; // Pega o ID do restaurante
  const limit = 10; // Número de clientes por página
  const offset = (page - 1) * limit; // Cálculo do deslocamento (offset)

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        query: `
          query GetCustomers($filter: String, $restaurantId: Int, $limit: Int, $offset: Int) {
            customer(where: {
              _and: [
                { restaurante: { id: { _eq: $restaurantId } } },
                { _or: [
                    { name: { _ilike: $filter } },
                    { phone: { _ilike: $filter } }
                ]}
              ]
            }, limit: $limit, offset: $offset) {
              id
              name
              phone
              saldo_cashback
              orders_aggregate {
                aggregate {
                  count
                }
              }
              orders(order_by: { creation_date: desc }, limit: 1) {
                creation_date
              }
            }
          }
        `,
        variables: {
          filter: `%${filter}%`,
          restaurantId: restaurantId,
          limit: limit,
          offset: offset
        },
      }),
    });

    const data = await response.json();
    if (data.errors) {
      console.error("Erro na API:", data.errors);
      return [];
    }

    // Atualiza o número total de páginas baseado na contagem total de clientes
    totalPages = Math.ceil(data.data.customer.length / limit);

    return data.data.customer;
  } catch (error) {
    console.error("Erro ao buscar clientes:", error);
    return [];
  }
}

// Função para renderizar os clientes na tabela
function renderCustomers(customers) {
    const tableContainer = document.getElementById("tabelaclientespdv");
    tableContainer.innerHTML = ""; // Limpa os resultados anteriores
  
    if (customers.length === 0) {
      tableContainer.innerHTML = "<p>Nenhum cliente encontrado.</p>";
      return;
    }
  
    const table = document.createElement("table");
    table.style.width = "100%";
  
    // Cabeçalho
    const header = document.createElement("tr");
    header.innerHTML = `
      <th>Nome</th>
      <th>phone</th>
      <th>Último Pedido</th>
      <th>Qtd. Pedidos</th>
      <th>Saldo Cashback</th>
    `;
    table.appendChild(header);
  
    // Linhas
    customers.forEach((customer) => {
      const row = document.createElement("tr");
      row.style.height = "30px";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <td>${customer.name}</td>
        <td>${customer.phone}</td>
        <td>${formatDate(customer.orders[0]?.creation_date)}</td>
        <td>${customer.orders_aggregate.aggregate.count}</td>
        <td>${customer.saldo_cashback || "R$ 0,00"}</td>
      `;
  
      // Verifica se o cliente atual é o selecionado
      if (window.selectedCustomer && window.selectedCustomer.id === customer.id) {
        row.classList.add("selected-row"); // Aplica a classe de seleção
      }
  
      row.addEventListener("click", () => {
        // Remove a seleção de todas as linhas
        const rows = document.querySelectorAll("#tabelaclientespdv table tr");
        rows.forEach((r) => {
          r.classList.remove("selected-row");
        });
  
        // Adiciona a classe de seleção à linha clicada
        row.classList.add("selected-row");
  
        // Atualiza o cliente selecionado no window
        window.selectedCustomer = customer;
      });
  
      table.appendChild(row);
    });
  
    tableContainer.appendChild(table);
  
    // Adiciona os controles de navegação
    renderPagination();
  }
  

// Função para renderizar os controles de paginação
function renderPagination() {
    const paginationContainer = document.getElementById("pagination2");
    paginationContainer.innerHTML = ""; // Limpa os controles anteriores
  
    // Botão "Voltar" com ícone Material Icons
    const prevButton = document.createElement("button");
    prevButton.disabled = currentPage === 1;
    prevButton.classList.add("pagination-btn"); // Adiciona uma classe para estilização
    prevButton.innerHTML = `<span class="material-icons">arrow_back</span>`; // Ícone de "Voltar"
    prevButton.addEventListener("click", () => {
      currentPage--;
      loadCustomers(); // Recarrega os clientes com a nova página
    });
  
    // Exibe o número da página atual dentro de uma div
    const pageNumber = document.createElement("div");
    pageNumber.innerText = `Página ${currentPage} de ${totalPages}`;
    pageNumber.classList.add("page-number"); // Classe para estilização do número da página
  
    // Botão "Avançar" com ícone Material Icons
    const nextButton = document.createElement("button");
    nextButton.disabled = currentPage === totalPages;
    nextButton.classList.add("pagination-btn"); // Adiciona uma classe para estilização
    nextButton.innerHTML = `<span class="material-icons">arrow_forward</span>`; // Ícone de "Avançar"
    nextButton.addEventListener("click", () => {
      currentPage++;
      loadCustomers(); // Recarrega os clientes com a nova página
    });
  
    // Adiciona os botões e o número da página no contêiner de paginação
    paginationContainer.appendChild(prevButton);
    paginationContainer.appendChild(pageNumber);
    paginationContainer.appendChild(nextButton);
  }
  
  

// Função para carregar os clientes com a página atual e filtro
async function loadCustomers(filter = "") {
  const customers = await fetchCustomers(filter, currentPage);
  renderCustomers(customers);
}

async function openCustomerPopup() {
    const popup = document.getElementById("popup");
    const overlay = document.querySelector(".overlay"); // Seleciona o overlay pela classe
  
    if (popup) {
      popup.style.visibility = "visible";
  
      if (overlay) {
        overlay.style.visibility = "visible"; // Mostra o overlay
      }
  
      const customers = await fetchCustomers(); // Sem filtro, carrega todos os clientes
      renderCustomers(customers);
    }
  }
  

  function closeCustomerPopup() {
    const popup = document.getElementById("popup");
    const overlay = document.querySelector(".overlay");
  
    if (popup) {
      popup.style.visibility = "hidden";
    }
  
    if (overlay) {
      overlay.style.visibility = "hidden";
    }
  }
  
  // Adiciona evento ao botão de fechar
  document.getElementById("closePopup").addEventListener("click", closeCustomerPopup);
  
  // Adiciona evento para fechar clicando no overlay
  document.querySelector(".overlay").addEventListener("click", closeCustomerPopup);
  

// Função para filtrar os clientes
function setupCustomerFilter() {
  const filterInput = document.getElementById("filtroclientes");
  let timeout;

  filterInput.addEventListener("input", () => {
    const value = filterInput.value.trim();

    if (value.length < 4) {
      // Se o campo de filtro for limpo ou tiver menos de 4 caracteres, chama a função sem filtro
      loadCustomers(); // Recarrega os clientes com a página atual
      return;
    }

    // Debounce para evitar múltiplas chamadas
    clearTimeout(timeout);
    timeout = setTimeout(async () => {
      loadCustomers(value); // Passa o filtro para a função de carregamento
    }, 300);
  });
}

// Chama a função para configurar o filtro ao carregar a página
setupCustomerFilter();

// Evento para abrir o popup ao clicar no botão
document.getElementById("botaoclientespdv")?.addEventListener("click", openCustomerPopup);

// Inicializa o filtro de clientes
setupCustomerFilter();


// Função para formatar a data
function formatDate(dateString) {
    if (!dateString) return "Sem pedido"; // Caso não tenha data
    const date = new Date(dateString);
  
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0"); // Meses são base 0
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
  
    return `${day}/${month}/${year} - ${hours}:${minutes}`;
  }

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


  
// Adiciona evento ao botão de endereço
document.getElementById("botaoenderecopdv").addEventListener("click", openAddressPopup);




function openAddressPopup() {
    const popup = document.getElementById("popupendereco");
    const overlay = document.querySelector(".overlay");
  
    popup.style.visibility = "visible";
    overlay.style.visibility = "visible";
  
    // Carregar endereços do cliente e aplicar a classe ao selecionado
    loadCustomerAddresses().then(() => {
      if (window.selectedAddress) {
        applySelectedAddress(window.selectedAddress);
      }
    });
  }
  
  function applySelectedAddress(selectedAddressId) {
    const rows = document.querySelectorAll("#enderecos-table tr");
    
    rows.forEach(row => {
      row.classList.remove("selected-address");
      if (row.dataset.id === String(selectedAddressId)) {
        row.classList.add("selected-address");
      }
    });
  }
  

  // Adiciona evento ao botão de fechar
  document.getElementById("closePopupadress").addEventListener("click", closeAddressPopup);
  
  // Adiciona evento para fechar clicando no overlay
  document.querySelector(".overlay").addEventListener("click", closeAddressPopup);

  function closeAddressPopup() {
    const popup = document.getElementById("popupendereco");
    const overlay = document.querySelector(".overlay");
    popup.style.visibility = "hidden";
    overlay.style.visibility = "hidden";
  
    // Restaurar as seções à visibilidade padrão
    cancelAddressForm();
  }
  
  

  async function loadCustomerAddresses() {
    if (!window.selectedCustomer || !window.selectedCustomer.id) {
      alert("Selecione um cliente antes.");
      return;
    }
  
    const customerId = window.selectedCustomer.id;
    const enderecoSection = document.getElementById("enderecos-section");
    const criarEnderecoSection = document.getElementById("criar-endereco-section");
    const enderecosMessage = document.getElementById("enderecos-message");
    const criarEnderecoBtn = document.getElementById("criar-endereco-btn");
  
    try {
      const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
        },
        body: JSON.stringify({
          query: `
            query GetAddresses($customerId: Int!) {
              address(where: {customer: {_eq: $customerId}}) {
                numero
                referencia
                rua
                id
                endereco_text
                complemento
                bairroByBairro {
                  name
                  value
                }
              }
            }
          `,
          variables: {
            customerId,
          },
        }),
      });
  
      const { data } = await response.json();
      const addresses = data?.address || [];
  
      if (addresses.length > 0) {
        renderAddressTable(addresses);
        enderecoSection.style.display = "block";
        enderecosMessage.textContent = "Selecione um endereço ou crie um novo.";
      } else {
        enderecoSection.style.display = "none";
        enderecosMessage.textContent = "Não há endereços cadastrados.";
      }
  
      // Sempre mostra o botão de criar endereço
      criarEnderecoBtn.style.display = "block";
      criarEnderecoSection.style.display = "none";
  
      // Adiciona a taxa de entrega diretamente no dataset da linha da tabela
      addresses.forEach((address) => {
        const deliveryFee = address.bairroByBairro?.value || 0; // Pega o valor da taxa de entrega
        address.delivery_fee = deliveryFee; // Adiciona a taxa de entrega no objeto
  
        // Vamos encontrar a linha correspondente na tabela e adicionar a taxa de entrega no dataset
        const tableRow = document.querySelector(`#enderecos-table tr[data-id='${address.id}']`);
        if (tableRow) {
          tableRow.dataset.deliveryFee = deliveryFee; // Adiciona a taxa de entrega no dataset da linha
        }
      });
    } catch (error) {
      console.error("Erro ao carregar endereços", error);
      enderecosMessage.textContent = "Erro ao carregar endereços.";
    }
  }
  
  
  
  



  function renderAddressTable(addresses) {
    const table = document.getElementById("enderecos-table");
    table.innerHTML = `
      <tr>
        <th>Endereço</th>
        <th>Ações</th>
      </tr>
    `;
  
    addresses.forEach(address => {
      const row = document.createElement("tr");
      row.dataset.id = address.id;
  
      // Verifica se o endereço é o selecionado
      const isSelected = window.selectedAddress === address.id;
  
      row.innerHTML = `
        <td>${address.endereco_text}</td>
        <td>
          <span 
            class="material-icons select-icon" 
            title="Selecionar endereço" 
            style="color: ${isSelected ? '#4CAF50' : '#aaa'}; cursor: pointer;"
            onclick="selectAddress(${address.id})">
            ${isSelected ? 'check_circle' : 'radio_button_unchecked'}
          </span>
          <span 
            class="material-icons delete-icon" 
            title="Excluir endereço" 
            style="color: #f44336; cursor: pointer; margin-left: 10px;"
            onclick="deleteAddress(${address.id})">
            delete
          </span>
        </td>
      `;
  
      table.appendChild(row);
    });
  }
  
  /**
   * Função para excluir um endereço.
   * @param {number} addressId - ID do endereço a ser excluído.
   */
  async function deleteAddress(addressId) {
    if (!confirm("Tem certeza de que deseja excluir este endereço?")) {
      return;
    }
  
    try {
      const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
        },
        body: JSON.stringify({
          query: `
            mutation DeleteAddress($addressId: Int!) {
              delete_address(where: {id: {_eq: $addressId}}) {
                affected_rows
              }
            }
          `,
          variables: { addressId },
        }),
      });
  
      const { data, errors } = await response.json();
  
      if (errors || data?.delete_address?.affected_rows === 0) {
        throw new Error("Erro ao excluir o endereço.");
      }
  
      alert("Endereço excluído com sucesso.");
      loadCustomerAddresses(); // Atualiza a tabela de endereços
    } catch (error) {
      console.error("Erro ao excluir endereço:", error);
      alert("Erro ao excluir o endereço. Tente novamente.");
    }
  }
  


  
  
  
  

  function openAddressForm() {
    const enderecoSection = document.getElementById("enderecos-section");
    const criarEnderecoSection = document.getElementById("criar-endereco-section");
    const formEndereco = document.getElementById("form-endereco");
    const criarEnderecoBtn = document.getElementById("criar-endereco-btn");
  
    // Esconde a seção de endereços e o botão de criar
    enderecoSection.style.display = "none";
    criarEnderecoBtn.style.display = "none";
    criarEnderecoSection.style.display = "none";
  
    // Exibe o formulário de criação
    formEndereco.style.display = "block";
  
    loadBairros();
  }

  

  async function loadBairros() {
    const selectBairro = document.getElementById("bairro");
  
    try {
      const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
        },
        body: JSON.stringify({
          query: `
            query MyQuery {
              bairros(where: {restaurant: {_eq: 3}}) {
                id
                name
              }
            }
          `,
        }),
      });
  
      const { data } = await response.json();
      const bairros = data.bairros;
  
      bairros.forEach(bairro => {
        const option = document.createElement("option");
        option.value = bairro.id;
        option.textContent = bairro.name;
        selectBairro.appendChild(option);
      });
    } catch (error) {
      console.error("Erro ao carregar bairros", error);
    }
  }

  


  async function createAddress() {
    const bairro = document.getElementById("bairro").value;
    const rua = document.getElementById("rua").value;
    const numero = document.getElementById("numero").value;
    const complemento = document.getElementById("complemento").value || null;
    const referencia = document.getElementById("referencia").value || null;
  
    if (!bairro || !rua || !numero) {
      alert("Por favor, preencha todos os campos obrigatórios.");
      return;
    }
  
    const enderecoText = `${rua}, ${numero}${complemento ? `, ${complemento}` : ""}${referencia ? `, ${referencia}` : ""}, ${bairro}`;
  
    try {
      const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
        },
        body: JSON.stringify({
          query: `
            mutation CreateAddress($object: address_insert_input!) {
              insert_address_one(object: $object) {
                id
                endereco_text
                bairroByBairro {
                  name
                }
              }
            }
          `,
          variables: {
            object: {
              customer: window.selectedCustomer.id, // ID do cliente selecionado
              bairro: bairro,
              rua: rua,
              numero: numero,
              complemento: complemento,
              referencia: referencia,
              endereco_text: enderecoText,
            },
          },
        }),
      });
  
      const { data, errors } = await response.json();
  
      if (errors) {
        console.error("Erro na mutação GraphQL:", errors);
        alert("Erro ao criar endereço.");
        return;
      }
  
      const newAddress = data?.insert_address_one;
      if (newAddress) {
        alert("Endereço criado com sucesso!");
  
        // Atualiza a lista de endereços
        await loadCustomerAddresses();
  
        // Seleciona automaticamente o endereço criado
        selectAddress(newAddress.id);
  
        // Volta à visualização principal
        cancelAddressForm();
      }
    } catch (error) {
      console.error("Erro ao criar endereço:", error);
      alert("Erro ao criar endereço. Verifique sua conexão e tente novamente.");
    }
  }
  
  

  

  function cancelAddressForm() {
    const enderecoSection = document.getElementById("enderecos-section");
    const criarEnderecoSection = document.getElementById("criar-endereco-section");
    const formEndereco = document.getElementById("form-endereco");
    const criarEnderecoBtn = document.getElementById("criar-endereco-btn");
  
    // Exibe a seção de endereços e o botão de criar
    enderecoSection.style.display = "block";
    criarEnderecoBtn.style.display = "block";
    criarEnderecoSection.style.display = "block";
  
    // Esconde o formulário de criação
    formEndereco.style.display = "none";
  }
  









// Função para formatar o valor como moeda
function formatCurrency(value) {
    // Usa o Intl.NumberFormat para formatar como moeda (R$)
    return new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL"
    }).format(value);
}




function selectAddress(addressId) {
  const tableRows = document.querySelectorAll("#enderecos-table tr");

  tableRows.forEach(row => {
    if (row.dataset.id) { // Apenas remove classes e reseta ícones de linhas com data-id válido
      row.classList.remove("selected-address");

      // Atualiza o ícone para não selecionado
      const selectIcon = row.querySelector(".select-icon");
      if (selectIcon) {
        selectIcon.textContent = "radio_button_unchecked";
        selectIcon.style.color = "#aaa";
      }

      console.log(`Removendo classe de: ${row.dataset.id}, Classes: ${row.className}`);
    }
  });

  const selectedRow = document.querySelector(`#enderecos-table tr[data-id='${addressId}']`);
  if (selectedRow) {
    // Adiciona classe à linha selecionada
    selectedRow.classList.add("selected-address");

    // Atualiza o ícone para selecionado
    const selectIcon = selectedRow.querySelector(".select-icon");
    if (selectIcon) {
      selectIcon.textContent = "check_circle";
      selectIcon.style.color = "#4CAF50";
    }

    console.log(`Classe adicionada para: ${selectedRow.dataset.id}, Classes: ${selectedRow.className}`);
    window.selectedAddress = addressId; // Armazena o endereço selecionado

    // Verifica se o método de entrega é "DELIVERY" e pega a taxa de entrega do dataset
    if (window.deliveryType === 'DELIVERY') {
      // Acessa a taxa de entrega diretamente do dataset da linha
      const deliveryFee = parseFloat(selectedRow.dataset.deliveryFee) || 0;

      if (deliveryFee) {
        // Salva a taxa de entrega no window
        window.deliveryFee = deliveryFee;

        // Atualiza o valor da taxa de entrega no DOM
        const deliveryFeeElement = document.getElementById("taxadeentrega");
        if (deliveryFeeElement) {
          deliveryFeeElement.textContent = formatCurrency(window.deliveryFee);
          calculateTotalOrderValue();
        }

        console.log("Taxa de entrega atualizada:", window.deliveryFee);
      } else {
        console.error("Taxa de entrega não encontrada para este endereço.");
        window.deliveryFee = 0;
        const deliveryFeeElement = document.getElementById("taxadeentrega");
        if (deliveryFeeElement) {
          deliveryFeeElement.textContent = formatCurrency(window.deliveryFee);
          calculateTotalOrderValue();
        }
      }
    }
  } else {
    console.error("Linha não encontrada para o ID:", addressId);
  }
}

  
// Define valores iniciais no objeto window
window.deliveryType = 'RETIRADA'; // Tipo de entrega inicial
window.deliveryFee = 0; // Taxa de entrega inicial
  
// Seleciona os dois botões
const buttomRetirada = document.querySelector('.buttomretirada');
const buttomDelivery = document.querySelector('.buttomdelivery');
const botaoEndereco = document.getElementById('botaoenderecopdv'); // Seleciona o botão de endereço

// Função para aplicar o estilo de "selecionado"
function aplicarEstiloSelecionado(botao) {
  botao.style.backgroundColor = '#003366'; // Cor de fundo para selecionado
  botao.style.color = 'white'; // Cor do texto para selecionado
}

// Função para remover o estilo de "selecionado"
function removerEstiloSelecionado(botao) {
  botao.style.backgroundColor = ''; // Remove a cor de fundo
  botao.style.color = ''; // Remove a cor do texto
}

// Função para desabilitar o botão de endereço
function desabilitarBotaoEndereco() {
  botaoEndereco.style.pointerEvents = 'none'; // Desabilita interações com o botão
  botaoEndereco.style.opacity = '0.6'; // Define opacidade para 60% para indicar desabilitado
}

// Função para habilitar o botão de endereço
function habilitarBotaoEndereco() {
  botaoEndereco.style.pointerEvents = 'auto'; // Habilita interações com o botão
  botaoEndereco.style.opacity = '1'; // Restaura a opacidade
}

// Define o estilo inicial para buttomRetirada
aplicarEstiloSelecionado(buttomRetirada);
desabilitarBotaoEndereco(); // Desabilita o botão inicialmente, pois o método de entrega é RETIRADA

// Adiciona evento de clique para buttomRetirada
buttomRetirada.addEventListener('click', () => {
  window.deliveryType = 'RETIRADA'; // Atualiza o tipo de entrega no objeto window
  aplicarEstiloSelecionado(buttomRetirada); // Aplica estilo a buttomRetirada
  removerEstiloSelecionado(buttomDelivery); // Remove estilo de buttomDelivery
  console.log('Tipo de entrega:', window.deliveryType);

  // Desabilita o botão de endereço ao mudar para RETIRADA
  desabilitarBotaoEndereco();

  // Zera a taxa de entrega
  window.deliveryFee = 0;
  calculateTotalOrderValue();

  // Atualiza o valor da taxa de entrega no DOM
  const deliveryFeeElement = document.getElementById("taxadeentrega");
  if (deliveryFeeElement) {
    deliveryFeeElement.textContent = formatCurrency(window.deliveryFee);
  }
  console.log("Taxa de entrega zerada:", window.deliveryFee);
});

// Adiciona evento de clique para buttomDelivery
buttomDelivery.addEventListener('click', () => {
  window.deliveryType = 'DELIVERY'; // Atualiza o tipo de entrega no objeto window
  aplicarEstiloSelecionado(buttomDelivery); // Aplica estilo a buttomDelivery
  removerEstiloSelecionado(buttomRetirada); // Remove estilo de buttomRetirada
  console.log('Tipo de entrega:', window.deliveryType);

  // Habilita o botão de endereço ao mudar para DELIVERY
  habilitarBotaoEndereco();

  // Verifica se há endereço selecionado
  if (window.selectedAddress) {
    const selectedRow = document.querySelector(`#enderecos-table tr[data-id='${window.selectedAddress}']`);
    if (selectedRow) {
      const deliveryFee = parseFloat(selectedRow.dataset.deliveryFee) || 0;
      window.deliveryFee = deliveryFee;

      // Atualiza o valor da taxa de entrega no DOM
      const deliveryFeeElement = document.getElementById("taxadeentrega");
      if (deliveryFeeElement) {
        deliveryFeeElement.textContent = formatCurrency(window.deliveryFee);
      }
      console.log("Taxa de entrega atualizada:", window.deliveryFee);
    } else {
      console.error("Taxa de entrega não encontrada para este endereço.");
      window.deliveryFee = 0;
    }
  } else {
    console.log("Nenhum endereço selecionado, não é possível calcular a taxa de entrega.");
    window.deliveryFee = 0;
  }

  // Atualiza o valor da taxa de entrega no DOM
  const deliveryFeeElement = document.getElementById("taxadeentrega");
  if (deliveryFeeElement) {
    deliveryFeeElement.textContent = formatCurrency(window.deliveryFee);
  }

  calculateTotalOrderValue();
});

  
  // Função para selecionar um endereço
  function selecionarEndereco(enderecoId) {
    window.selectedAddress = enderecoId;
    // Aqui você pode aplicar qualquer lógica de UI que seja necessária para destacar o endereço selecionado
    console.log("Endereço selecionado:", enderecoId);
    // Adiciona a classe 'selected-address' no endereço selecionado
    document.getElementById(enderecoId).classList.add('selected-address');
  }
  







// Mostrar ou esconder o groupfocus
function togglePaymentOptions() {
    const paymentOptions = document.getElementById("paymentOptionsGroupFocus");
    paymentOptions.style.display = paymentOptions.style.display === "block" ? "none" : "block";
}

// Selecionar uma forma de pagamento
function selectPaymentOption(paymentType) {
    // Salvar a forma de pagamento no window
    window.selectedPaymentType = paymentType;

    // Alterar fundo do botão para azul
    const paymentButton = document.getElementById("botaopagamentopdv");
    paymentButton.style.backgroundColor = "#007bff";
    paymentButton.style.color = "white";
    paymentButton.innerText = `${paymentType}`;

    // Atualizar a UI do groupfocus para destacar a opção selecionada
    const options = document.querySelectorAll("#paymentOptionsList div");
    options.forEach(option => {
        if (option.getAttribute("data-type") === paymentType) {
            option.style.backgroundColor = "#007bff";
            option.style.color = "white";
        } else {
            option.style.backgroundColor = "white";
            option.style.color = "black";
        }
    });

    // Fechar o groupfocus
    document.getElementById("paymentOptionsGroupFocus").style.display = "none";
}

// Event listener para o botão
document.getElementById("botaopagamentopdv").addEventListener("click", togglePaymentOptions);





// Event listener para o botão
document.getElementById("botaodescontopdv").addEventListener("click", openPopupb);







// Função para abrir o popup
function openPopupb() {
  // Adiciona a classe "visible" para mostrar o overlay
  document.getElementById('overlaycashback').classList.add('visible');
  document.getElementById('cashbackSaldo').innerText = window.selectedCustomer.saldo_cashback.toFixed(2); // Exibe o saldo de cashback
  console.log("Popup aberto. Saldo Cashback: ", window.selectedCustomer.saldo_cashback);
  
  // Inicializa o campo de desconto manual com valor 0,00
  document.getElementById('manualDiscount').value = '0.00'; // Define explicitamente o valor inicial de desconto manual
  document.getElementById('cashbackToggle').checked = false; // Inicializa o toggle desmarcado
  window.saldoutilizado = 0; // Zera o saldo utilizado
  window.discountmanual = 0; // Zera o desconto manual
}

// Função para fechar o popup
function closePopup() {
  // Remove a classe "visible" para esconder o overlay
  document.getElementById('overlaycashback').classList.remove('visible');
  console.log("Popup fechado");
}


// Função para alternar o uso do saldo cashback
function toggleCashback() {
  const saldoCashback = window.selectedCustomer.saldo_cashback;
  const maxUsar = window.totalcardvalues;
  console.log("Saldo Cashback:", saldoCashback, "Valor total:", maxUsar);

  // Verifica se o saldo cashback é maior que o valor total
  const saldoUtilizado = document.getElementById('cashbackToggle').checked ? Math.min(saldoCashback, maxUsar) : 0;
  console.log("Saldo utilizado (cashback):", saldoUtilizado);
  
  window.saldoutilizado = saldoUtilizado;
  
  // O valor máximo do desconto manual é o valor restante após o saldo de cashback
  document.getElementById('manualDiscount').max = Math.max(maxUsar - saldoUtilizado, 0); 
  console.log("Novo máximo para desconto manual:", document.getElementById('manualDiscount').max);
  
  // Atualiza o texto do saldo restante
  const saldoRestante = saldoCashback - saldoUtilizado;
  const saldoRestanteText = saldoRestante > 0 ? `Saldo restante: R$ ${saldoRestante.toFixed(2)}` : `Saldo insuficiente para mais descontos.`;
  
  // Exibe o saldo restante na página (você pode personalizar o ID do elemento para onde o texto será exibido)
  document.getElementById('saldoRestante').innerText = saldoRestanteText;

  validateDiscount();
}

// Função para validar o valor do desconto manual
function validateDiscount() {
  // Garantir que o valor do desconto manual seja sempre um número válido
  const manualDiscount = parseFloat(document.getElementById('manualDiscount').value.replace(',', '.')) || 0;
  const maxDiscount = window.totalcardvalues - window.saldoutilizado;
  
  console.log("Desconto manual atual:", manualDiscount);
  console.log("Valor máximo permitido para desconto manual:", maxDiscount);

  // Verifica se o desconto manual é válido e não ultrapassa o valor máximo
  if (manualDiscount > maxDiscount) {
    console.log("Desconto manual ajustado para não ultrapassar o máximo permitido.");
    document.getElementById('manualDiscount').value = maxDiscount.toFixed(2);
  }

  window.discountmanual = parseFloat(document.getElementById('manualDiscount').value.replace(',', '.'));
  console.log("Desconto manual final:", window.discountmanual);
}

// Função para aplicar o desconto
function applyDiscount() {
  const totalDesconto = window.saldoutilizado + window.discountmanual;
  console.log("Saldos usados:", window.saldoutilizado, window.discountmanual);
  
  // Evita o erro "NaN" garantindo que a soma seja feita corretamente
  if (isNaN(totalDesconto)) {
    console.log("Erro: O total do desconto é NaN!");
  } else {
    console.log("Desconto aplicado:", totalDesconto.toFixed(2));
  }
  
  closePopup();
  calcularTotalDesconto()
}




function calcularTotalDesconto() {
  // Soma os valores de desconto dos produtos, desconto manual e saldo utilizado, tratando nulos ou indefinidos
  const totalDesconto = (window.totaldiscountoprodutos || 0) + (window.discountmanual || 0) + (window.saldoutilizado || 0);

  // Salva o resultado no window.totaldiscountOrder
  window.totaldiscountOrder = totalDesconto;

  // Log para verificar o valor calculado
  console.log("Total do desconto calculado:", totalDesconto);

  // Atualiza o valor exibido no elemento com o ID 'textocabecalhocarrinhob'
  document.getElementById('descontospdv').innerText = `R$ ${totalDesconto.toFixed(2)}`;
  
  // Chama a função para calcular o valor total do pedido
  calculateTotalOrderValue();
}








function calculateTotalOrderValue() {
  // Se as variáveis necessárias não estiverem definidas, usa um valor padrão (0)
  const totalCardValue = window.totalcardvaluesemdescontoa || 0;  // Valor do pedido sem desconto
  const totalDiscount = window.totaldiscountOrder || 0;          // Total de descontos
  const deliveryFee = window.deliveryFee || 0;                    // Taxa de entrega

  // Calcula o valor total do pedido
  const totalOrderValue = totalCardValue - totalDiscount + deliveryFee;

  // Salva o resultado no window.totalOrderValue
  window.totalOrderValue = totalOrderValue;

  // Atualiza o valor exibido no elemento com o ID 'textocabecalhocarrinhob'
  document.getElementById('textocabecalhocarrinhob').innerText = `R$ ${totalOrderValue.toFixed(2)}`;

  // Log para verificar o valor calculado
  console.log("Valor total do pedido calculado:", totalOrderValue);
}






function openAgendamentoPopup() {
  const overlay = document.getElementById('overlayagendamento');
  overlay.classList.add('visible'); // Torna o popup visível
  console.log("Popup de agendamento aberto");
  fetchHorariosDisponiveis();
}

// Função para fechar o popup
function closeAgendamentoPopup() {
  document.getElementById('overlayagendamento').classList.remove('visible');
}

// Função para buscar os horários disponíveis
async function fetchHorariosDisponiveis() {
  const GRAPHQL_URL = "https://backend.pedepro.com.br/v1/graphql";
  const HEADERS = {
    "Content-Type": "application/json",
    "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7",
  };

  const restauranteId = window.dadosHasura?.restaurantes?.[0]?.id;
  const today = new Date();
  const diaSemana = today.toLocaleString('pt-BR', { weekday: 'long' });
  const horaAtual = today.getHours();
  const minutoAtual = today.getMinutes();

  console.log(`Buscando horários para o restaurante ID: ${restauranteId}, dia da semana: ${diaSemana}`);
  console.log(`Hora atual: ${horaAtual}:${minutoAtual}`);

  const query = `
    query {
      restaurantes(where: {id: {_eq: ${restauranteId}}}) {
        id
      }
      service_hours(where: {day_week: {_eq: "${diaSemana}"}}) {
        id
        open
        to_close
      }
    }
  `;

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ query }),
    });

    const result = await response.json();

    console.log('Resultado da API:', result);

    if (result.data && result.data.service_hours) {
      const horarios = result.data.service_hours;
      console.log('Horários encontrados:', horarios);

      const horariosDisponiveis = gerarHorariosDisponiveis(horarios, horaAtual, minutoAtual);
      console.log('Horários disponíveis:', horariosDisponiveis);

      const horariosContainer = document.getElementById('horariosDisponiveis');
      horariosContainer.innerHTML = '';

      horariosDisponiveis.forEach(horario => {
        const button = document.createElement('button');
        button.textContent = horario;
        button.onclick = () => selecionarHorario(horario);

        // Destacar o horário previamente selecionado
        if (horario === window.horarioSelecionado) {
          button.style.fontWeight = 'bold'; // Destaca o botão
          button.style.backgroundColor = '#d4edda'; // Fundo verde claro
          button.style.color = '#155724'; // Texto verde escuro
        }

        horariosContainer.appendChild(button);
      });
    } else {
      console.error('Erro: Não foi possível obter os horários.');
    }
  } catch (error) {
    console.error('Erro ao buscar horários:', error);
  }
}

function gerarHorariosDisponiveis(horarios, horaAtual, minutoAtual) {
  let horariosDisponiveis = [];

  function arredondarParaProximo15(horas, minutos) {
    const totalMinutos = horas * 60 + minutos;
    const minutosAjustados = Math.ceil(totalMinutos / 15) * 15;
    return {
      horas: Math.floor(minutosAjustados / 60) % 24,
      minutos: minutosAjustados % 60,
    };
  }

  horarios.forEach(horario => {
    const openParts = horario.open.split(':');
    const closeParts = horario.to_close.split(':');

    const openDate = new Date();
    openDate.setHours(parseInt(openParts[0], 10), parseInt(openParts[1], 10), 0, 0);

    const closeDate = new Date();
    closeDate.setHours(parseInt(closeParts[0], 10), parseInt(closeParts[1], 10), 0, 0);

    if (closeDate <= openDate) {
      closeDate.setDate(closeDate.getDate() + 1);
    }

    const now = new Date();
    now.setHours(horaAtual, minutoAtual, 0, 0);
    if (openDate < now) {
      openDate.setTime(now.getTime());
    }

    const { horas, minutos } = arredondarParaProximo15(openDate.getHours(), openDate.getMinutes());
    openDate.setHours(horas, minutos, 0, 0);

    while (openDate < closeDate) {
      const horarioFormatado = `${openDate.getHours().toString().padStart(2, '0')}:${openDate.getMinutes().toString().padStart(2, '0')}`;
      horariosDisponiveis.push(horarioFormatado);
      openDate.setMinutes(openDate.getMinutes() + 15);
    }
  });

  console.log('Horários finais disponíveis:', horariosDisponiveis);

  return horariosDisponiveis;
}

function selecionarHorario(horario) {
  window.horarioSelecionado = horario;

  alert(`Horário selecionado: ${horario}`);
  closeAgendamentoPopup();
}


document.getElementById("botaocriarpedido").addEventListener("click", async () => {
  try {
      const customer = window.selectedCustomer?.id || null;
      const customer_name = window.selectedCustomer?.name || null;
      const customer_phone = window.selectedCustomer?.phone || null;
      const total_value = window.totalOrderValue || 0;
      const restaurant = window.dadosHasura?.restaurantes?.[0]?.id || null;
      const type = window.deliveryType; 
      const status = "ACEITO";
      const discount = window.totaldiscountOrder || 0;
      const adress = window.selectedAddress || null;
      const adress_text = window.selectedAddress?.endereco_text || null;
      const delivery_fee = window.deliveryFee || 0;
      const schedule = window.horarioSelecionado ? true : false;

      let schedule_date = null;
      if (window.horarioSelecionado) {
          const now = new Date();
          const [hours, minutes] = window.horarioSelecionado.split(":").map(Number);
          const localDate = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
              hours,
              minutes
          );
          schedule_date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}T${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}:00`;
      }

      const input = {
          customer,
          customer_name,
          customer_phone,
          total_value,
          restaurant,
          type,
          status,
          discount,
          adress,
          adress_text,
          delivery_fee,
          schedule,
          schedule_date,
      };

      const response = await fetch("http://127.0.0.1:8060/create-order", { // Substitua pelo domínio ou IP do backend
          method: "POST",
          headers: {
              "Content-Type": "application/json",
          },
          body: JSON.stringify({ input }),
      });

      const result = await response.json();

      if (response.ok) {
          console.log("Pedido criado com sucesso:", result);
      } else {
          console.error("Erro ao criar pedido:", result.errors || result.error);
      }
  } catch (error) {
      console.error("Erro na requisição:", error);
  }
});



