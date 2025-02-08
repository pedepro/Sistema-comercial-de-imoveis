document.getElementById("botaocriarpedido").addEventListener("click", async () => {
    try {
        const customer = window.selectedCustomer?.id || null;
        const customer_name = window.selectedCustomer?.name || null;
        const customer_phone = window.selectedCustomer?.phone || null;
        const total_value = window.totalOrderValue || 0;
        const restaurant = window.dadosHasura?.restaurantes?.[0]?.id || null;
        const type = window.deliveryType; // Insira o valor de "type" aqui.
        const status = "ACEITO";
        const discount = window.totaldiscountOrder || 0;
        const adress = window.selectedAddress || null;
        const adress_text = window.selectedAddress?.endereco_text || null;
        const delivery_fee = window.deliveryFee || 0;
        const schedule = window.horarioSelecionado ? true : false;
  
        // Formatar o campo schedule_date
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
  
        const mutation = `
            mutation CreateOrder($input: order_insert_input!) {
                insert_order_one(object: $input) {
                    id
                }
            }
        `;
  
        const variables = {
            input: {
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
            }
        };
  
        const response = await fetch("https://backend.pedepro.com.br/v1/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-hasura-admin-secret": "dz9uee0D8fyyYzQsv2piE1MLcVZklkc7"
            },
            body: JSON.stringify({
                query: mutation,
                variables
            })
        });
  
        const result = await response.json();
        if (result.errors) {
            console.error("Erros retornados pela API:", result.errors);
        }
  
        if (response.ok) {
            console.log("Pedido criado com sucesso:", result.data.insert_order_one);
        } else {
            console.error("Erro ao criar pedido:", result.errors);
        }
    } catch (error) {
        console.error("Erro na requisição:", error);
    }
  });