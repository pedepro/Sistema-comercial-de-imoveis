const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
require('dotenv').config();
const cors = require('cors');  // Adicionei a importação do cors


const app = express();
const portHttp = 3000;
const portWs = 3001;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// Permite todas as origens
app.use(cors());

app.use(express.json());

const httpServer = app.listen(portHttp, () => {
    console.log(`Servidor HTTP rodando em http://localhost:${portHttp}`);
});

const wsServer = new WebSocket.Server({ port: portWs });

wsServer.on('listening', () => {
    console.log(`Servidor WebSocket rodando em ws://localhost:${portWs}`);
});

wsServer.on('connection', async (ws) => {
    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (err) {
            console.log('Erro ao processar a mensagem:', err);
            ws.close(4002, 'Mensagem inválida');
            return;
        }

        console.log('📩 Dados recebidos do cliente:', data);

        const { table, column, value } = data;

        if (!table || !column || value === undefined) {
            console.log('❌ Parâmetros ausentes');
            ws.close(4000, 'Parâmetros ausentes');
            return;
        }

        // 🔥 Armazena a inscrição corretamente
        ws.subscription = { table, column, value };
        console.log(`✅ Cliente inscrito para ouvir ${table} onde ${column} = ${value}`);

        // 🔍 Buscar os dados iniciais no banco de dados
        try {
            const result = await pool.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [value]);
            if (result.rows.length > 0) {
                ws.send(JSON.stringify({ table, data: result.rows }));
                console.log(`📤 Dados iniciais enviados para ${table} onde ${column} = ${value}`);
            } else {
                console.log(`⚠️ Nenhum dado encontrado para ${table} onde ${column} = ${value}`);
            }
        } catch (err) {
            console.error('❌ Erro ao buscar dados iniciais:', err);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Cliente WebSocket desconectado');
    });
});

// 🔔 Função para escutar as notificações do PostgreSQL
const listenForNotifications = () => {
    pool.connect((err, client) => {
        if (err) {
            console.error('❌ Erro ao conectar ao PostgreSQL para escutar notificações:', err);
            return;
        }

        client.query('LISTEN user_changes');
        console.log('📡 Escutando notificações em user_changes...');

        client.on('notification', async (msg) => {
            console.log('🔔 Notificação recebida:', msg);

            try {
                const notificationPayload = JSON.parse(msg.payload);
                console.log('✅ Notificação processada:', notificationPayload);

                const { table, data } = notificationPayload;
                const filterColumn = "id";
                const filterValue = data[filterColumn];

                // 🔥 Enviar atualização apenas para clientes inscritos corretamente
                wsServer.clients.forEach(client => {
                    if (
                        client.readyState === WebSocket.OPEN &&
                        client.subscription &&
                        client.subscription.table === table &&
                        client.subscription.column === filterColumn &&
                        client.subscription.value == filterValue
                    ) {
                        console.log(`📤 Enviando atualização para ${table} onde ${filterColumn} = ${filterValue}`);
                        client.send(JSON.stringify({ table, data: [data] }));
                    }
                });

            } catch (err) {
                console.warn('⚠️ Notificação não era JSON válido. Ignorando:', msg.payload);
            }
        });
    });
};

// Inicia a escuta de notificações
listenForNotifications();














