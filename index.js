const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios'); // Adicionado o módulo axios
require('dotenv').config();
const cors = require('cors');

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

        ws.subscription = { table, column, value };
        console.log(`✅ Cliente inscrito para ouvir ${table} onde ${column} = ${value}`);

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

listenForNotifications();














// Rota para listar todas as tabelas do banco de dados
app.get('/tables', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        const tables = result.rows.map(row => ({ name: row.table_name }));
        res.json(tables);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar tabelas' });
    }
});

// Rota para criar uma nova tabela com uma coluna 'id' padrão
app.post('/tables', async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query(`CREATE TABLE ${name} (id SERIAL PRIMARY KEY)`);
        res.status(201).json({ message: `Tabela '${name}' criada com sucesso` });
        broadcastUpdate(name);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar tabela' });
    }
});

// Rota para obter colunas e dados de uma tabela específica
app.get('/tables/:tableName', async (req, res) => {
    const { tableName } = req.params;
    try {
        const columns = await pool.query(`
            SELECT column_name as name 
            FROM information_schema.columns 
            WHERE table_name = $1
        `, [tableName]);
        
        const rows = await pool.query(`SELECT * FROM ${tableName}`);
        res.json({ columns: columns.rows, rows: rows.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar dados da tabela' });
    }
});

app.post('/tables/:tableName/columns', async (req, res) => {
    const { tableName } = req.params;
    const { name, type, nullable = true, unique = false, indexed = false } = req.body;

    try {
        // Constrói a query base para adicionar a coluna
        let query = `ALTER TABLE ${tableName} ADD COLUMN ${name} ${type}`;
        if (!nullable) {
            query += ' NOT NULL';
        }

        // Executa a query base
        await pool.query(query);

        // Adiciona restrição UNIQUE, se necessário
        if (unique) {
            await pool.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${tableName}_${name}_unique UNIQUE (${name})`);
        }

        // Cria índice, se necessário
        if (indexed) {
            await pool.query(`CREATE INDEX ${tableName}_${name}_idx ON ${tableName} (${name})`);
        }

        res.status(201).json({ message: `Coluna '${name}' adicionada à tabela '${tableName}'` });
        broadcastUpdate(tableName);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao adicionar coluna' });
    }
});

// Rota para adicionar uma nova linha a uma tabela (valores padrão)
app.post('/tables/:tableName/rows', async (req, res) => {
    const { tableName } = req.params;
    try {
        await pool.query(`INSERT INTO ${tableName} DEFAULT VALUES`);
        res.status(201).json({ message: `Nova linha adicionada à tabela '${tableName}'` });
        broadcastUpdate(tableName);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao adicionar linha' });
    }
});

// Função auxiliar para notificar clientes WebSocket sobre atualizações
function broadcastUpdate(tableName) {
    wsServer.clients.forEach(async (client) => {
        if (client.readyState === WebSocket.OPEN && client.subscription?.table === tableName) {
            const result = await pool.query(
                `SELECT * FROM ${tableName} WHERE ${client.subscription.column} = $1`, 
                [client.subscription.value]
            );
            client.send(JSON.stringify({ table: tableName, data: result.rows }));
        }
    });
}

// Rota para editar uma linha específica
app.put('/tables/:tableName/rows/:id', async (req, res) => {
    const { tableName, id } = req.params;
    const data = req.body;
    try {
        const columns = Object.keys(data).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const values = Object.values(data);
        values.unshift(id); // Adiciona o ID como primeiro parâmetro
        await pool.query(`UPDATE ${tableName} SET ${columns} WHERE id = $1`, values);
        res.status(200).json({ message: `Linha ${id} atualizada na tabela '${tableName}'` });
        broadcastUpdate(tableName);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao editar linha' });
    }
});

// Rota para excluir uma linha específica
app.delete('/tables/:tableName/rows/:id', async (req, res) => {
    const { tableName, id } = req.params;
    try {
        await pool.query(`DELETE FROM ${tableName} WHERE id = $1`, [id]);
        res.status(200).json({ message: `Linha ${id} excluída da tabela '${tableName}'` });
        broadcastUpdate(tableName);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao excluir linha' });
    }
});

app.delete('/tables/:tableName', async (req, res) => {
    const { tableName } = req.params;
    try {
        await pool.query(`DROP TABLE ${tableName}`);
        res.status(200).json({ message: `Tabela '${tableName}' excluída com sucesso` });
        broadcastUpdate(tableName); // Notifica clientes, se necessário
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao excluir tabela' });
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
        // Query principal para buscar imóveis com a primeira imagem onde livre = true
        let query = `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT json_build_object(
                        'id', images.id,
                        'url', images.url,
                        'livre', images.livre,
                        'afiliados', images.afiliados,
                        'compradores', images.compradores
                    )
                     FROM images 
                     WHERE images.imovel = i.id 
                     AND images.livre = true 
                     ORDER BY images.id 
                     LIMIT 1), 
                    NULL
                ) AS imagem
            FROM imoveis i
            WHERE 1=1
        `;
        const params = [];

        // Filtro por disponibilidade (opcional)
        if (req.query.disponivel !== undefined) {
            const disponivel = req.query.disponivel.toLowerCase() === 'true';
            query += ' AND i.disponivel = $' + (params.length + 1);
            params.push(disponivel);
        }

        // Filtro por cidade (se fornecido)
        if (req.query.cidade) {
            const cidade = parseInt(req.query.cidade);
            if (isNaN(cidade)) {
                return res.status(400).json({ success: false, error: 'Cidade deve ser um número válido' });
            }
            query += ' AND i.cidade = $' + (params.length + 1);
            params.push(cidade);
        }

        // Filtro por preço (se fornecido)
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                const precoMin = parseFloat(req.query.precoMin);
                if (isNaN(precoMin)) {
                    return res.status(400).json({ success: false, error: 'Preço mínimo deve ser um número válido' });
                }
                query += ' AND i.valor >= $' + (params.length + 1);
                params.push(precoMin);
            }
            if (req.query.precoMax) {
                const precoMax = parseFloat(req.query.precoMax);
                if (isNaN(precoMax)) {
                    return res.status(400).json({ success: false, error: 'Preço máximo deve ser um número válido' });
                }
                query += ' AND i.valor <= $' + (params.length + 1);
                params.push(precoMax);
            }
        }

        // Paginação
        const limite = parseInt(req.query.limite) || 6;
        const offset = parseInt(req.query.offset) || 0;
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

        // Calcula o total de imóveis com os mesmos filtros (sem LIMIT/OFFSET)
        let totalQuery = 'SELECT COUNT(*) FROM imoveis i WHERE 1=1';
        let totalParams = [];

        if (req.query.disponivel !== undefined) {
            const disponivel = req.query.disponivel.toLowerCase() === 'true';
            totalQuery += ' AND i.disponivel = $' + (totalParams.length + 1);
            totalParams.push(disponivel);
        }

        if (req.query.cidade) {
            totalQuery += ' AND i.cidade = $' + (totalParams.length + 1);
            totalParams.push(parseInt(req.query.cidade));
        }
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                totalQuery += ' AND i.valor >= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMin));
            }
            if (req.query.precoMax) {
                totalQuery += ' AND i.valor <= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMax));
            }
        }

        const totalResult = await pool.query(totalQuery, totalParams);
        const total = parseInt(totalResult.rows[0].count);

        // Retorna os resultados
        if (result.rowCount === 0) {
            return res.status(200).json({
                success: false,
                imoveis: [],
                total: 0,
                message: 'Nenhum imóvel encontrado para os filtros aplicados'
            });
        }

        // Log para verificar os dados retornados
        console.log('Imóveis retornados:', result.rows);

        res.json({
            success: true,
            imoveis: result.rows,
            total: total
        });
    } catch (err) {
        console.error('Erro no servidor:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});


app.get('/list-imoveis/disponiveis', async (req, res) => {
    try {
        let query = `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT json_build_object(
                        'id', images.id,
                        'url', images.url,
                        'livre', images.livre,
                        'afiliados', images.afiliados,
                        'compradores', images.compradores
                    )
                     FROM images 
                     WHERE images.imovel = i.id 
                     AND images.livre = true 
                     ORDER BY images.id 
                     LIMIT 1), 
                    NULL
                ) AS imagem
            FROM imoveis i
            WHERE i.disponivel = TRUE
        `;
        const params = [];

        // Filtro por cidade (se fornecido)
        if (req.query.cidade) {
            const cidade = parseInt(req.query.cidade);
            if (isNaN(cidade)) {
                return res.status(400).json({ success: false, error: 'Cidade deve ser um número válido' });
            }
            query += ' AND i.cidade = $' + (params.length + 1);
            params.push(cidade);
        }

        // Filtro por preço (se fornecido)
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                const precoMin = parseFloat(req.query.precoMin);
                if (isNaN(precoMin)) {
                    return res.status(400).json({ success: false, error: 'Preço mínimo deve ser um número válido' });
                }
                query += ' AND i.valor >= $' + (params.length + 1);
                params.push(precoMin);
            }
            if (req.query.precoMax) {
                const precoMax = parseFloat(req.query.precoMax);
                if (isNaN(precoMax)) {
                    return res.status(400).json({ success: false, error: 'Preço máximo deve ser um número válido' });
                }
                query += ' AND i.valor <= $' + (params.length + 1);
                params.push(precoMax);
            }
        }

        // Filtro por destaque (se fornecido)
        if (req.query.destaque) {
            const destaque = req.query.destaque === 'true'; // Converte string 'true' para booleano
            query += ' AND i.destaque = $' + (params.length + 1);
            params.push(destaque);
            console.log(`📌 Filtro destaque: ${destaque}`);
        }

        // Paginação
        const limite = parseInt(req.query.limite) || 6;
        const offset = parseInt(req.query.offset) || 0;
        if (isNaN(limite) || limite <= 0) {
            return res.status(400).json({ success: false, error: 'Limite deve ser um número positivo' });
        }
        if (isNaN(offset) || offset < 0) {
            return res.status(400).json({ success: false, error: 'Offset deve ser um número não negativo' });
        }
        query += ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limite, offset);

        console.log('Query executada (disponíveis):', query);
        console.log('Parâmetros:', params);

        const result = await pool.query(query, params);

        // Calcula o total de imóveis disponíveis com os mesmos filtros
        let totalQuery = 'SELECT COUNT(*) FROM imoveis i WHERE i.disponivel = TRUE';
        let totalParams = [];

        if (req.query.cidade) {
            totalQuery += ' AND i.cidade = $1';
            totalParams.push(parseInt(req.query.cidade));
        }
        if (req.query.precoMin || req.query.precoMax) {
            if (req.query.precoMin) {
                totalQuery += ' AND i.valor >= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMin));
            }
            if (req.query.precoMax) {
                totalQuery += ' AND i.valor <= $' + (totalParams.length + 1);
                totalParams.push(parseFloat(req.query.precoMax));
            }
        }
        if (req.query.destaque) {
            totalQuery += ' AND i.destaque = $' + (totalParams.length + 1);
            totalParams.push(req.query.destaque === 'true');
        }

        const totalResult = await pool.query(totalQuery, totalParams);
        const total = parseInt(totalResult.rows[0].count);

        if (result.rowCount === 0) {
            return res.status(200).json({
                success: false,
                imoveis: [],
                total: 0,
                message: 'Nenhum imóvel disponível encontrado para os filtros aplicados'
            });
        }

        res.json({
            success: true,
            imoveis: result.rows,
            total: total
        });
    } catch (err) {
        console.error('Erro no servidor (disponíveis):', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});




app.get("/get-imov1el/:id", async (req, res) => {
    const { id } = req.params;

    try {
        // Consulta combinada para pegar o imóvel e suas imagens onde livre = true
        const result = await pool.query(
            `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT array_agg(url) 
                     FROM images 
                     WHERE images.imovel = i.id 
                     AND images.livre = true), 
                    ARRAY[]::text[]
                ) AS imagens
            FROM imoveis i
            WHERE i.id = $1
            `,
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Imóvel não encontrado" });
        }

        // Adiciona console.log para mostrar as imagens do imóvel
        console.log(`Imagens do imóvel ${id}:`, result.rows[0].imagens);

        // Retorna o primeiro (e único) resultado com as imagens incluídas
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Erro na consulta do imóvel:", err);
        res.status(500).json({ error: err.message });
    }
});


app.get("/get-imovel/:id", async (req, res) => {
    const { id } = req.params;

    try {
        // Consulta combinada para pegar o imóvel e todas as suas imagens
        const result = await pool.query(
            `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', images.id,  -- Adicionado o ID da imagem
                        'url', url,
                        'livre', livre,
                        'afiliados', afiliados,
                        'compradores', compradores
                    ))
                     FROM images 
                     WHERE images.imovel = i.id), 
                    '[]'::json
                ) AS imagens
            FROM imoveis i
            WHERE i.id = $1
            `,
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Imóvel não encontrado" });
        }

        // Adiciona console.log para mostrar os dados do imóvel e imagens
        console.log(`Dados do imóvel ${id}:`, result.rows[0]);
        console.log(`Imagens do imóvel ${id}:`, result.rows[0].imagens);

        // Retorna o primeiro (e único) resultado com as imagens incluídas
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Erro na consulta do imóvel:", err);
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
        // Consulta para obter os arrays de IDs de imóveis comprados e afiliados do corretor
        const corretorResult = await pool.query(
            'SELECT imoveis_comprados, imoveis_afiliados FROM corretores WHERE id = $1',
            [corretorId]
        );
        console.log('Resultado da consulta de corretores:', corretorResult.rows);

        // Verificando se o corretor foi encontrado
        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const imoveisComprados = corretorResult.rows[0].imoveis_comprados || [];
        const imoveisAfiliados = corretorResult.rows[0].imoveis_afiliados || [];

        // Combinando os IDs de imóveis comprados e afiliados (removendo duplicatas, se necessário)
        const todosImoveisIds = [...new Set([...imoveisComprados, ...imoveisAfiliados])];

        // Verificando se o corretor tem imóveis associados
        if (todosImoveisIds.length === 0) {
            return res.status(404).json({ success: false, message: 'Nenhum imóvel associado a este corretor' });
        }

        // Consulta para obter os imóveis com base nos IDs, incluindo a primeira imagem com livre = true
        const imoveisResult = await pool.query(
            `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT json_build_object(
                        'id', images.id,
                        'url', images.url,
                        'livre', images.livre,
                        'afiliados', images.afiliados,
                        'compradores', images.compradores
                    )
                     FROM images 
                     WHERE images.imovel = i.id 
                     AND images.livre = true 
                     ORDER BY images.id 
                     LIMIT 1), 
                    NULL
                ) AS imagem
            FROM imoveis i
            WHERE i.id = ANY($1)
            `,
            [todosImoveisIds]
        );
        console.log('Resultado da consulta de imóveis:', imoveisResult.rows);

        // Adicionando a informação de origem (comprado ou afiliado) a cada imóvel
        const imoveisComOrigem = imoveisResult.rows.map(imovel => {
            const origem = imoveisComprados.includes(imovel.id) 
                ? (imoveisAfiliados.includes(imovel.id) ? 'ambos' : 'comprado') 
                : 'afiliado';
            return { ...imovel, origem };
        });

        // Retornando os imóveis encontrados com a informação de origem
        res.json({ success: true, imoveis: imoveisComOrigem });
    } catch (err) {
        console.error('Erro na rota /list-imoveis:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});



// Rota para remover um imóvel da lista de afiliados de um corretor
app.delete('/remover-afiliacao/:corretorId/:imovelId', async (req, res) => {
    const corretorId = req.params.corretorId;
    const imovelId = parseInt(req.params.imovelId);

    try {
        // Consulta para obter o array de imoveis_afiliados do corretor
        const corretorResult = await pool.query(
            'SELECT imoveis_afiliados FROM corretores WHERE id = $1',
            [corretorId]
        );

        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const imoveisAfiliados = corretorResult.rows[0].imoveis_afiliados || [];

        // Verificar se o imóvel está na lista de afiliados
        if (!imoveisAfiliados.includes(imovelId)) {
            return res.status(400).json({ success: false, message: 'Imóvel não está na lista de afiliados' });
        }

        // Atualizar a lista removendo o imóvel
        const novosImoveisAfiliados = imoveisAfiliados.filter(id => id !== imovelId);
        await pool.query(
            'UPDATE corretores SET imoveis_afiliados = $1 WHERE id = $2',
            [novosImoveisAfiliados, corretorId]
        );

        res.json({ success: true, message: 'Afiliação removida com sucesso' });
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
// 📌 Rota para criar um corretor
app.post('/corretores', async (req, res) => {
    const { email, password, phone, creci, name } = req.body;

    console.log("🚀 Iniciando criação de corretor - Dados recebidos:", req.body);

    if (!email || !password) {
        console.log("❌ Erro: Email ou senha ausentes");
        return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    try {
        // Etapa 1: Verifica se o email já está cadastrado
        console.log("🔍 Verificando se o email já existe no banco...");
        const checkEmail = await pool.query("SELECT id FROM corretores WHERE email = $1", [email]);
        if (checkEmail.rows.length > 0) {
            console.log("❌ Erro: Email já está em uso -", email);
            return res.status(400).json({ error: "Email já está em uso." });
        }
        console.log("✅ Email disponível:", email);

        // Etapa 2: Cria o customer no Asaas
        console.log("💳 Criando customer no Asaas...");
        console.log("🔑 Usando ASAAS_API_URL:", process.env.ASAAS_API_URL);
        console.log("🔑 Usando ASAAS_API_KEY (primeiros 5 caracteres):", process.env.ASAAS_API_KEY?.substring(0, 5) + "...");
        
        const asaasResponse = await axios.post(
            `${process.env.ASAAS_API_URL}/customers`,
            {
                name: name || "Corretor sem nome",
                cpfCnpj: creci || "00000000000",
                email,
                mobilePhone: phone || null
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.ASAAS_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const asaasId = asaasResponse.data.id;
        console.log(`✅ Customer criado no Asaas com sucesso. ID: ${asaasId}`);

        // Etapa 3: Gera o token
        console.log("🔑 Gerando token para o corretor...");
        const token = gerarToken();
        console.log(`✅ Token gerado: ${token}`);

        // Etapa 4: Insere o corretor no banco com o asaas_id
        console.log("📝 Inserindo corretor no banco de dados...");
        const result = await pool.query(
            "INSERT INTO corretores (email, password, phone, creci, name, token, asaas_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, token",
            [email, password, phone || null, creci || null, name || null, token, asaasId]
        );
        console.log(`✅ Corretor inserido no banco. ID: ${result.rows[0].id}`);

        // Etapa 5: Retorna a resposta
        console.log("📤 Enviando resposta ao cliente...");
        res.status(201).json({
            id: result.rows[0].id,
            token: result.rows[0].token,
            asaas_id: asaasId
        });
        console.log("✅ Resposta enviada com sucesso");

    } catch (error) {
        console.error("❌ Erro ao criar corretor:");
        if (error.response) {
            console.error("   - Detalhes do erro do Asaas:", error.response.data);
            console.error("   - Status HTTP:", error.response.status);
            console.error("   - Headers enviados:", error.response.config.headers);
        } else {
            console.error("   - Erro interno (não relacionado ao Asaas):", error.message);
        }
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




// Rota para cadastrar imóvel (sem imagens)
app.post('/imoveis/novo', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        console.log('Dados recebidos do frontend (imóvel):', req.body);

        const imovelData = {
            valor: req.body.valor || null,
            banheiros: req.body.banheiros || null,
            metros_quadrados: req.body.metros_quadrados || null,
            andar: req.body.andar || null,
            mobiliado: req.body.mobiliado === 'sim' ? true : false,
            price_contato: req.body.price_contato || '39.90',
            vagas_garagem: req.body.vagas_garagem || '0',
            cidade: req.body.cidade || null,
            categoria: req.body.categoria || null,
            quartos: req.body.quartos || null,
            texto_principal: req.body.texto_principal || '',
            whatsapp: req.body.whatsapp || '',
            tipo: req.body.tipo || '',
            endereco: req.body.endereco || '',
            descricao: req.body.descricao || '',
            nome_proprietario: req.body.nome_proprietario || '',
            descricao_negociacao: req.body.descricao_negociacao || ''
        };

        const requiredFields = {
            banheiros: 'Banheiros',
            endereco: 'Endereço',
            metros_quadrados: 'Metros Quadrados',
            quartos: 'Quartos',
            texto_principal: 'Título Principal',
            tipo: 'Tipo',
            valor: 'Valor'
        };
        const missingFields = Object.entries(requiredFields)
            .filter(([key]) => !imovelData[key] || imovelData[key] === '' || imovelData[key] === undefined)
            .map(([, label]) => label);

        if (missingFields.length > 0) {
            throw new Error(`Campos obrigatórios faltando: ${missingFields.join(', ')}`);
        }

        const imovelQuery = `
            INSERT INTO imoveis (valor, banheiros, metros_quadrados, andar, mobiliado, price_contato, vagas_garagem, cidade, categoria, quartos, texto_principal, whatsapp, tipo, endereco, descricao, nome_proprietario, descricao_negociacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING id
        `;
        const imovelValues = [
            imovelData.valor, imovelData.banheiros, imovelData.metros_quadrados, imovelData.andar,
            imovelData.mobiliado, imovelData.price_contato, imovelData.vagas_garagem, imovelData.cidade,
            imovelData.categoria, imovelData.quartos, imovelData.texto_principal, imovelData.whatsapp,
            imovelData.tipo, imovelData.endereco, imovelData.descricao, imovelData.nome_proprietario,
            imovelData.descricao_negociacao
        ];
        const imovelResult = await client.query(imovelQuery, imovelValues);
        const imovelId = imovelResult.rows[0].id;

        await client.query('COMMIT');
        res.json({ success: true, message: 'Imóvel cadastrado com sucesso', imovelId });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao cadastrar imóvel:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});

// Rota para cadastrar imagens
app.post('/imoveis/:id/imagens', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        const { url, livre, afiliados, compradores } = req.body;

        console.log(`Cadastrando imagem para imóvel ${imovelId}:`, req.body);

        const imagemQuery = `
            INSERT INTO images (imovel, url, livre, afiliados, compradores, disponible)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        await client.query(imagemQuery, [
            imovelId, url, livre, afiliados, compradores, true
        ]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Imagem cadastrada com sucesso' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao cadastrar imagem:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});


// Rota para excluir imagens
app.delete('/imoveis/:id/imagens/:imagemId', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        const imagemId = req.params.imagemId;

        console.log(`Excluindo imagem ${imagemId} do imóvel ${imovelId}`);

        const deleteQuery = `
            DELETE FROM images 
            WHERE imovel = $1 AND id = $2
        `;
        const result = await client.query(deleteQuery, [imovelId, imagemId]);

        if (result.rowCount === 0) {
            throw new Error('Imagem não encontrada');
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Imagem excluída com sucesso' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao excluir imagem:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});


// Rota para atualizar um imóvel existente
app.put('/imoveis/:id', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        const imovelData = {
            valor: req.body.valor || null,
            banheiros: req.body.banheiros || null,
            metros_quadrados: req.body.metros_quadrados || null,
            andar: req.body.andar || null,
            mobiliado: req.body.mobiliado === 'sim' ? true : false,
            price_contato: req.body.price_contato || '39.90',
            vagas_garagem: req.body.vagas_garagem || '0',
            cidade: req.body.cidade || null,
            categoria: req.body.categoria || null,
            quartos: req.body.quartos || null,
            texto_principal: req.body.texto_principal || '',
            whatsapp: req.body.whatsapp || '',
            tipo: req.body.tipo || '',
            endereco: req.body.endereco || '',
            descricao: req.body.descricao || '',
            nome_proprietario: req.body.nome_proprietario || '',
            descricao_negociacao: req.body.descricao_negociacao || ''
        };

        const requiredFields = {
            banheiros: 'Banheiros',
            endereco: 'Endereço',
            metros_quadrados: 'Metros Quadrados',
            quartos: 'Quartos',
            texto_principal: 'Título Principal',
            tipo: 'Tipo',
            valor: 'Valor'
        };
        const missingFields = Object.entries(requiredFields)
            .filter(([key]) => !imovelData[key] || imovelData[key] === '' || imovelData[key] === undefined)
            .map(([, label]) => label);

        if (missingFields.length > 0) {
            throw new Error(`Campos obrigatórios faltando: ${missingFields.join(', ')}`);
        }

        const updateQuery = `
            UPDATE imoveis
            SET valor = $1, banheiros = $2, metros_quadrados = $3, andar = $4, mobiliado = $5,
                price_contato = $6, vagas_garagem = $7, cidade = $8, categoria = $9, quartos = $10,
                texto_principal = $11, whatsapp = $12, tipo = $13, endereco = $14, descricao = $15,
                nome_proprietario = $16, descricao_negociacao = $17
            WHERE id = $18
            RETURNING id
        `;
        const values = [
            imovelData.valor, imovelData.banheiros, imovelData.metros_quadrados, imovelData.andar,
            imovelData.mobiliado, imovelData.price_contato, imovelData.vagas_garagem, imovelData.cidade,
            imovelData.categoria, imovelData.quartos, imovelData.texto_principal, imovelData.whatsapp,
            imovelData.tipo, imovelData.endereco, imovelData.descricao, imovelData.nome_proprietario,
            imovelData.descricao_negociacao, imovelId
        ];

        const result = await client.query(updateQuery, values);

        if (result.rows.length === 0) {
            throw new Error('Imóvel não encontrado');
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Imóvel atualizado com sucesso', imovelId });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao atualizar imóvel:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});


// Rota para atualizar uma imagem existente
app.put('/imoveis/:id/imagens/:imagemId', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        const imagemId = req.params.imagemId;
        const { url, livre, afiliados, compradores } = req.body;

        console.log(`Atualizando imagem ${imagemId} do imóvel ${imovelId}:`, req.body);

        const updateQuery = `
            UPDATE images 
            SET url = $1, livre = $2, afiliados = $3, compradores = $4
            WHERE imovel = $5 AND id = $6
            RETURNING id
        `;
        const result = await client.query(updateQuery, [url, livre, afiliados, compradores, imovelId, imagemId]);

        if (result.rowCount === 0) {
            throw new Error('Imagem não encontrada');
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Imagem atualizada com sucesso' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao atualizar imagem:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});


// Rota para atualizar apenas os toggles (disponivel e destaque) do imóvel
app.put('/imoveis/toggles/:id', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        const { disponivel, destaque } = req.body;

        // Verifica se pelo menos um campo foi fornecido
        if (disponivel === undefined && destaque === undefined) {
            throw new Error('Nenhum campo fornecido para atualização');
        }

        // Construir a query dinamicamente com base nos campos fornecidos
        let updateFields = [];
        let values = [];
        let paramCount = 1;

        if (disponivel !== undefined) {
            updateFields.push(`disponivel = $${paramCount}`);
            values.push(disponivel);
            paramCount++;
        }
        if (destaque !== undefined) {
            updateFields.push(`destaque = $${paramCount}`);
            values.push(destaque);
            paramCount++;
        }

        values.push(imovelId); // Último parâmetro é o ID do imóvel

        const updateQuery = `
            UPDATE imoveis
            SET ${updateFields.join(', ')}
            WHERE id = $${paramCount}
            RETURNING id
        `;

        console.log(`Atualizando toggles do imóvel ${imovelId}:`, req.body);

        const result = await client.query(updateQuery, values);

        if (result.rowCount === 0) {
            throw new Error('Imóvel não encontrado');
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Toggles do imóvel atualizados com sucesso' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao atualizar toggles do imóvel:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    } finally {
        if (client) client.release();
    }
});


// Adicione esta rota ao seu arquivo de servidor (ex.: app.js ou routes.js)
app.delete('/imoveis/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Verifica se o imóvel existe antes de tentar excluí-lo
        const checkResult = await pool.query('SELECT * FROM imoveis WHERE id = $1', [id]);
        if (checkResult.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Imóvel não encontrado' });
        }

        // Exclui o imóvel
        const deleteResult = await pool.query('DELETE FROM imoveis WHERE id = $1', [id]);
        console.log(`Imóvel ${id} excluído com sucesso`);

        // Opcional: Excluir imagens associadas ao imóvel (se necessário)
        await pool.query('DELETE FROM images WHERE imovel = $1', [id]);
        console.log(`Imagens do imóvel ${id} excluídas`);

        res.json({ success: true, message: 'Imóvel excluído com sucesso' });
    } catch (err) {
        console.error('Erro ao excluir imóvel:', err.message, err.stack);
        res.status(500).json({ success: false, error: 'Erro no servidor ao excluir imóvel' });
    }
});





// Rota para criar um pedido com integração ao Asaas
app.post('/criar-pedido', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /criar-pedido");
        console.log("📥 Dados recebidos:", req.body);

        const { corretor, entregue, pago, imoveis_id, leads_id } = req.body;

        if (!corretor) {
            return res.status(400).json({ success: false, error: "O campo 'corretor' é obrigatório" });
        }

        let total_value = 0;

        if (imoveis_id && Array.isArray(imoveis_id) && imoveis_id.length > 0) {
            const imoveisQuery = `
                SELECT SUM(CAST(price_contato AS DECIMAL)) AS total_imoveis
                FROM imoveis
                WHERE id = ANY($1::integer[])
            `;
            const imoveisResult = await pool.query(imoveisQuery, [imoveis_id]);
            const totalImoveis = imoveisResult.rows[0].total_imoveis || 0;
            total_value += parseFloat(totalImoveis);
            console.log(`📌 Total dos imóveis (price_contato): ${totalImoveis}`);
        } else {
            console.log("📌 Nenhum imóvel fornecido (imoveis_id vazio ou nulo)");
        }

        if (leads_id && Array.isArray(leads_id) && leads_id.length > 0) {
            const leadsQuery = `
                SELECT SUM(CAST(valor_lead AS DECIMAL)) AS total_leads
                FROM clientes
                WHERE id = ANY($1::integer[])
            `;
            const leadsResult = await pool.query(leadsQuery, [leads_id]);
            const totalLeads = leadsResult.rows[0].total_leads || 0;
            total_value += parseFloat(totalLeads);
            console.log(`📌 Total dos leads (valor_lead): ${totalLeads}`);
        } else {
            console.log("📌 Nenhum lead fornecido (leads_id vazio ou nulo)");
        }

        total_value = isNaN(total_value) ? 0 : total_value;

        // Criação da cobrança no Asaas
        const asaasResponse = await axios.post(
            `${process.env.ASAAS_API_URL}/charges`,
            {
                billingType: "BOLETO", // Ou "PIX", "CREDIT_CARD", etc., conforme necessário
                customer: "cus_000005737255", // Substitua pelo ID do cliente no Asaas (pode vir do corretor)
                value: total_value,
                dueDate: new Date().toISOString().split('T')[0], // Data de vencimento (hoje como exemplo)
                description: `Pedido de imóveis e leads - Corretor ${corretor}`
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.ASAAS_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const cobranca_id = asaasResponse.data.id;
        console.log(`💳 Cobrança criada no Asaas. ID: ${cobranca_id}`);

        // Insere o pedido na tabela com o cobranca_id gerado
        const insertQuery = `
            INSERT INTO pedido (total_value, corretor, entregue, pago, cobranca_id, imoveis_id, leads_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `;
        const values = [
            total_value,
            corretor,
            entregue !== undefined ? entregue : false,
            pago !== undefined ? pago : false,
            cobranca_id,
            imoveis_id && imoveis_id.length > 0 ? imoveis_id : null,
            leads_id && leads_id.length > 0 ? leads_id : null
        ];

        console.log("📝 Query gerada:", insertQuery);
        console.log("📊 Valores utilizados:", values);

        const result = await pool.query(insertQuery, values);
        const pedidoId = result.rows[0].id;

        console.log(`✅ Pedido criado com sucesso. ID: ${pedidoId}, Total: ${total_value}`);

        res.status(201).json({
            success: true,
            pedido_id: pedidoId,
            total_value: total_value,
            cobranca_id: cobranca_id
        });
    } catch (error) {
        console.error("❌ Erro ao criar pedido:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});