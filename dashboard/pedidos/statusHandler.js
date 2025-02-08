export function alterarStatus(orders, id, currentStatus) {
    const order = orders.find(o => o.id === id);

    if (order) {
        if (currentStatus === "PENDENTE") order.status = "ACEITO";
        else if (currentStatus === "ACEITO") order.status = "A CAMINHO";
        else if (["A CAMINHO", "PRONTO PARA RETIRADA"].includes(currentStatus)) order.status = "FINALIZADO";
    }

    return orders;
}