// Rota para listar todas as tabelas e suas colunas do banco de dados
app.get('/tables', async (req, res) => {
    try {
        // Consultar todas as tabelas e suas respectivas colunas
        const result = await pool.query(`
            SELECT 
                table_name, 
                array_agg(column_name) AS columns
            FROM 
                information_schema.columns
            WHERE 
                table_schema = 'public'
            GROUP BY 
                table_name
        `);
        
        res.json({ success: true, tables: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// Rota para criar uma nova tabela
app.post('/create-table', async (req, res) => {
    const { tableName } = req.body;
    if (!tableName) {
        return res.status(400).json({ success: false, error: 'O nome da tabela é obrigatório' });
    }
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
        res.json({ success: true, message: `Tabela ${tableName} criada com sucesso` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para criar um novo usuário
app.post('/create-user', async (req, res) => {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name || !phone) {
        return res.status(400).json({ success: false, error: 'Email, password, name e phone são obrigatórios' });
    }

    try {
        const token = crypto.randomBytes(24).toString('hex');

        const result = await pool.query(
            `INSERT INTO users (email, password, name, phone, token) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [email, password, name, phone, token]
        );

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// Rota para atualizar os dados do usuário e, opcionalmente, o restaurante associado a ele
app.put('/update-user', async (req, res) => {
    const { user_id, user_token, name, email, password, address, restaurant_id, phone } = req.body;

    if (!user_id || !user_token) {
        return res.status(400).json({ success: false, error: 'user_id e user_token são obrigatórios' });
    }

    try {
        const userCheck = await pool.query(
            `SELECT * FROM users WHERE id = $1 AND token = $2`,
            [user_id, user_token]
        );

        if (userCheck.rowCount === 0) {
            return res.status(403).json({ success: false, error: 'Usuário não autorizado' });
        }

        let fields = [];
        let values = [];
        let index = 1;

        if (name) {
            fields.push(`name = $${index}`);
            values.push(name);
            index++;
        }

        if (email) {
            fields.push(`email = $${index}`);
            values.push(email);
            index++;
        }

        if (password) {
            fields.push(`password = $${index}`);
            values.push(password);
            index++;
        }

        if (address) {
            fields.push(`address = $${index}`);
            values.push(address);
            index++;
        }

        if (restaurant_id) {
            fields.push(`restaurant_id = $${index}`);
            values.push(restaurant_id);
            index++;
        }

        if (phone) {
            fields.push(`phone = $${index}`);
            values.push(phone);
            index++;
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
        }

        values.push(user_id);
        const query = `UPDATE users SET ${fields.join(", ")} WHERE id = $${index} RETURNING *`;

        const result = await pool.query(query, values);

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



// Rota para autenticação de usuário (login)
app.post('/loginv', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
    }

    try {
        // Buscar usuário pelo email
        const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Usuário não encontrado' });
        }

        const user = result.rows[0];

        // Verificar se a senha está correta
        if (user.password !== password) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }

        // Retornar os dados do usuário com o token existente
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                phone: user.phone,
                token: user.token // Mantendo o mesmo token
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// Rota para criar um novo restaurante e associá-lo a um usuário
app.post('/create-restaurant', async (req, res) => {
    const { user_id, name, phone, address } = req.body;

    if (!user_id || !name || !phone || !address) {
        return res.status(400).json({ success: false, error: 'user_id, name, phone e address são obrigatórios' });
    }

    try {
        // Criar o restaurante com todos os campos
        const restaurantResult = await pool.query(
            `INSERT INTO restaurants (name, phone, address, "user") VALUES ($1, $2, $3, $4) RETURNING id`,
            [name, phone, address, user_id]
        );

        const restaurant_id = restaurantResult.rows[0].id;

        res.json({ success: true, restaurant_id, message: 'Restaurante criado e associado ao usuário' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/edit-restaurant/:id', async (req, res) => {
    const restaurant_id = req.params.id;
    const { name, phone, address, user_id } = req.body;

    if (!name || !phone || !address || !user_id) {
        return res.status(400).json({ 
            success: false, 
            error: 'name, phone, address e user_id são obrigatórios' 
        });
    }

    try {
        const result = await pool.query(
            `UPDATE restaurants 
             SET name = $1, phone = $2, address = $3, "user" = $4 
             WHERE id = $5 
             RETURNING *`,
            [name, phone, address, user_id, restaurant_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Restaurante não encontrado' 
            });
        }

        res.json({ 
            success: true, 
            restaurant: result.rows[0], 
            message: 'Restaurante atualizado com sucesso' 
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



app.get('/user-data/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ success: false, error: 'O ID do usuário é obrigatório.' });
    }

    try {
        const userQuery = await pool.query(
            `SELECT id, name, email, phone, restaurant_id FROM users WHERE id = $1`,
            [userId]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
        }

        const user = userQuery.rows[0];

        // Buscar os dados do restaurante associado ao usuário
        let restaurant = null;
        if (user.restaurant_id) {
            const restaurantQuery = await pool.query(
                `SELECT * FROM restaurants WHERE id = $1`,
                [user.restaurant_id]
            );

            if (restaurantQuery.rows.length > 0) {
                restaurant = restaurantQuery.rows[0];
            }
        }

        res.json({ success: true, user, restaurant });
    } catch (err) {
        console.error("Erro ao buscar dados do usuário:", err);
        res.status(500).json({ success: false, error: "Erro interno do servidor." });
    }
});




app.get('/list-imoveis1', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM imoveis');

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Nenhum imóvel encontrado'
            });
        }

        res.json({
            success: true,
            imoveis: result.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});




app.get('/list-imoveis', async (req, res) => {
    try {
        let query = 'SELECT * FROM imoveis WHERE 1=1';
        const params = [];

        // Filtro por cidade (se fornecido)
        if (req.query.cidade) {
            const cidade = parseInt(req.query.cidade);
            if (isNaN(cidade)) {
                return res.status(400).json({ success: false, error: 'Cidade deve ser um número válido' });
            }
            query += ' AND cidade = $' + (params.length + 1);
            params.push(cidade);
        }

        // Filtro por preço (se fornecido)
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                const precoMin = parseFloat(req.query.precoMin);
                if (isNaN(precoMin)) {
                    return res.status(400).json({ success: false, error: 'Preço mínimo deve ser um número válido' });
                }
                query += ' AND valor >= $' + (params.length + 1);
                params.push(precoMin);
            }
            if (req.query.precoMax) {
                const precoMax = parseFloat(req.query.precoMax);
                if (isNaN(precoMax)) {
                    return res.status(400).json({ success: false, error: 'Preço máximo deve ser um número válido' });
                }
                query += ' AND valor <= $' + (params.length + 1);
                params.push(precoMax);
            }
        }

        // Paginação
        const limite = parseInt(req.query.limite) || 6; // Padrão: 6 itens por página
        const offset = parseInt(req.query.offset) || 0; // Padrão: início (pagina 1)
        if (isNaN(limite) || limite <= 0) {
            return res.status(400).json({ success: false, error: 'Limite deve ser um número positivo' });
        }
        if (isNaN(offset) || offset < 0) {
            return res.status(400).json({ success: false, error: 'Offset deve ser um número não negativo' });
        }
        query += ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limite, offset);

        // Log para depuração
        console.log('Query executada:', query);
        console.log('Parâmetros:', params);

        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Nenhum imóvel encontrado'
            });
        }

        // Calcula o total de imóveis com os mesmos filtros (sem LIMIT/OFFSET)
        let totalQuery = 'SELECT COUNT(*) FROM imoveis WHERE 1=1';
        let totalParams = [];

        if (req.query.cidade) {
            totalQuery += ' AND cidade = $1';
            totalParams.push(parseInt(req.query.cidade));
        }
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                totalQuery += ' AND valor >= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMin));
            }
            if (req.query.precoMax) {
                totalQuery += ' AND valor <= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMax));
            }
        }

        const totalResult = await pool.query(totalQuery, totalParams);
        const total = parseInt(totalResult.rows[0].count);

        res.json({
            success: true,
            imoveis: result.rows,
            total: total // Total para paginação
        });
    } catch (err) {
        console.error('Erro no servidor:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});




app.get("/get-imovel/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query("SELECT * FROM imoveis WHERE id = $1", [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Imóvel não encontrado" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.get('/list-cliientes', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /list-clientes");
        console.log("📥 Query Params recebidos:", req.query);

        let query = 'SELECT * FROM clientes WHERE 1=1';
        let values = [];
        let index = 1;

        // Filtros para a consulta de clientes
        if (req.query.tipo_imovel) {
            query += ` AND tipo_imovel = $${index}`;
            values.push(req.query.tipo_imovel);
            console.log(`📌 Filtro tipo_imovel: ${req.query.tipo_imovel}`);
            index++;
        }

        if (req.query.valor_max) {
            const valorMax = parseInt(req.query.valor_max);
            if (!isNaN(valorMax)) {
                query += ` AND valor <= $${index}`;
                values.push(valorMax);
                console.log(`📌 Filtro valor_max: ${valorMax}`);
                index++;
            } else {
                console.warn("⚠️ valor_max recebido não é um número válido:", req.query.valor_max);
            }
        }

        if (req.query.nome) {
            query += ` AND nome ILIKE $${index}`;
            values.push(`%${req.query.nome}%`);
            console.log(`📌 Filtro nome: ${req.query.nome}`);
            index++;
        }

        // Tratamento para paginação
        const limit = parseInt(req.query.limit) || 5; // Limite padrão de 5 itens
        const offset = parseInt(req.query.offset) || 0; // Padrão: começa do início

        query += ` LIMIT $${index} OFFSET $${index + 1}`;
        values.push(limit, offset);

        console.log("📝 Query gerada:", query);
        console.log("📊 Valores utilizados:", values);

        // Consulta principal
        const result = await pool.query(query, values);

        // Consulta para contar o número total de clientes aplicando os filtros
        let countQuery = 'SELECT COUNT(*) FROM clientes WHERE 1=1';
        let countValues = [];

        // Repetir os filtros na contagem
        if (req.query.tipo_imovel) {
            countQuery += ` AND tipo_imovel = $${countValues.length + 1}`;
            countValues.push(req.query.tipo_imovel);
        }

        if (req.query.valor_max) {
            const valorMax = parseInt(req.query.valor_max);
            if (!isNaN(valorMax)) {
                countQuery += ` AND valor <= $${countValues.length + 1}`;
                countValues.push(valorMax);
            }
        }

        if (req.query.nome) {
            countQuery += ` AND nome ILIKE $${countValues.length + 1}`;
            countValues.push(`%${req.query.nome}%`);
        }

        console.log("📝 Consulta de contagem gerada:", countQuery);
        console.log("📊 Valores utilizados na contagem:", countValues);

        const countResult = await pool.query(countQuery, countValues);
        const totalRegistros = parseInt(countResult.rows[0].count);

        console.log("✅ Consulta realizada com sucesso. Resultados encontrados:", result.rows.length);
        console.log("📊 Total de registros na base com filtros:", totalRegistros);

        res.json({
            clientes: result.rows,
            total: totalRegistros
        });
    } catch (err) {
        console.error("❌ Erro ao buscar clientes:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});





app.get('/list-clientes', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /list-clientes");
        console.log("📥 Query Params recebidos:", req.query);

        let query = 'SELECT * FROM clientes WHERE 1=1';
        let values = [];
        let index = 1;

        // Filtros para a consulta de clientes
        if (req.query.tipo_imovel) {
            query += ` AND tipo_imovel = $${index}`;
            values.push(req.query.tipo_imovel);
            console.log(`📌 Filtro tipo_imovel: ${req.query.tipo_imovel}`);
            index++;
        }

        // Filtro por categoria (1 = Médio Padrão, 2 = Alto Padrão)
        if (req.query.categoria) {
            const categoria = parseInt(req.query.categoria);
            if (!isNaN(categoria) && (categoria === 1 || categoria === 2)) {
                query += ` AND categoria = $${index}`;
                values.push(categoria);
                console.log(`📌 Filtro categoria: ${categoria === 1 ? 'Médio Padrão' : 'Alto Padrão'}`);
                index++;
            } else {
                console.warn("⚠️ categoria recebida não é válida (deve ser 1 ou 2):", req.query.categoria);
            }
        }

        // Filtro por intervalo de valor
        if (req.query.valor_min) {
            const valorMin = parseInt(req.query.valor_min);
            if (!isNaN(valorMin)) {
                query += ` AND valor >= $${index}`;
                values.push(valorMin);
                console.log(`📌 Filtro valor_min: ${valorMin}`);
                index++;
            } else {
                console.warn("⚠️ valor_min recebido não é um número válido:", req.query.valor_min);
            }
        }

        if (req.query.valor_max) {
            const valorMax = parseInt(req.query.valor_max);
            if (!isNaN(valorMax)) {
                query += ` AND valor <= $${index}`;
                values.push(valorMax);
                console.log(`📌 Filtro valor_max: ${valorMax}`);
                index++;
            } else {
                console.warn("⚠️ valor_max recebido não é um número válido:", req.query.valor_max);
            }
        }

        if (req.query.nome) {
            query += ` AND nome ILIKE $${index}`;
            values.push(`%${req.query.nome}%`);
            console.log(`📌 Filtro nome: ${req.query.nome}`);
            index++;
        }

        // Ordenação por valor_lead
        if (req.query.ordenacao) {
            if (req.query.ordenacao === 'maior-menor') {
                query += ` ORDER BY valor_lead DESC`;
                console.log(`📌 Ordenação: Maior para Menor (valor_lead DESC)`);
            } else if (req.query.ordenacao === 'menor-maior') {
                query += ` ORDER BY valor_lead ASC`;
                console.log(`📌 Ordenação: Menor para Maior (valor_lead ASC)`);
            } else {
                console.warn("⚠️ Ordenação inválida recebida:", req.query.ordenacao);
            }
        }

        // Tratamento para paginação
        const limit = parseInt(req.query.limit) || 20; // Limite padrão ajustado para 20
        const offset = parseInt(req.query.offset) || 0;

        query += ` LIMIT $${index} OFFSET $${index + 1}`;
        values.push(limit, offset);

        console.log("📝 Query gerada:", query);
        console.log("📊 Valores utilizados:", values);

        // Consulta principal
        const result = await pool.query(query, values);

        // Consulta para contar o número total de clientes aplicando os filtros
        let countQuery = 'SELECT COUNT(*) FROM clientes WHERE 1=1';
        let countValues = [];
        let countIndex = 1;

        // Repetir os filtros na contagem
        if (req.query.tipo_imovel) {
            countQuery += ` AND tipo_imovel = $${countIndex}`;
            countValues.push(req.query.tipo_imovel);
            countIndex++;
        }

        if (req.query.categoria) {
            const categoria = parseInt(req.query.categoria);
            if (!isNaN(categoria) && (categoria === 1 || categoria === 2)) {
                countQuery += ` AND categoria = $${countIndex}`;
                countValues.push(categoria);
                countIndex++;
            }
        }

        if (req.query.valor_min) {
            const valorMin = parseInt(req.query.valor_min);
            if (!isNaN(valorMin)) {
                countQuery += ` AND valor >= $${countIndex}`;
                countValues.push(valorMin);
                countIndex++;
            }
        }

        if (req.query.valor_max) {
            const valorMax = parseInt(req.query.valor_max);
            if (!isNaN(valorMax)) {
                countQuery += ` AND valor <= $${countIndex}`;
                countValues.push(valorMax);
                countIndex++;
            }
        }

        if (req.query.nome) {
            countQuery += ` AND nome ILIKE $${countIndex}`;
            countValues.push(`%${req.query.nome}%`);
            countIndex++;
        }

        console.log("📝 Consulta de contagem gerada:", countQuery);
        console.log("📊 Valores utilizados na contagem:", countValues);

        const countResult = await pool.query(countQuery, countValues);
        const totalRegistros = parseInt(countResult.rows[0].count);

        console.log("✅ Consulta realizada com sucesso. Resultados encontrados:", result.rows.length);
        console.log("📊 Total de registros na base com filtros:", totalRegistros);

        res.json({
            clientes: result.rows,
            total: totalRegistros
        });
    } catch (err) {
        console.error("❌ Erro ao buscar clientes:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});





// Rota para listar corretores com filtros, incluindo o filtro por id
app.get('/list-corretores', async (req, res) => {
    const { name, email, creci, id } = req.query;  // Obtendo os parâmetros de filtro da query string

    // Construindo a parte da consulta com base nos filtros fornecidos
    let query = 'SELECT * FROM corretores WHERE 1=1';
    let params = [];

    if (id) {
        query += ' AND id = $' + (params.length + 1);
        params.push(id);  // Filtro por id (exato)
    }

    if (name) {
        query += ' AND name ILIKE $' + (params.length + 1);
        params.push('%' + name + '%');  // Filtro por nome (usando ILIKE para não diferenciar maiúsculas/minúsculas)
    }

    if (email) {
        query += ' AND email ILIKE $' + (params.length + 1);
        params.push('%' + email + '%');  // Filtro por e-mail
    }

    if (creci) {
        query += ' AND creci = $' + (params.length + 1);
        params.push(creci);  // Filtro por creci
    }

    try {
        const result = await pool.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Nenhum corretor encontrado' });
        }

        res.json({ success: true, corretores: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para listar os imóveis de um corretor, baseado no array de IDs na tabela "corretores"
app.get('/list-imoveis/:id', async (req, res) => {
    const corretorId = req.params.id;  // Obtendo o ID do corretor a partir da URL

    try {
        // Consulta para obter o array de IDs de imóveis do corretor
        const corretorResult = await pool.query(
            'SELECT imoveis FROM corretores WHERE id = $1',
            [corretorId]  // Passando o ID do corretor como parâmetro
        );

        // Verificando se o corretor foi encontrado
        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const imoveisIds = corretorResult.rows[0].imoveis;

        // Verificando se o corretor tem imóveis associados
        if (!imoveisIds || imoveisIds.length === 0) {
            return res.status(404).json({ success: false, message: 'Nenhum imóvel associado a este corretor' });
        }

        // Consulta para obter os imóveis com base nos IDs
        const imoveisResult = await pool.query(
            'SELECT * FROM imoveis WHERE id = ANY($1)', 
            [imoveisIds]  // Passando o array de IDs de imóveis
        );

        // Retornando os imóveis encontrados
        res.json({ success: true, imoveis: imoveisResult.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



// Rota para listar os clientes de um corretor, baseado no array de IDs na tabela "corretores"
app.get('/list-clientes/:id', async (req, res) => {
    const corretorId = req.params.id;  // Obtendo o ID do corretor a partir da URL

    try {
        // Consulta para obter o array de IDs de clientes do corretor
        const corretorResult = await pool.query(
            'SELECT clientes FROM corretores WHERE id = $1',
            [corretorId]  // Passando o ID do corretor como parâmetro
        );

        // Verificando se o corretor foi encontrado
        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const clientesIds = corretorResult.rows[0].clientes;

        // Verificando se o corretor tem clientes associados
        if (!clientesIds || clientesIds.length === 0) {
            return res.status(404).json({ success: false, message: 'Nenhum cliente associado a este corretor' });
        }

        // Consulta para obter os clientes com base nos IDs
        const clientesResult = await pool.query(
            'SELECT * FROM clientes WHERE id = ANY($1)', 
            [clientesIds]  // Passando o array de IDs de clientes
        );

        // Retornando os clientes encontrados
        res.json({ success: true, clientes: clientesResult.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});







// Função para gerar um token aleatório
function gerarToken() {
    return crypto.randomBytes(32).toString('hex');
}

// 📌 Rota de login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    try {
        const result = await pool.query("SELECT id, password, token FROM corretores WHERE email = $1", [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Email ou senha inválidos." });
        }

        const corretor = result.rows[0];

        // Comparação direta da senha sem criptografia
        if (password !== corretor.password) {
            return res.status(401).json({ error: "Email ou senha inválidos." });
        }

        res.json({ id: corretor.id, token: corretor.token });
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});

// 📌 Rota para criar um corretor
app.post('/corretores', async (req, res) => {
    const { email, password, phone, creci, name } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    try {
        // Verifica se o email já está cadastrado
        const checkEmail = await pool.query("SELECT id FROM corretores WHERE email = $1", [email]);
        if (checkEmail.rows.length > 0) {
            return res.status(400).json({ error: "Email já está em uso." });
        }

        const token = gerarToken();

        const result = await pool.query(
            "INSERT INTO corretores (email, password, phone, creci, name, token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, token",
            [email, password, phone || null, creci || null, name || null, token]
        );

        res.status(201).json({ id: result.rows[0].id, token: result.rows[0].token });
    } catch (error) {
        console.error("Erro ao criar corretor:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});


// 📌 Rota para obter informações do corretor
app.get('/corretor', async (req, res) => {
    const { id, token } = req.query; // Pegando id e token dos parâmetros da URL

    if (!id || !token) {
        return res.status(400).json({ error: "ID e Token são obrigatórios." });
    }

    try {
        const result = await pool.query(
            "SELECT email, phone, token, id, creci, imoveis, clientes, name FROM corretores WHERE id = $1 AND token = $2",
            [id, token]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Credenciais inválidas." });
        }

        res.json(result.rows[0]); // Retorna os dados do corretor
    } catch (error) {
        console.error("Erro ao buscar corretor:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});



app.get('/cidades', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM cidades');
        
        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Nenhuma cidade encontrada'
            });
        }

        res.setHeader("Access-Control-Allow-Origin", "*"); // Permite acesso de qualquer domínio
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
