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

// Instância para lead.meuleaditapema.com.br (porta 3002)
const appLead = express();
const portLead = 3002;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// Permite todas as origens
app.use(cors());
appLead.use(cors());

app.use(express.json());
appLead.use(express.json());

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




app.get("/get-imovel/:id", async (req, res) => {
    const { id } = req.params;

    try {
        // Consulta combinada para pegar o imóvel e todas as suas imagens
        const result = await pool.query(
            `
            SELECT 
                i.*, 
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'id', images.id,
                            'url', images.url,
                            'livre', images.livre,
                            'afiliados', images.afiliados,
                            'compradores', images.compradores
                        )
                    ) 
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

        // Adiciona console.log para mostrar as imagens do imóvel
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

        // Filtro por tipo de imóvel
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

        // Filtro por intervalo de valor (Preço de Interesse)
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

        // Filtros booleanos
        if (req.query.disponivel !== undefined) {
            const disponivel = req.query.disponivel === 'true' || req.query.disponivel === true;
            query += ` AND disponivel = $${index}`;
            values.push(disponivel);
            console.log(`📌 Filtro disponivel: ${disponivel}`);
            index++;
        }

        if (req.query.ai_created !== undefined) {
            const aiCreated = req.query.ai_created === 'true' || req.query.ai_created === true;
            query += ` AND ai_created = $${index}`;
            values.push(aiCreated);
            console.log(`📌 Filtro ai_created: ${aiCreated}`);
            index++;
        }

        if (req.query.aprovado !== undefined) {
            const aprovado = req.query.aprovado === 'true' || req.query.aprovado === true;
            query += ` AND aprovado = $${index}`;
            values.push(aprovado);
            console.log(`📌 Filtro aprovado: ${aprovado}`);
            index++;
        }

        // Filtro de busca geral por nome, id ou valor_lead
        let buscaExata = false;
        if (req.query.busca) {
            const busca = req.query.busca;
            const buscaInt = parseInt(busca);
            const buscaFloat = parseFloat(busca);

            if (!isNaN(buscaInt) && buscaInt.toString() === busca) {
                query += ` AND id = $${index}`;
                values.push(buscaInt);
                console.log(`📌 Filtro busca (id): id = ${buscaInt}`);
                index++;
                buscaExata = true;
            } else if (!isNaN(buscaFloat)) {
                query += ` AND valor_lead = $${index}`;
                values.push(buscaFloat);
                console.log(`📌 Filtro busca (valor_lead): valor_lead = ${buscaFloat}`);
                index++;
                buscaExata = true;
            } else {
                query += ` AND nome ILIKE $${index}`;
                values.push(`%${busca}%`);
                console.log(`📌 Filtro busca (texto): nome ILIKE %${busca}%`);
                index++;
            }
        }

        // Ordenação dinâmica
        let orderBy = req.query.order_by || 'created_at'; // Padrão: created_at
        const orderDir = req.query.order_dir || 'desc'; // Padrão: descendente
        const validOrderFields = ['created_at', 'valor_lead'];
        const validOrderDirs = ['asc', 'desc'];

        // Mapeia 'data_criacao' do frontend para 'created_at' no backend
        if (orderBy === 'data_criacao') {
            orderBy = 'created_at';
        }

        if (validOrderFields.includes(orderBy) && validOrderDirs.includes(orderDir)) {
            query += ` ORDER BY ${orderBy} ${orderDir.toUpperCase()}`;
            console.log(`📌 Ordenação: ${orderBy} ${orderDir.toUpperCase()}`);
        } else {
            console.warn(`⚠️ Parâmetros de ordenação inválidos: order_by=${orderBy}, order_dir=${orderDir}`);
            query += ` ORDER BY created_at DESC`; // Fallback para padrão
        }

        // Paginação
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        query += ` LIMIT $${index} OFFSET $${index + 1}`;
        values.push(limit, offset);

        console.log("📝 Query gerada:", query);
        console.log("📊 Valores utilizados:", values);

        // Consulta principal
        const result = await pool.query(query, values);
        let clientes = result.rows;

        // Busca de itens similares se não houver resultados
        if (clientes.length === 0 && req.query.busca && !buscaExata) {
            console.log("⚠️ Nenhum resultado exato encontrado. Buscando itens parecidos...");
            let similarQuery = 'SELECT * FROM clientes WHERE nome ILIKE $1 LIMIT 5';
            let similarValues = [`%${req.query.busca}%`];
            const similarResult = await pool.query(similarQuery, similarValues);
            clientes = similarResult.rows;
            console.log(`📌 Itens parecidos encontrados: ${clientes.length}`);
        }

        // Consulta de contagem
        let countQuery = 'SELECT COUNT(*) FROM clientes WHERE 1=1';
        let countValues = [];
        let countIndex = 1;

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

        if (req.query.disponivel !== undefined) {
            const disponivel = req.query.disponivel === 'true' || req.query.disponivel === true;
            countQuery += ` AND disponivel = $${countIndex}`;
            countValues.push(disponivel);
            countIndex++;
        }

        if (req.query.ai_created !== undefined) {
            const aiCreated = req.query.ai_created === 'true' || req.query.ai_created === true;
            countQuery += ` AND ai_created = $${countIndex}`;
            countValues.push(aiCreated);
            countIndex++;
        }

        if (req.query.aprovado !== undefined) {
            const aprovado = req.query.aprovado === 'true' || req.query.aprovado === true;
            countQuery += ` AND aprovado = $${countIndex}`;
            countValues.push(aprovado);
            countIndex++;
        }

        if (req.query.busca) {
            const busca = req.query.busca;
            const buscaInt = parseInt(busca);
            const buscaFloat = parseFloat(busca);

            if (!isNaN(buscaInt) && buscaInt.toString() === busca) {
                countQuery += ` AND id = $${countIndex}`;
                countValues.push(buscaInt);
                countIndex++;
            } else if (!isNaN(buscaFloat)) {
                countQuery += ` AND valor_lead = $${countIndex}`;
                countValues.push(buscaFloat);
                countIndex++;
            } else {
                countQuery += ` AND nome ILIKE $${countIndex}`;
                countValues.push(`%${busca}%`);
                countIndex++;
            }
        }

        console.log("📝 Consulta de contagem gerada:", countQuery);
        console.log("📊 Valores utilizados na contagem:", countValues);

        const countResult = await pool.query(countQuery, countValues);
        const totalRegistros = parseInt(countResult.rows[0].count);

        console.log("✅ Consulta realizada com sucesso. Resultados encontrados:", clientes.length);
        console.log("📊 Total de registros na base com filtros:", totalRegistros);

        res.json({
            clientes: clientes,
            total: totalRegistros
        });
    } catch (err) {
        console.error("❌ Erro ao buscar clientes:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


// Rota para buscar um lead específico
app.get('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = 'SELECT * FROM clientes WHERE id = $1';
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Lead não encontrado" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Erro ao buscar lead:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});



app.get('/clientes/whatsapp/:numero', async (req, res) => {
    try {
        const { numero } = req.params;
        console.log("Número buscado:", numero);

        // Query ajustada usando RIGHT para pegar os últimos 8 dígitos
        const query = `
            SELECT * 
            FROM clientes 
            WHERE RIGHT(REGEXP_REPLACE(whatsapp, '[^0-9]', '', 'g'), 8) = $1
        `;
        const result = await pool.query(query, [numero]);
        console.log("Resultado da busca:", result.rows);

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: "Cliente não encontrado com esses últimos 8 números do WhatsApp" 
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Erro ao buscar cliente:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});




app.put('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            titulo, // Novo campo adicionado
            nome, 
            categoria, 
            endereco, 
            tipo_imovel, 
            interesse, 
            valor, 
            valor_lead, 
            whatsapp, 
            disponivel,
            aprovado 
        } = req.body;

        console.log(`🚀 Recebendo requisição em /clientes/${id} para atualização`);
        console.log("📥 Dados recebidos:", req.body);

        // Construção dinâmica da query para atualizar apenas os campos enviados
        const fields = [];
        const values = [];
        let index = 1;

        if (titulo !== undefined) {
            fields.push(`titulo = $${index}`);
            values.push(titulo);
            index++;
        }
        if (nome !== undefined) {
            fields.push(`nome = $${index}`);
            values.push(nome);
            index++;
        }
        if (categoria !== undefined) {
            fields.push(`categoria = $${index}`);
            values.push(categoria);
            index++;
        }
        if (endereco !== undefined) {
            fields.push(`endereco = $${index}`);
            values.push(endereco);
            index++;
        }
        if (tipo_imovel !== undefined) {
            fields.push(`tipo_imovel = $${index}`);
            values.push(tipo_imovel);
            index++;
        }
        if (interesse !== undefined) {
            fields.push(`interesse = $${index}`);
            values.push(interesse);
            index++;
        }
        if (valor !== undefined) {
            fields.push(`valor = $${index}`);
            values.push(valor);
            index++;
        }
        if (valor_lead !== undefined) {
            fields.push(`valor_lead = $${index}`);
            values.push(valor_lead);
            index++;
        }
        if (whatsapp !== undefined) {
            fields.push(`whatsapp = $${index}`);
            values.push(whatsapp);
            index++;
        }
        if (disponivel !== undefined) {
            fields.push(`disponivel = $${index}`);
            values.push(disponivel);
            index++;
        }
        if (aprovado !== undefined) {
            fields.push(`aprovado = $${index}`);
            values.push(aprovado);
            index++;
        }

        if (fields.length === 0) {
            console.warn("⚠️ Nenhum campo válido fornecido para atualização");
            return res.status(400).json({ success: false, error: "Nenhum campo fornecido para atualização" });
        }

        // Adiciona o ID como último parâmetro
        const query = `
            UPDATE clientes 
            SET ${fields.join(", ")}
            WHERE id = $${index}
            RETURNING *`;
        values.push(id);

        console.log("📝 Query gerada para atualização:", query);
        console.log("📊 Valores utilizados:", values);

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            console.warn(`⚠️ Lead com ID ${id} não encontrado para atualização`);
            return res.status(404).json({ success: false, error: "Lead não encontrado" });
        }

        console.log(`✅ Lead ${id} atualizado com sucesso`);
        res.json({ success: true, cliente: result.rows[0] });
    } catch (err) {
        console.error("❌ Erro ao atualizar lead:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para criar um novo lead (caso ainda não exista)
app.post('/clientes', async (req, res) => {
    try {
        const { 
            titulo, // Novo campo adicionado
            nome, 
            categoria, 
            endereco, 
            tipo_imovel, 
            interesse, 
            valor, 
            valor_lead, 
            whatsapp 
        } = req.body;

        // Remove espaços e hífens do whatsapp, mantendo o + se existir
        const whatsappClean = whatsapp
            ? String(whatsapp).replace(/[\s-]/g, '')
            : whatsapp;

        console.log("🚀 Recebendo requisição em /clientes para criação");
        console.log("📥 Dados recebidos:", req.body);

        const query = `
            INSERT INTO clientes (titulo, nome, categoria, endereco, tipo_imovel, interesse, valor, valor_lead, whatsapp, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING *`;
        const values = [titulo, nome, categoria, endereco, tipo_imovel, interesse, valor, valor_lead, whatsappClean];

        const result = await pool.query(query, values);

        console.log(`✅ Novo lead criado com ID ${result.rows[0].id}`);
        res.status(201).json({ success: true, cliente: result.rows[0] });
    } catch (err) {
        console.error("❌ Erro ao criar lead:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para criar um novo cliente via IA
app.post('/clientes/ia', async (req, res) => {
    try {
        const { nome, endereco, tipo_imovel, interesse, valor, whatsapp } = req.body;

        // Lista de tipos de imóvel válidos
        const validTiposImovel = ['Apartamento', 'Casa', 'Terreno', 'Comercial', 'Rural', 'Studio'];

        // Validação do tipo_imovel
        if (!tipo_imovel || !validTiposImovel.includes(tipo_imovel)) {
            return res.status(400).json({
                success: false,
                error: "Tipo de imóvel inválido",
                message: "Por favor, escolha uma das seguintes opções para tipo_imovel:",
                options: validTiposImovel
            });
        }

        // Remove espaços, hífens e @s.whatsapp.net do whatsapp, mantendo o + se existir
        const whatsappClean = whatsapp
            ? String(whatsapp)
                .replace(/[\s-]/g, '') // Remove espaços e hífens
                .replace('@s.whatsapp.net', '') // Remove @s.whatsapp.net
            : whatsapp;

        // Converte valor para número (remove quaisquer caracteres não numéricos, se necessário)
        const valorNumerico = parseFloat(String(valor).replace(/[^0-9.]/g, '')) || 0;

        // Determina categoria e valor_lead com base no valor
        const categoria = valorNumerico >= 2000000 ? 2 : 1; // 2 milhões
        const valor_lead = valorNumerico >= 2000000 ? 49.90 : 29.90;

        const query = `
            INSERT INTO clientes (nome, categoria, endereco, tipo_imovel, interesse, valor, valor_lead, whatsapp)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *`;
        const values = [nome, categoria, endereco, tipo_imovel, interesse, valor, valor_lead, whatsappClean];

        const result = await pool.query(query, values);

        console.log(`✅ Novo cliente criado com ID ${result.rows[0].id}`);
        res.status(201).json({ 
            success: true, 
            cliente: result.rows[0],
            message: "Cliente cadastrado com sucesso"
        });
    } catch (err) {
        console.error("❌ Erro ao criar cliente via IA:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Erro interno no servidor",
            message: err.message 
        });
    }
});


app.delete('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`🚀 Recebendo requisição em /clientes/${id} para exclusão`);

        // Verifica se o lead está associado a algum corretor
        const checkQuery = `
            SELECT COUNT(*) 
            FROM corretores 
            WHERE $1 = ANY(clientes)`;
        const checkValues = [parseInt(id)];

        console.log("📝 Query de verificação gerada:", checkQuery);
        console.log("📊 Valores utilizados na verificação:", checkValues);

        const checkResult = await pool.query(checkQuery, checkValues);
        const count = parseInt(checkResult.rows[0].count);

        if (count > 0) {
            console.warn(`⚠️ Lead ${id} está associado a ${count} corretor(es) e não pode ser excluído`);
            return res.status(403).json({
                success: false,
                error: "Este lead já foi adquirido por corretores e não pode ser excluído"
            });
        }

        // Se não houver associação, prossegue com a exclusão
        const deleteQuery = 'DELETE FROM clientes WHERE id = $1 RETURNING *';
        const deleteValues = [id];

        console.log("📝 Query gerada para exclusão:", deleteQuery);
        console.log("📊 Valores utilizados:", deleteValues);

        const deleteResult = await pool.query(deleteQuery, deleteValues);

        if (deleteResult.rows.length === 0) {
            console.warn(`⚠️ Lead com ID ${id} não encontrado para exclusão`);
            return res.status(404).json({ success: false, error: "Lead não encontrado" });
        }

        console.log(`✅ Lead ${id} excluído com sucesso`);
        res.json({ success: true, message: "Lead excluído com sucesso", cliente: deleteResult.rows[0] });
    } catch (err) {
        console.error("❌ Erro ao excluir lead:", err.message);
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
app.post('/corretores', async (req, res) => {
    const { email, password, phone, creci, name, cpfCnpj } = req.body;

    console.log("🚀 Iniciando criação de corretor - Dados recebidos:", req.body);

    if (!email || !password) {
        console.log("❌ Erro: Email ou senha ausentes");
        return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    if (!cpfCnpj) {
        console.log("❌ Erro: CPF/CNPJ ausente");
        return res.status(400).json({ error: "CPF ou CNPJ é obrigatório para o cadastro no Asaas." });
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
                cpfCnpj: cpfCnpj,
                email,
                mobilePhone: phone || null
            },
            {
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/json',
                    'access_token': process.env.ASAAS_API_KEY
                }
            }
        );

        const asaasId = asaasResponse.data.id;
        console.log(`✅ Customer criado no Asaas com sucesso. ID: ${asaasId}`);

        // Etapa 3: Gera o token
        console.log("🔑 Gerando token para o corretor...");
        const token = gerarToken();
        console.log(`✅ Token gerado: ${token}`);

        // Etapa 4: Insere o corretor no banco com o assas_id (corrigido)
        console.log("📝 Inserindo corretor no banco de dados...");
        const result = await pool.query(
            "INSERT INTO corretores (email, password, phone, creci, name, token, assas_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, token",
            [email, password, phone || null, creci || null, name || null, token, asaasId]
        );
        console.log(`✅ Corretor inserido no banco. ID: ${result.rows[0].id}`);

        // Etapa 5: Retorna a resposta
        console.log("📤 Enviando resposta ao cliente...");
        res.status(201).json({
            id: result.rows[0].id,
            token: result.rows[0].token,
            assas_id: asaasId // Corrigido aqui também para consistência na resposta
        });
        console.log("✅ Resposta enviada com sucesso");

    } catch (error) {
        console.error("❌ Erro ao criar corretor:");
        if (error.response) {
            console.error("   - Detalhes do erro do Asaas:", JSON.stringify(error.response.data, null, 2));
            console.error("   - Status HTTP:", error.response.status);
            console.error("   - Headers enviados:", error.response.config.headers);
            console.error("   - Dados enviados:", error.response.config.data);
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
            "SELECT email, phone, token, id, creci, imoveis, clientes, name, assas_id FROM corretores WHERE id = $1 AND token = $2",
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


// 📌 Rota para atualizar informações do corretor
app.put('/corretor/dados', async (req, res) => {
    const { id, token, name, phone, creci, email, current_password, new_password } = req.body;

    if (!id || !token) {
        return res.status(400).json({ error: "ID e Token são obrigatórios." });
    }

    try {
        // Verificar se o corretor existe e o token é válido
        const checkResult = await pool.query(
            "SELECT * FROM corretores WHERE id = $1 AND token = $2",
            [id, token]
        );

        if (checkResult.rows.length === 0) {
            return res.status(401).json({ error: "Credenciais inválidas." });
        }

        const corretor = checkResult.rows[0];

        // Se nova senha for fornecida, validar a senha atual
        if (new_password) {
            if (!current_password) {
                return res.status(400).json({ error: "Senha atual é necessária para alterar a senha." });
            }
            if (current_password !== corretor.password) {
                return res.status(401).json({ error: "Senha atual incorreta." });
            }
        }

        // Montar a query de atualização apenas com os campos fornecidos
        let updateQuery = "UPDATE corretores SET ";
        const updateValues = [];
        let index = 1;

        if (name) {
            updateQuery += `name = $${index}, `;
            updateValues.push(name);
            index++;
        }
        if (phone) {
            updateQuery += `phone = $${index}, `;
            updateValues.push(phone);
            index++;
        }
        if (creci) {
            updateQuery += `creci = $${index}, `;
            updateValues.push(creci);
            index++;
        }
        if (email) {
            updateQuery += `email = $${index}, `;
            updateValues.push(email);
            index++;
        }
        if (new_password) {
            updateQuery += `password = $${index}, `;
            updateValues.push(new_password);
            index++;
        }

        // Remover a vírgula extra e adicionar a condição WHERE
        updateQuery = updateQuery.slice(0, -2) + " WHERE id = $" + index + " AND token = $" + (index + 1);
        updateValues.push(id, token);

        // Executar a atualização apenas se houver campos para atualizar
        if (index > 3) { // Se index > 3, significa que há pelo menos um campo além de id e token
            await pool.query(updateQuery, updateValues);
        }

        // Retornar os dados atualizados
        const updatedResult = await pool.query(
            "SELECT email, phone, token, id, creci, imoveis, clientes, name, assas_id FROM corretores WHERE id = $1 AND token = $2",
            [id, token]
        );

        res.json(updatedResult.rows[0]);
    } catch (error) {
        console.error("Erro ao atualizar corretor:", error);
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













app.post('/criar-pedido', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /criar-pedido");
        console.log("📥 Dados recebidos:", req.body);

        const { userId, token, entregue, pago, imoveis_id, leads_id } = req.body;

        if (!userId || !token) {
            console.log("❌ Erro: userId e token são obrigatórios");
            return res.status(400).json({ success: false, error: "userId e token são obrigatórios" });
        }

        // Busca o id interno e o assas_id do corretor com base no userId e token
        const corretorQuery = await pool.query(
            "SELECT id, assas_id FROM corretores WHERE id = $1 AND token = $2",
            [userId, token]
        );
        if (corretorQuery.rows.length === 0) {
            console.log("❌ Erro: Corretor não encontrado para userId e token:", userId, token);
            return res.status(401).json({ success: false, error: "Credenciais inválidas" });
        }
        const corretorId = corretorQuery.rows[0].id;
        const assasId = corretorQuery.rows[0].assas_id;
        console.log("✅ Corretor encontrado - ID interno:", corretorId, "assas_id:", assasId);

        // Calcula o total_value baseado nos imóveis e leads
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
        if (total_value <= 0) {
            console.log("❌ Erro: O valor total deve ser maior que zero");
            return res.status(400).json({ success: false, error: "O valor total deve ser maior que zero" });
        }

        // Criação da cobrança no Asaas usando o assas_id
        console.log("💳 Criando cobrança no Asaas...");
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 7);
        const asaasResponse = await axios.post(
            `${process.env.ASAAS_API_URL}/payments`,
            {
                billingType: "UNDEFINED",
                customer: assasId,
                value: total_value,
                dueDate: dueDate.toISOString().split('T')[0],
                description: `Pedido de imóveis e leads - Corretor ${corretorId}`,
                split: [
                    {
                        percentualValue: 1,
                        walletId: process.env.split_walletID
                    }
                ],
                callback: {
                    autoRedirect: true,
                    successUrl: "https://meuleaditapema.com.br/"
                },
                postalService: false
            },
            {
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/json',
                    'access_token': process.env.ASAAS_API_KEY
                }
            }
        );

        const cobranca_id = asaasResponse.data.id;
        const invoiceUrl = asaasResponse.data.invoiceUrl;
        console.log(`✅ Cobrança criada no Asaas. ID: ${cobranca_id}, Invoice URL: ${invoiceUrl}`);

        // Insere o pedido na tabela com o corretorId (integer)
        const insertQuery = `
            INSERT INTO pedido (total_value, corretor, entregue, pago, cobranca_id, invoiceUrl, imoveis_id, leads_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `;
        const values = [
            total_value,
            corretorId,
            entregue !== undefined ? entregue : false,
            pago !== undefined ? pago : false,
            cobranca_id,
            invoiceUrl,
            imoveis_id && imoveis_id.length > 0 ? imoveis_id : null,
            leads_id && leads_id.length > 0 ? leads_id : null
        ];

        console.log("📝 Query gerada:", insertQuery);
        console.log("📊 Valores utilizados:", values);

        const result = await pool.query(insertQuery, values);
        const pedidoId = result.rows[0].id;

        // Atualiza a tabela corretores adicionando o pedidoId ao array pedidos
        const updateCorretoresQuery = `
            UPDATE corretores 
            SET pedidos = array_append(COALESCE(pedidos, '{}'), $1)
            WHERE id = $2
        `;
        await pool.query(updateCorretoresQuery, [pedidoId, corretorId]);
        console.log(`✅ Array pedidos atualizado para o corretor ${corretorId} com pedido ${pedidoId}`);

        console.log(`✅ Pedido criado com sucesso. ID: ${pedidoId}, Total: ${total_value}`);

        res.status(201).json({
            success: true,
            pedido_id: pedidoId,
            total_value: total_value,
            cobranca_id: cobranca_id,
            invoiceUrl: invoiceUrl
        });
    } catch (error) {
        console.error("❌ Erro ao criar pedido:");
        if (error.response) {
            console.error("   - Detalhes do erro do Asaas:", JSON.stringify(error.response.data, null, 2));
            console.error("   - Status HTTP:", error.response.status);
        } else {
            console.error("   - Erro interno:", error.message);
        }
        res.status(500).json({ success: false, error: "Erro interno do servidor" });
    }
});




// Rota para buscar detalhes de um pedido
app.get('/detalhes-pedido', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /detalhes-pedido");
        console.log("📥 Query recebida:", req.query);

        const { id, cobranca_id } = req.query;

        if (!id && !cobranca_id) {
            console.log("❌ Erro: id ou cobranca_id é obrigatório");
            return res.status(400).json({ success: false, error: "id ou cobranca_id é obrigatório" });
        }

        // Monta a query base para buscar o pedido
        let pedidoQuery = `
            SELECT *
            FROM pedido
            WHERE 1=1
        `;
        const queryParams = [];

        if (id) {
            queryParams.push(id);
            pedidoQuery += ` AND id = $${queryParams.length}`;
        }
        if (cobranca_id) {
            queryParams.push(cobranca_id);
            pedidoQuery += ` AND cobranca_id = $${queryParams.length}`;
        }

        console.log("📝 Query do pedido:", pedidoQuery);
        console.log("📊 Parâmetros:", queryParams);

        const pedidoResult = await pool.query(pedidoQuery, queryParams);
        if (pedidoResult.rows.length === 0) {
            console.log("❌ Erro: Pedido não encontrado");
            return res.status(404).json({ success: false, error: "Pedido não encontrado" });
        }

        const pedido = pedidoResult.rows[0];
        console.log("✅ Pedido encontrado:", pedido);

        // Busca os detalhes do corretor
        const corretorQuery = `
            SELECT *
            FROM corretores
            WHERE id = $1
        `;
        const corretorResult = await pool.query(corretorQuery, [pedido.corretor]);
        const corretor = corretorResult.rows[0] || null;
        console.log("✅ Corretor encontrado:", corretor);

        // Busca os detalhes dos imóveis (se existirem)
        let imoveis = [];
        if (pedido.imoveis_id && Array.isArray(pedido.imoveis_id) && pedido.imoveis_id.length > 0) {
            const imoveisQuery = `
                SELECT *
                FROM imoveis
                WHERE id = ANY($1::integer[])
            `;
            const imoveisResult = await pool.query(imoveisQuery, [pedido.imoveis_id]);
            imoveis = imoveisResult.rows;
            console.log("✅ Imóveis encontrados:", imoveis.length);
        } else {
            console.log("📌 Nenhum imóvel associado ao pedido");
        }

        // Busca os detalhes dos leads (se existirem)
        let leads = [];
        if (pedido.leads_id && Array.isArray(pedido.leads_id) && pedido.leads_id.length > 0) {
            const leadsQuery = `
                SELECT *
                FROM clientes
                WHERE id = ANY($1::integer[])
            `;
            const leadsResult = await pool.query(leadsQuery, [pedido.leads_id]);
            leads = leadsResult.rows;
            console.log("✅ Leads encontrados:", leads.length);
        } else {
            console.log("📌 Nenhum lead associado ao pedido");
        }

        // Monta a resposta completa
        const resposta = {
            success: true,
            pedido: {
                ...pedido,
                corretor: corretor,
                imoveis: imoveis,
                leads: leads
            }
        };

        console.log("✅ Detalhes do pedido preparados com sucesso");
        res.status(200).json(resposta);
    } catch (error) {
        console.error("❌ Erro ao buscar detalhes do pedido:", error.message);
        res.status(500).json({ success: false, error: "Erro interno do servidor" });
    }
});

























app.post('/webhook/asaas', async (req, res) => {
    try {
        console.log("🌐 Recebendo webhook do Asaas");
        console.log("📥 Dados recebidos:", JSON.stringify(req.body, null, 2));

        // O webhook pode vir como um array, pegamos o primeiro item
        const webhookData = Array.isArray(req.body) ? req.body[0] : req.body;
        const event = webhookData.body.event;
        const paymentId = webhookData.body.payment.id;

        // Verifica se o evento é de pagamento confirmado
        if (event !== "PAYMENT_CONFIRMED") {
            console.log(`⚠️ Evento ignorado: ${event}. Apenas PAYMENT_CONFIRMED é processado.`);
            return res.status(200).json({ success: true, message: "Evento ignorado" });
        }

        if (!paymentId) {
            console.log("❌ Erro: payment.id não encontrado no webhook");
            return res.status(400).json({ success: false, error: "payment.id é obrigatório" });
        }

        // Busca pedidos com o cobranca_id correspondente
        const pedidosQuery = `
            SELECT id, corretor, imoveis_id, leads_id
            FROM pedido
            WHERE cobranca_id = $1
        `;
        const pedidosResult = await pool.query(pedidosQuery, [paymentId]);

        if (pedidosResult.rowCount === 0) {
            console.log(`❌ Nenhum pedido encontrado com cobranca_id: ${paymentId}`);
            return res.status(404).json({ success: false, error: "Nenhum pedido encontrado" });
        }

        const pedidos = pedidosResult.rows;
        console.log(`✅ Pedidos encontrados: ${pedidosResult.rowCount}`);

        // Inicia uma transação para garantir consistência
        await pool.query('BEGIN');

        try {
            // Atualiza todos os pedidos encontrados para pago = true
            const updatePedidosQuery = `
                UPDATE pedido
                SET pago = true
                WHERE cobranca_id = $1
                RETURNING id
            `;
            const updatedPedidos = await pool.query(updatePedidosQuery, [paymentId]);
            console.log(`✅ Pedidos atualizados (pago = true): ${updatedPedidos.rowCount}`);

            // Processa cada pedido
            for (const pedido of pedidos) {
                const { id: pedidoId, corretor, imoveis_id, leads_id } = pedido;

                // Converte os arrays para garantir que sejam válidos (podem vir como null)
                const imoveisIds = Array.isArray(imoveis_id) ? imoveis_id.map(id => parseInt(id)) : [];
                const leadsIds = Array.isArray(leads_id) ? leads_id.map(id => parseInt(id)) : [];

                console.log(`📌 Processando pedido ${pedidoId} para corretor ${corretor}`);
                console.log(`   - Imóveis IDs: ${imoveisIds}`);
                console.log(`   - Leads IDs: ${leadsIds}`);

                // Atualiza a tabela clientes, incrementando cotas_compradas e ajustando disponivel
                if (leadsIds.length > 0) {
                    const updateClientesQuery = `
                        UPDATE clientes
                        SET cotas_compradas = COALESCE(cotas_compradas, 0) + 1,
                            disponivel = CASE 
                                WHEN (COALESCE(cotas_compradas, 0) + 1) >= 5 THEN false 
                                ELSE disponivel 
                            END
                        WHERE id = ANY($1::integer[])
                        RETURNING id, cotas_compradas, disponivel
                    `;
                    const updatedClientes = await pool.query(updateClientesQuery, [leadsIds]);

                    console.log(`✅ Clientes atualizados: ${updatedClientes.rowCount}`);
                    updatedClientes.rows.forEach(cliente => {
                        console.log(`   - Cliente ${cliente.id}: cotas_compradas = ${cliente.cotas_compradas}, disponivel = ${cliente.disponivel}`);
                    });
                } else {
                    console.log("📌 Nenhum lead para atualizar em cotas_compradas");
                }

                // Busca os valores atuais de imoveis_comprados e clientes do corretor
                const corretorQuery = `
                    SELECT imoveis_comprados, clientes
                    FROM corretores
                    WHERE id = $1
                `;
                const corretorResult = await pool.query(corretorQuery, [corretor]);

                if (corretorResult.rowCount === 0) {
                    throw new Error(`Corretor ${corretor} não encontrado`);
                }

                const corretorData = corretorResult.rows[0];
                const imoveisCompradosAtuais = Array.isArray(corretorData.imoveis_comprados) ? corretorData.imoveis_comprados.map(id => parseInt(id)) : [];
                const clientesAtuais = Array.isArray(corretorData.clientes) ? corretorData.clientes.map(id => parseInt(id)) : [];

                // Adiciona novos IDs sem duplicatas
                const novosImoveisComprados = [...new Set([...imoveisCompradosAtuais, ...imoveisIds])];
                const novosClientes = [...new Set([...clientesAtuais, ...leadsIds])];

                // Atualiza o corretor com os novos arrays
                const updateCorretorQuery = `
                    UPDATE corretores
                    SET imoveis_comprados = $1::integer[],
                        clientes = $2::integer[]
                    WHERE id = $3
                    RETURNING id
                `;
                const updateCorretorResult = await pool.query(updateCorretorQuery, [
                    novosImoveisComprados.length > 0 ? novosImoveisComprados : null,
                    novosClientes.length > 0 ? novosClientes : null,
                    corretor
                ]);

                if (updateCorretorResult.rowCount === 0) {
                    throw new Error(`Falha ao atualizar corretor ${corretor}`);
                }

                console.log(`✅ Corretor ${corretor} atualizado com sucesso`);
                console.log(`   - Imóveis comprados: ${novosImoveisComprados}`);
                console.log(`   - Clientes: ${novosClientes}`);

                // Envia requisição para o N8N
                const n8nUrl = process.env.n8n_entrega;
                if (!n8nUrl) {
                    console.log("⚠️ Variável n8n_entrega não definida no .env");
                } else {
                    const n8nPayload = {
                        pedido_id: pedidoId,
                        payment_id: paymentId,
                        clientes_adquiridos: leadsIds,
                        imoveis_adquiridos: imoveisIds,
                        corretor_id: corretor,
                        timestamp: new Date().toISOString(),
                        webhook_data: webhookData.body // Inclui todos os dados do webhook para flexibilidade
                    };

                    console.log(`📤 Enviando dados para N8N (${n8nUrl}):`, JSON.stringify(n8nPayload, null, 2));

                    try {
                        const n8nResponse = await axios.post(n8nUrl, n8nPayload, {
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        });
                        console.log(`✅ Resposta do N8N: ${n8nResponse.status} - ${JSON.stringify(n8nResponse.data)}`);
                    } catch (n8nError) {
                        console.error(`❌ Erro ao enviar para N8N: ${n8nError.message}`);
                        // Não falha a transação principal, apenas loga o erro
                    }
                }
            }

            // Confirma a transação
            await pool.query('COMMIT');
            console.log("✅ Transação concluída com sucesso");
            return res.status(200).json({ success: true, message: "Webhook processado com sucesso" });
        } catch (error) {
            // Em caso de erro, faz rollback da transação
            await pool.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        console.error("❌ Erro ao processar webhook:", error.message);
        return res.status(500).json({ success: false, error: "Erro interno do servidor" });
    }
});



app.post('/pedido/entregar', async (req, res) => {
    try {
        console.log("🌐 Recebendo requisição para confirmar entrega do pedido");
        console.log("📥 Dados recebidos:", JSON.stringify(req.body, null, 2));

        // Extrai o pedido_id do corpo da requisição
        const { pedido_id } = req.body;

        if (!pedido_id) {
            console.log("❌ Erro: pedido_id não encontrado na requisição");
            return res.status(400).json({ success: false, error: "pedido_id é obrigatório" });
        }

        // Busca o pedido no banco de dados para verificar se existe
        const pedidoQuery = `
            SELECT id, entregue
            FROM pedido
            WHERE id = $1
        `;
        const pedidoResult = await pool.query(pedidoQuery, [pedido_id]);

        if (pedidoResult.rowCount === 0) {
            console.log(`❌ Nenhum pedido encontrado com id: ${pedido_id}`);
            return res.status(404).json({ success: false, error: "Pedido não encontrado" });
        }

        const pedido = pedidoResult.rows[0];

        // Verifica se o pedido já foi entregue
        if (pedido.entregue) {
            console.log(`⚠️ Pedido ${pedido_id} já está marcado como entregue`);
            return res.status(200).json({ success: true, message: "Pedido já foi entregue anteriormente" });
        }

        // Atualiza o campo entregue para true
        const updatePedidoQuery = `
            UPDATE pedido
            SET entregue = true
            WHERE id = $1
            RETURNING id, entregue
        `;
        const updatedPedido = await pool.query(updatePedidoQuery, [pedido_id]);

        if (updatedPedido.rowCount === 0) {
            console.log(`❌ Falha ao atualizar pedido ${pedido_id}`);
            return res.status(500).json({ success: false, error: "Falha ao atualizar o pedido" });
        }

        console.log(`✅ Pedido ${pedido_id} atualizado com sucesso: entregue = ${updatedPedido.rows[0].entregue}`);
        return res.status(200).json({ success: true, message: "Entrega confirmada com sucesso" });
    } catch (error) {
        console.error("❌ Erro ao processar confirmação de entrega:", error.message);
        return res.status(500).json({ success: false, error: "Erro interno do servidor" });
    }
});








app.get('/estatisticas-relatorios', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /estatisticas-relatorios");

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const query = `
            WITH stats AS (
                SELECT 
                    c.id AS corretor_id,
                    c.name AS corretor_name,
                    c.created_at AS corretor_created_at,
                    COUNT(p.id) AS total_pedidos,
                    COUNT(p.id) FILTER (WHERE p.pago = false AND p.entregue = false) AS pedidos_pendentes,
                    COUNT(p.id) FILTER (WHERE p.pago = true AND p.entregue = true) AS pedidos_finalizados_corretor
                FROM corretores c
                LEFT JOIN pedido p ON c.id = p.corretor
                GROUP BY c.id, c.name, c.created_at
            )
            SELECT 
                -- Corretores sem pedidos
                json_agg(
                    json_build_object(
                        'name', corretor_name,
                        'created_at', corretor_created_at
                    )
                ) FILTER (WHERE total_pedidos = 0) AS corretores_sem_pedidos,

                -- Corretores com pedidos
                json_agg(
                    json_build_object(
                        'name', corretor_name,
                        'total_pedidos', total_pedidos
                    )
                ) FILTER (WHERE total_pedidos > 0) AS corretores_com_pedidos,

                -- Corretores com pedidos pendentes
                json_agg(
                    json_build_object(
                        'name', corretor_name,
                        'pedidos_pendentes', pedidos_pendentes
                    )
                ) FILTER (WHERE pedidos_pendentes > 0) AS corretores_com_pedidos_pendentes,

                -- Corretores com mais de 1 pedido
                json_agg(
                    json_build_object(
                        'name', corretor_name,
                        'total_pedidos', total_pedidos
                    )
                ) FILTER (WHERE total_pedidos > 1) AS corretores_com_mais_de_um_pedido,

                -- Pedidos finalizados (total geral)
                (SELECT COUNT(*) 
                 FROM pedido 
                 WHERE pago = true AND entregue = true) AS pedidos_finalizados,

                -- Melhores corretores (top 5, ordenados por pedidos finalizados e depois por data de criação)
                (SELECT json_agg(t.*)
                 FROM (
                     SELECT 
                         json_build_object(
                             'name', corretor_name,
                             'pedidos_finalizados', pedidos_finalizados_corretor,
                             'created_at', corretor_created_at
                         )
                     FROM stats 
                     ORDER BY pedidos_finalizados_corretor DESC, corretor_created_at ASC
                     LIMIT 5
                 ) t) AS melhores_corretores,

                -- Pedidos últimos 30 dias com detalhes
                (SELECT json_agg(
                    json_build_object(
                        'id', p.id,
                        'corretor_name', c.name,
                        'valor', p.total_value,
                        'data', p.created_at
                    ))
                 FROM pedido p
                 JOIN corretores c ON c.id = p.corretor
                 WHERE p.created_at >= $1) AS pedidos_ultimos_30_dias,

                -- Novos corretores últimos 30 dias
                (SELECT json_agg(
                    json_build_object(
                        'name', name,
                        'created_at', created_at
                    ))
                 FROM corretores 
                 WHERE created_at >= $1) AS novos_corretores_ultimos_30_dias,

                -- Total de clientes cadastrados por IA últimos 30 dias
                (SELECT COUNT(*) 
                 FROM clientes 
                 WHERE AI_created = true 
                 AND created_at >= $1) AS clientes_cadastrados_por_ia_ultimos_30_dias

            FROM stats;
        `;

        const result = await pool.query(query, [thirtyDaysAgo]);
        const stats = result.rows[0];

        const response = {
            success: true,
            data: {
                corretores_sem_pedidos: stats.corretores_sem_pedidos || [],
                corretores_com_pedidos: stats.corretores_com_pedidos || [],
                corretores_com_pedidos_pendentes: stats.corretores_com_pedidos_pendentes || [],
                corretores_com_mais_de_um_pedido: stats.corretores_com_mais_de_um_pedido || [],
                pedidos_finalizados: stats.pedidos_finalizados || 0,
                melhores_corretores: stats.melhores_corretores || [],
                pedidos_ultimos_30_dias: stats.pedidos_ultimos_30_dias || [],
                novos_corretores_ultimos_30_dias: stats.novos_corretores_ultimos_30_dias || [],
                clientes_cadastrados_por_ia_ultimos_30_dias: stats.clientes_cadastrados_por_ia_ultimos_30_dias || 0
            },
            timestamp: new Date().toISOString()
        };

        res.status(200).json(response);
    } catch (error) {
        console.error("❌ Erro detalhado:", error.stack);
        res.status(500).json({
            success: false,
            error: "Erro interno do servidor ao calcular estatísticas",
            details: error.message
        });
    }
});


app.get('/pedidos-por-intervalo', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /pedidos-por-intervalo");

        const { startDate, endDate, groupBy } = req.query;

        // Validação dos parâmetros
        if (!startDate || !endDate || !groupBy) {
            return res.status(400).json({
                success: false,
                error: "Parâmetros startDate, endDate e groupBy são obrigatórios"
            });
        }

        if (!['day', 'week', 'month'].includes(groupBy)) {
            return res.status(400).json({
                success: false,
                error: "groupBy deve ser 'day', 'week' ou 'month'"
            });
        }

        // Query SQL ajustada para agrupamento
        const query = `
            SELECT 
                DATE_TRUNC($3, p.created_at) AS periodo,
                SUM(p.total_value) AS faturamento
            FROM pedido p
            WHERE p.created_at BETWEEN $1 AND $2
            GROUP BY DATE_TRUNC($3, p.created_at)
            ORDER BY periodo ASC;
        `;

        const result = await pool.query(query, [startDate, endDate, groupBy]);
        const faturamento = result.rows.map(row => ({
            periodo: row.periodo.toISOString().split('T')[0], // Formato YYYY-MM-DD
            faturamento: parseFloat(row.faturamento) || 0
        }));

        console.log("✅ Faturamento calculado:", faturamento);

        res.status(200).json({
            success: true,
            data: faturamento
        });
    } catch (error) {
        console.error("❌ Erro ao calcular faturamento:", error.stack);
        res.status(500).json({
            success: false,
            error: "Erro interno do servidor ao calcular faturamento",
            details: error.message
        });
    }
});






































// Middleware para verificar o domínio e adicionar logs
app.use((req, res, next) => {
    const host = req.headers.host || '';
    console.log(`Host recebido: ${host}`); // Log para depurar o domínio recebido
    req.isLeadDomain = host.includes('lead.meuleaditapema.com.br');
    req.isImovelDomain = host.includes('imovel.meuleaditapema.com.br');
    console.log(`isLeadDomain: ${req.isLeadDomain}, isImovelDomain: ${req.isImovelDomain}`);
    next();
});

// Rota para a raiz do subdomínio
app.get("/:id", async (req, res) => {
    const { id } = req.params;

    try {
        if (req.isLeadDomain && !req.isImovelDomain) {
            const result = await pool.query(
                `
                SELECT 
                    c.disponivel,
                    c.interesse,
                    c.valor_lead,
                    c.categoria,
                    c.valor
                FROM clientes c
                WHERE c.id = $1
                `,
                [id]
            );

            if (result.rowCount === 0) {
                console.log(`Lead ${id} não encontrado`);
                return res.status(404).send("Lead não encontrado");
            }

            const lead = result.rows[0];
            console.log(`Dados do lead ${id}:`, lead);

            // URLs ajustadas para HTTPS
            const logoUrl = 'https://cloud.meuleaditapema.com.br/uploads/bc8e96dd-0f77-4955-ba77-21ed098ad2fa.ico';
            const previewImageUrl = 'https://cloud.meuleaditapema.com.br/uploads/3cbeb5c8-1937-40b0-8f03-765d7a5eba77.png';
            const categoriaTexto = lead.categoria === 1 ? "Médio Padrão" : "Alto Padrão";
            const valorBuscado = parseFloat(lead.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const valorLead = parseFloat(lead.valor_lead || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const disponibilidadeTexto = lead.disponivel ? "Disponível" : "Indisponível";
            const padrao = lead.categoria === 1 ? "medio-padrao" : "alto-padrao";

            const html = `
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${lead.interesse || "Lead Imobiliário"}</title>
                    <meta name="description" content="${categoriaTexto} - ${lead.interesse || 'Sem interesse especificado'}">
                    <!-- Open Graph Tags otimizadas para preview -->
                    <meta property="og:title" content="${lead.interesse || "Lead Imobiliário"}">
                    <meta property="og:description" content="${categoriaTexto} - Valor Estimado: ${valorBuscado}">
                    <meta property="og:image" content="${previewImageUrl}">
                    <meta property="og:image:secure_url" content="${previewImageUrl}">
                    <meta property="og:image:type" content="image/png">
                    <meta property="og:image:width" content="512">
                    <meta property="og:image:height" content="512">
                    <meta property="og:url" content="https://lead.meuleaditapema.com.br/${id}">
                    <meta property="og:type" content="article">
                    <meta property="og:site_name" content="Meu Lead Itapema">
                    <link rel="icon" type="image/x-icon" href="${logoUrl}">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                            font-family: 'Arial', sans-serif;
                        }
                        body {
                            background: #e6f0fa;
                            min-height: 100vh;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            padding: 20px;
                            overflow-x: hidden;
                            position: relative;
                        }
                        .container {
                            max-width: 650px;
                            width: 100%;
                            padding: 40px;
                            position: relative;
                            animation: slideIn 0.8s ease-out;
                            border-radius: 20px;
                            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.05);
                            ${lead.categoria === 1 ? `
                                background: rgba(255, 255, 255, 0.1);
                                backdrop-filter: blur(5px);
                            ` : `
                                background: transparent;
                            `}
                        }
                        @keyframes slideIn {
                            from { opacity: 0; transform: translateX(-50px); }
                            to { opacity: 1; transform: translateX(0); }
                        }
                        .logo {
                            width: ${lead.categoria === 1 ? '90px' : '100px'};
                            height: ${lead.categoria === 1 ? '90px' : '100px'};
                            display: block;
                            margin: 0 auto 25px;
                            filter: drop-shadow(0 0 8px rgba(${lead.categoria === 1 ? '52, 152, 219' : '255, 215, 0'}, 0.2));
                            transition: transform 0.3s ease;
                        }
                        .logo:hover {
                            transform: scale(1.05);
                        }
                        h1 {
                            color: #2c3e50;
                            text-align: center;
                            margin-bottom: 15px;
                            font-size: 34px;
                            letter-spacing: 1.5px;
                            position: relative;
                            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
                        }
                        h1::after {
                            content: '';
                            position: absolute;
                            width: 60px;
                            height: 3px;
                            background: linear-gradient(to right, ${lead.categoria === 1 ? '#3498db, #2980b9' : '#ffd700, #b8860b'});
                            bottom: -10px;
                            left: 50%;
                            transform: translateX(-50%);
                        }
                        .subtitle {
                            color: #7f8c8d;
                            text-align: center;
                            margin-bottom: 35px;
                            font-size: 17px;
                            font-style: italic;
                        }
                        .info-box {
                            padding: 25px 0;
                            border-top: 1px solid rgba(${lead.categoria === 1 ? '52, 152, 219' : '255, 215, 0'}, 0.3);
                            border-bottom: 1px solid rgba(${lead.categoria === 1 ? '52, 152, 219' : '255, 215, 0'}, 0.3);
                            margin-bottom: 35px;
                        }
                        .info-box p {
                            color: #2c3e50;
                            line-height: 2;
                            font-size: 17px;
                            position: relative;
                            padding-left: 25px;
                            transition: transform 0.3s ease;
                        }
                        .info-box p:hover {
                            transform: translateX(5px);
                        }
                        .info-box p::before {
                            content: '✦';
                            color: ${lead.categoria === 1 ? '#3498db' : '#ffd700'};
                            position: absolute;
                            left: 0;
                            font-size: 14px;
                        }
                        .value-section {
                            text-align: center;
                            margin-bottom: 35px;
                            padding: 15px;
                            ${lead.categoria === 1 ? `
                                background: rgba(52, 152, 219, 0.1);
                                border-radius: 10px;
                            ` : `
                                background: rgba(255, 215, 0, 0.1);
                                border-radius: 10px;
                            `}
                            transition: all 0.3s ease;
                        }
                        .value-section:hover {
                            ${lead.categoria === 1 ? `
                                background: rgba(52, 152, 219, 0.2);
                            ` : `
                                background: rgba(255, 215, 0, 0.2);
                            `}
                            transform: scale(1.02);
                        }
                        .value-label {
                            color: #7f8c8d;
                            font-size: 16Shrinkpx;
                            margin-bottom: 5px;
                            font-style: italic;
                        }
                        .value {
                            color: #2c3e50;
                            font-size: 38px;
                            font-weight: bold;
                            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                        }
                        .buy-button {
                            display: block;
                            width: 100%;
                            padding: 16px;
                            background: linear-gradient(45deg, ${lead.categoria === 1 ? '#3498db, #2980b9' : '#ffd700, #b8860b'});
                            color: ${lead.categoria === 1 ? 'white' : '#1a2d3f'};
                            border: none;
                            border-radius: 50px;
                            font-size: 19px;
                            font-weight: bold;
                            cursor: ${lead.disponivel ? 'pointer' : 'not-allowed'};
                            transition: all 0.4s ease;
                            position: relative;
                            overflow: hidden;
                            box-shadow: 0 5px 15px rgba(${lead.categoria === 1 ? '52, 152, 219' : '184, 134, 11'}, 0.3);
                            opacity: ${lead.disponivel ? '1' : '0.7'};
                        }
                        .buy-button::before {
                            content: '';
                            position: absolute;
                            top: 0;
                            left: -100%;
                            width: 100%;
                            height: 100%;
                            background: rgba(255, 255, 255, 0.2);
                            transition: all 0.4s ease;
                        }
                        .buy-button:hover::before {
                            left: ${lead.disponivel ? '100%' : '-100%'};
                        }
                        .buy-button:hover {
                            transform: ${lead.disponivel ? 'scale(1.05)' : 'none'};
                            box-shadow: ${lead.disponivel ? `0 10px 20px rgba(${lead.categoria === 1 ? '52, 152, 219' : '184, 134, 11'}, 0.4)` : 'none'};
                        }
                        .buy-button:active {
                            transform: scale(1);
                        }
                        ${lead.categoria !== 1 ? `
                        .premium-badge {
                            position: absolute;
                            top: 10px;
                            right: 10px;
                            background: #ffd700;
                            color: #1a2d3f;
                            padding: 8px 15px;
                            border-radius: 20px;
                            font-size: 14px;
                            font-weight: bold;
                            text-transform: uppercase;
                        }
                        ` : ''}
                        .overlay {
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0, 0, 0, 0.7);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            z-index: 1000;
                        }
                        .overlay-card {
                            background: #ffffff;
                            padding: 2rem;
                            border-radius: 20px;
                            max-width: 450px;
                            width: 90%;
                            text-align: center;
                            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                        }
                        .overlay-card p {
                            font-size: 1.2rem;
                            color: #1e293b;
                            margin-bottom: 1.5rem;
                        }
                        .overlay-buttons {
                            display: flex;
                            gap: 1rem;
                        }
                        .overlay-btn {
                            flex: 1;
                            padding: 1rem;
                            border-radius: 12px;
                            border: none;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                        }
                        .btn-login {
                            background: #3b82f6;
                            color: #ffffff;
                        }
                        .btn-login:hover {
                            transform: translateY(-3px);
                            box-shadow: 0 5px 15px rgba(59, 130, 246, 0.4);
                        }
                        .btn-cancel {
                            background: #e2e8f0;
                            color: #64748b;
                        }
                        .btn-cancel:hover {
                            transform: translateY(-3px);
                            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
                        }
                        .checkout-overlay {
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0, 0, 0, 0.6);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            z-index: 2000;
                        }
                        .checkout-modal {
                            background: #fff;
                            width: 100%;
                            max-width: 800px;
                            height: 80vh;
                            border-radius: 12px;
                            padding: 20px;
                            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
                            display: flex;
                            flex-direction: column;
                            overflow-y: auto;
                        }
                        .checkout-header {
                            position: relative;
                            margin-bottom: 20px;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }
                        .checkout-header h2 {
                            font-size: 24px;
                            color: #333;
                            margin: 0;
                        }
                        .close-icon {
                            font-size: 24px;
                            color: #555;
                            cursor: pointer;
                            transition: color 0.2s;
                        }
                        .close-icon:hover {
                            color: #f44336;
                        }
                        .lead-info {
                            padding: 15px;
                            border-bottom: 1px solid #ddd;
                        }
                        .lead-info .lead-interesse {
                            font-size: 16px;
                            color: #1c1e21;
                            margin: 5px 0;
                        }
                        .similar-leads {
                            margin-top: 20px;
                            flex-grow: 1;
                            overflow-y: auto;
                        }
                        .similar-leads h3 {
                            font-size: 18px;
                            color: #555;
                            margin-bottom: 10px;
                        }
                        .similar-leads-container {
                            display: flex;
                            gap: 10px;
                            overflow-x: auto;
                            padding-bottom: 10px;
                        }
                        .mini-lead-card {
                            flex: 0 0 200px;
                            background: #fff;
                            border: 2px solid #ddd;
                            border-radius: 8px;
                            padding: 10px;
                            cursor: pointer;
                            transition: border-color 0.3s;
                        }
                        .mini-lead-card.selected {
                            border-color: #1877f2;
                            box-shadow: 0 0 5px rgba(24, 119, 242, 0.5);
                        }
                        .mini-lead-card .lead-badge {
                            font-size: 12px;
                            padding: 3px 6px;
                            color: #fff;
                            border-radius: 4px;
                        }
                        .mini-lead-card.alto-padrao .lead-badge {
                            background-color: #d4af37;
                        }
                        .mini-lead-card.medio-padrao .lead-badge {
                            background-color: #4682b4;
                        }
                        .mini-lead-card .lead-sku {
                            font-size: 12px;
                            color: #65676b;
                            margin: 5px 0;
                        }
                        .mini-lead-card .lead-interesse {
                            font-size: 14px;
                            color: #1c1e21;
                        }
                        .checkout-footer {
                            margin-top: 20px;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            border-top: 1px solid #ddd;
                            padding-top: 15px;
                        }
                        .total-price {
                            font-size: 18px;
                            font-weight: 600;
                            color: #333;
                        }
                        .checkout-buttons button {
                            padding: 10px 20px;
                            border-radius: 6px;
                            border: none;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            transition: background-color 0.2s;
                        }
                        .checkout-buttons .confirm-btn {
                            background-color: #1877f2;
                            color: #fff;
                        }
                        .checkout-buttons .confirm-btn:hover {
                            background-color: #166fe5;
                        }
                        @media (max-width: 500px) {
                            .checkout-overlay {
                                align-items: flex-start;
                                background: rgba(0, 0, 0, 0.8);
                            }
                            .checkout-modal {
                                width: 100%;
                                height: 90vh;
                                max-width: none;
                                border-radius: 12px 12px 0 0;
                                box-shadow: none;
                                padding: 15px;
                                position: absolute;
                                top: 10%;
                                bottom: 0;
                                overflow-y: hidden;
                            }
                            .checkout-header {
                                padding-right: 10px;
                            }
                            .lead-info {
                                padding: 10px;
                                border-bottom: 1px solid #ddd;
                            }
                            .checkout-header h2 {
                                font-size: 18px;
                            }
                            .similar-leads {
                                overflow-y: auto;
                                max-height: calc(100% - 200px);
                            }
                            .mini-lead-card {
                                flex: 0 0 160px;
                            }
                            .checkout-footer {
                                gap: 10px;
                                padding-bottom: 15px;
                            }
                            .checkout-buttons button {
                                width: 100%;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="${logoUrl}" alt="Meu Lead Itapema" class="logo">
                        <h1>Lead ${id}</h1>
                        <p class="subtitle">${categoriaTexto}</p>
                        <div class="info-box">
                            <p>${lead.interesse || "Interesse não especificado"}</p>
                        </div>
                        <div class="value-section">
                            <div class="value-label">Valor Estimado de Interesse</div>
                            <div class="value">${valorBuscado}</div>
                        </div>
                        <button class="buy-button" ${lead.disponivel ? '' : 'disabled'} onclick="comprarLead()">
                            Obter por ${valorLead}
                        </button>
                        ${lead.categoria !== 1 ? '<div class="premium-badge">Alto Padrão</div>' : ''}
                    </div>
                    <script>
                        // Funções auxiliares para manipular cookies
                        function setCookie(name, value, days) {
                            const expires = new Date();
                            expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
                            document.cookie = \`\${name}=\${value};expires=\${expires.toUTCString()};path=/;domain=.meuleaditapema.com.br;SameSite=Lax\`;
                        }
                        function getCookie(name) {
                            const value = \`; \${document.cookie}\`;
                            const parts = value.split(\`; \${name}=\`);
                            if (parts.length === 2) return parts.pop().split(';').shift();
                            return null;
                        }
                        async function comprarLead() {
                            const token = localStorage.getItem("token");
                            const userId = localStorage.getItem("userId");
                            if (!token || !userId) {
                                const overlay = document.createElement("div");
                                overlay.className = "overlay";
                                overlay.innerHTML = \`
                                    <div class="overlay-card">
                                        <p>Faça login para adquirir este lead</p>
                                        <div class="overlay-buttons">
                                            <button class="overlay-btn btn-login" onclick="window.location.href='https://meuleaditapema.com.br/login?lead=${id}'">
                                                Login
                                            </button>
                                            <button class="overlay-btn btn-cancel" onclick="this.parentElement.parentElement.parentElement.remove()">
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>
                                \`;
                                document.body.appendChild(overlay);
                            } else {
                                await mostrarCheckout('${id}', '${padrao}', '${valorLead}');
                            }
                        }
                        async function mostrarCheckout(leadId, padrao, valorFormatado) {
                            console.log("mostrarCheckout chamado com:", leadId, padrao, valorFormatado);
                            try {
                                const response = await fetch(\`https://backand.meuleaditapema.com.br/list-clientes?limit=1&offset=0&id=\${leadId}\`);
                                const data = await response.json();
                                console.log("Resposta da API:", data);
                                const lead = data.clientes && data.clientes[0] ? data.clientes[0] : {};
                                const overlay = document.createElement("div");
                                overlay.className = "checkout-overlay";
                                overlay.innerHTML = \`
                                    <div class="checkout-modal">
                                        <div class="checkout-header">
                                            <h2>Confirmar Compra de Lead</h2>
                                            <i class="close-icon" onclick="this.closest('.checkout-overlay').remove()">✖</i>
                                        </div>
                                        <div class="lead-info">
                                            <div class="lead-interesse">SKU: \${lead.id || "N/A"}</div>
                                            <div class="lead-interesse">Interesse: \${lead.interesse || "Não especificado"}</div>
                                            <div class="lead-interesse">Valor do Lead: \${valorFormatado}</div>
                                        </div>
                                        <div class="similar-leads">
                                            <h3>Leads Semelhantes</h3>
                                            <div class="similar-leads-container" id="similar-leads-container"></div>
                                        </div>
                                        <div class="checkout-footer">
                                            <div class="total-price">Total: \${valorFormatado}</div>
                                            <div class="checkout-buttons">
                                                <button class="confirm-btn" onclick="confirmarCompra('\${leadId}')">Confirmar</button>
                                            </div>
                                        </div>
                                    </div>
                                \`;
                                document.body.appendChild(overlay);
                                await carregarLeadsSemelhantes(leadId, padrao, valorFormatado);
                            } catch (error) {
                                console.error("Erro em mostrarCheckout:", error);
                            }
                        }
                        async function carregarLeadsSemelhantes(leadId, padrao, valorFormatado) {
                            try {
                                const response = await fetch(\`https://backand.meuleaditapema.com.br/list-clientes?limit=10&categoria=\${padrao === "alto-padrao" ? 2 : 1}\`);
                                const data = await response.json();
                                const similarLeadsContainer = document.getElementById("similar-leads-container");
                                const selectedLeads = [leadId];
                                let totalPrice = parseFloat(valorFormatado.replace("R$", "").replace(".", "").replace(",", "."));
                                if (data.clientes && Array.isArray(data.clientes)) {
                                    const filteredLeads = data.clientes.filter(lead => lead.id !== leadId);
                                    filteredLeads.forEach(lead => {
                                        const valorLead = parseFloat(lead.valor_lead || 0).toLocaleString('pt-BR', { 
                                            style: 'currency', 
                                            currency: 'BRL' 
                                        });
                                        const miniCard = document.createElement("div");
                                        miniCard.className = \`mini-lead-card \${padrao}\`;
                                        miniCard.innerHTML = \`
                                            <div class="lead-badge">\${padrao === "alto-padrao" ? "Alto Padrão" : "Médio Padrão"}</div>
                                            <div class="lead-sku">SKU \${lead.id}</div>
                                            <div class="lead-interesse">\${lead.interesse || "N/A"}</div>
                                            <div class="lead-interesse">\${valorLead}</div>
                                        \`;
                                        miniCard.onclick = () => {
                                            miniCard.classList.toggle("selected");
                                            const leadValue = parseFloat(lead.valor_lead || 0);
                                            if (miniCard.classList.contains("selected")) {
                                                selectedLeads.push(lead.id);
                                                totalPrice += leadValue;
                                            } else {
                                                selectedLeads.splice(selectedLeads.indexOf(lead.id), 1);
                                                totalPrice -= leadValue;
                                            }
                                            document.querySelector(".total-price").textContent = \`Total: \${totalPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\`;
                                            window.selectedLeads = selectedLeads;
                                        };
                                        similarLeadsContainer.appendChild(miniCard);
                                    });
                                }
                            } catch (error) {
                                console.error("Erro ao carregar leads semelhantes:", error);
                            }
                        }
                        async function confirmarCompra(leadId) {
                            const selectedLeads = window.selectedLeads || [leadId];
                            const token = localStorage.getItem("token");
                            const userId = localStorage.getItem("userId");

                            console.log("Leads a comprar:", selectedLeads);

                            try {
                                // Dados do pedido para enviar à rota /criar-pedido
                                const pedidoData = {
                                    userId: userId, // ID interno do corretor
                                    token: token,   // Token de autenticação
                                    entregue: false,
                                    pago: false,
                                    imoveis_id: [], // Sem imóveis neste caso
                                    leads_id: selectedLeads // Lista de IDs dos leads selecionados
                                };

                                console.log("Enviando pedido para o backend:", pedidoData);

                                // Requisição para criar o pedido
                                const response = await fetch('https://backand.meuleaditapema.com.br/criar-pedido', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify(pedidoData)
                                });

                                if (!response.ok) {
                                    const errorData = await response.json();
                                    throw new Error(errorData.error || 'Erro ao criar o pedido');
                                }

                                const result = await response.json();
                                console.log("Resposta do backend:", result);

                                // Remove o overlay de checkout
                                document.querySelector(".checkout-overlay").remove();

                                // Redireciona para a URL de pagamento (invoiceUrl)
                                if (result.success && result.invoiceUrl) {
                                    window.location.href = result.invoiceUrl;
                                } else {
                                    alert('Pedido criado com sucesso, mas não foi possível redirecionar para o pagamento.');
                                }
                            } catch (error) {
                                console.error("Erro ao confirmar compra:", error);
                                alert(\`Erro ao processar a compra: \${error.message}\`);
                            }
                        }
                        (function syncAuth() {
                            const token = getCookie("token");
                            const userId = getCookie("userId");
                            if (token && !localStorage.getItem("token")) {
                                localStorage.setItem("token", token);
                            }
                            if (userId && !localStorage.getItem("userId")) {
                                localStorage.setItem("userId", userId);
                            }
                            if (localStorage.getItem("token") && !token) {
                                setCookie("token", localStorage.getItem("token"), 30);
                            }
                            if (localStorage.getItem("userId") && !userId) {
                                setCookie("userId", localStorage.getItem("userId"), 30);
                            }
                        })();
                    </script>
                </body>
                </html>`;
            res.send(html);
        } else if (req.isImovelDomain && !req.isLeadDomain) {
            // Lógica para imóveis
            const result = await pool.query(
                `
                SELECT 
                    i.*, 
                    COALESCE(
                        (SELECT json_agg(json_build_object(
                            'id', images.id,
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
                console.log(`Imóvel ${id} não encontrado`);
                return res.status(404).send("Imóvel não encontrado");
            }
    
            const imovel = result.rows[0];
            console.log(`Dados do imóvel ${id}:`, imovel);
            console.log(`Imagens do imóvel ${id}:`, imovel.imagens);
    
            const imagens = Array.isArray(imovel.imagens) ? imovel.imagens : [];
            const logoUrl = 'https://cloud.meuleaditapema.com.br/uploads/3cbeb5c8-1937-40b0-8f03-765d7a5eba77.png'; // Logo padrão
            const primeiraImagem = imagens.length > 0 ? imagens[0].url : logoUrl; // Para og:image
    
            const html = `
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${imovel.texto_principal || "Detalhes do Imóvel"}</title>
                    <meta property="og:title" content="${imovel.texto_principal || "Imóvel sem título"}">
                    <meta property="og:description" content="${imovel.descricao || "Sem descrição disponível"}">
                    <meta property="og:image" content="${primeiraImagem}">
                    <meta property="og:image:secure_url" content="${primeiraImagem}">
                    <meta property="og:image:type" content="image/png">
                    <meta property="og:image:width" content="512">
                    <meta property="og:image:height" content="512">
                    <meta property="og:url" content="https://imovel.meuleaditapema.com.br/${id}">
                    <meta property="og:type" content="article">
                    <link rel="icon" type="image/x-icon" href="https://cloud.meuleaditapema.com.br/uploads/bc8e96dd-0f77-4955-ba77-21ed098ad2fa.ico">
                    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
                    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
                    <style>
                        * { box-sizing: border-box; margin: 0; padding: 0; }
                        body { font-family: 'Roboto', 'Helvetica', 'Arial', sans-serif; background-color: #F0F2F5; color: #1C1E21; line-height: 1.6; }
                        .slider-container { position: relative; width: 100%; max-height: 60vh; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
                        .slider { display: flex; transition: transform 0.3s ease; width: 100%; }
                        .slider img { width: 100vw; height: 60vh; object-fit: cover; flex-shrink: 0; }
                        .slider-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0, 0, 0, 0.5); color: white; border: none; padding: 15px; font-size: 30px; cursor: pointer; z-index: 10; transition: background 0.2s ease; display: none; }
                        .slider-arrow:hover { background: rgba(0, 0, 0, 0.8); }
                        .slider-arrow.left { left: 10px; }
                        .slider-arrow.right { right: 10px; }
                        .slider-dots { position: absolute; bottom: 15px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; }
                        .dot { width: 10px; height: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; cursor: pointer; transition: background 0.2s ease; }
                        .dot.active { background: white; }
                        .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
                        .detalhes-imovel { border-radius: 8px; transition: all 0.2s ease; }
                        .titulo-imovel { font-size: 32px; color: #1C1E21; margin-bottom: 16px; font-weight: 600; }
                        .preco-imovel { font-size: 24px; font-weight: 600; color: #1877F2; margin: 12px 0; }
                        .tipo-imovel { font-size: 16px; color: #60697B; margin: 8px 0; font-weight: 500; }
                        .localizacao-imovel { font-size: 16px; color: #60697B; margin: 16px 0 20px; font-weight: 500; }
                        .descricao-imovel, .negociacao-imovel { margin: 20px 0; font-size: 16px; color: #60697B; line-height: 1.8; }
                        .descricao-imovel strong, .negociacao-imovel strong { font-weight: 700; color: #1C1E21; }
                        .detalhes-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 16px; margin: 20px 0; }
                        .detalhe-item { background-color: #FFFFFF; border: 1px solid #E9ECEF; border-radius: 6px; padding: 12px; text-align: center; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05); transition: transform 0.2s ease, box-shadow 0.2s ease; }
                        .detalhe-item:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); }
                        .material-icons { font-size: 24px; color: #1877F2; margin-bottom: 4px; display: block; }
                        .detalhe-descricao { font-size: 12px; color: #60697B; margin-bottom: 4px; font-weight: 500; }
                        .detalhe-valor { font-size: 16px; color: #1C1E21; font-weight: 500; }
                        .botoes-container { display: flex; flex-direction: column; gap: 16px; margin-top: 24px; text-align: center; }
                        .btn { display: inline-block; padding: 12px 24px; font-size: 16px; font-family: 'Roboto', 'Helvetica', 'Arial', sans-serif; color: #FFFFFF; background-color: #1877F2; border: none; border-radius: 6px; cursor: pointer; transition: background-color 0.2s ease, transform 0.2s ease; width: 100%; max-width: 350px; align-self: center; }
                        .btn:hover { background-color: #166FE5; transform: translateY(-2px); }
                        .btn-secundario { background-color: #42B72A; }
                        .btn-secundario:hover { background-color: #36A420; }
                        .info-conectar, .info-afiliar { font-size: 14px; color: #60697B; margin-top: 8px; font-family: 'Roboto', 'Helvetica', 'Arial', sans-serif; line-height: 1.5; }
                        #notificacao-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
                        .notificacao { background: #FFFFFF; padding: 24px; border-radius: 8px; text-align: center; max-width: 400px; width: 90%; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
                        .notificacao p { font-size: 16px; margin-bottom: 16px; color: #1C1E21; font-family: 'Roboto', 'Helvetica', 'Arial', sans-serif; }
                        .botoes { display: flex; justify-content: space-between; gap: 12px; }
                        .notificacao-btn-azul { background: #1877F2; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; width: 48%; transition: background-color 0.2s ease, transform 0.2s ease; }
                        .notificacao-btn-azul:hover { background-color: #166FE5; transform: translateY(-2px); }
                        .notificacao-btn-cinza { background: #E9ECEF; color: #1C1E21; padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; width: 48%; transition: background-color 0.2s ease, transform 0.2s ease; }
                        .notificacao-btn-cinza:hover { background-color: #D1D5DB; transform: translateY(-2px); }
                        @media (max-width: 768px) { .slider-container { max-height: 50vh; } .slider img { height: 50vh; } .container { margin: 16px auto; padding: 0 16px; } .detalhes-imovel { padding: 16px; } .titulo-imovel { font-size: 28px; } .preco-imovel { font-size: 20px; } .tipo-imovel, .localizacao-imovel, .descricao-imovel, .negociacao-imovel { font-size: 14px; } .detalhes-grid { grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; } .btn { padding: 10px 20px; font-size: 14px; max-width: 100%; } .notificacao { padding: 16px; max-width: 350px; } .notificacao p { font-size: 14px; } }
                        @media (max-width: 480px) { .slider-container { max-height: 40vh; } .slider img { height: 40vh; } .titulo-imovel { font-size: 24px; } .preco-imovel { font-size: 18px; } .tipo-imovel, .localizacao-imovel, .descricao-imovel, .negociacao-imovel { font-size: 12px; } .detalhes-grid { grid-template-columns: 1fr 1fr; gap: 8px; } .detalhe-item { padding: 10px; } .material-icons { font-size: 20px; } .detalhe-descricao { font-size: 10px; } .detalhe-valor { font-size: 14px; } .btn { padding: 8px 16px; font-size: 12px; } .info-conectar, .info-afiliar { font-size: 12px; } }
                    </style>
                </head>
                <body>
                    <div class="slider-container" id="slider-container">
                        <button class="slider-arrow left" id="prev-arrow">‹</button>
                        <div class="slider" id="slider-imagens">
                            ${imagens.length > 0 ? imagens.map(img => `<img src="${img.url}" alt="Imagem do Imóvel" loading="lazy">`).join('') : `<img src="${logoUrl}" alt="Logo Meu Lead Itapema" loading="lazy">`}
                        </div>
                        <button class="slider-arrow right" id="next-arrow">›</button>
                        <div class="slider-dots" id="slider-dots">${imagens.length > 0 ? imagens.map((_, i) => `<div class="dot${i === 0 ? ' active' : ''}"></div>`).join('') : '<div class="dot active"></div>'}</div>
                    </div>
                    <div class="container" id="detalhes-imovel-container">
                        <div class="detalhes-imovel" id="detalhes-imovel">
                            <h1 class="titulo-imovel">${imovel.texto_principal || "Imóvel sem título"}</h1>
                            <p class="preco-imovel">${parseFloat(imovel.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                            <p class="tipo-imovel">${imovel.tipo || 'Não informado'}</p>
                            <p class="localizacao-imovel">Localização: ${imovel.endereco || 'Não informado'}</p>
                            <p class="descricao-imovel"><strong>Descrição:</strong> ${imovel.descricao || 'Sem descrição'}</p>
                            <p class="negociacao-imovel"><strong>Descrição da negociação:</strong> ${imovel.descricao_negociacao || 'Sem descrição de negociação'}</p>
                            <div class="detalhes-grid">
                                <div class="detalhe-item"><span class="material-icons">square_foot</span><span class="detalhe-descricao">Área</span><span class="detalhe-valor">${imovel.metros_quadrados || 0} m²</span></div>
                                <div class="detalhe-item"><span class="material-icons">king_bed</span><span class="detalhe-descricao">Quartos</span><span class="detalhe-valor">${imovel.quartos || 0}</span></div>
                                <div class="detalhe-item"><span class="material-icons">bathtub</span><span class="detalhe-descricao">Banheiros</span><span class="detalhe-valor">${imovel.banheiros || 0}</span></div>
                                <div class="detalhe-item"><span class="material-icons">directions_car</span><span class="detalhe-descricao">Vagas</span><span class="detalhe-valor">${imovel.vagas_garagem || 0}</span></div>
                                <div class="detalhe-item"><span class="material-icons">layers</span><span class="detalhe-descricao">Andar</span><span class="detalhe-valor">${imovel.andar || 'Não informado'}</span></div>
                                <div class="detalhe-item"><span class="material-icons">chair</span><span class="detalhe-descricao">Mobiliado</span><span class="detalhe-valor">${imovel.mobiliado ? "Sim" : "Não"}</span></div>
                            </div>
                            <div class="botoes-container">
                                <button id="btn-conectar" class="btn btn-secundario">Conectar-se por R$ ${Number(imovel.price_contato || 39.90).toFixed(2).replace('.', ',')}</button>
                                <p class="info-conectar">Ao pagar R$ ${Number(imovel.price_contato || 39.90).toFixed(2).replace('.', ',')}, você será conectado diretamente com o proprietário.</p>
                                <button id="btn-afiliar" class="btn">Afiliar-se</button>
                                <p class="info-afiliar">Receba atualizações sobre este imóvel.</p>
                            </div>
                        </div>
                    </div>
                    <script>
                        // Funções auxiliares para manipular cookies
                        function setCookie(name, value, days) {
                            const expires = new Date();
                            expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
                            document.cookie = \`\${name}=\${value};expires=\${expires.toUTCString()};path=/;domain=.meuleaditapema.com.br;SameSite=Lax\`;
                        }
    
                        function getCookie(name) {
                            const value = \`; \${document.cookie}\`;
                            const parts = value.split(\`; \${name}=\`);
                            if (parts.length === 2) return parts.pop().split(';').shift();
                            return null;
                        }
    
                        // Sincroniza localStorage com cookies ao carregar a página
                        (function syncAuth() {
                            const token = getCookie("token");
                            const userId = getCookie("userId");
                            if (token && !localStorage.getItem("token")) {
                                localStorage.setItem("token", token);
                            }
                            if (userId && !localStorage.getItem("userId")) {
                                localStorage.setItem("userId", userId);
                            }
                            if (localStorage.getItem("token") && !token) {
                                setCookie("token", localStorage.getItem("token"), 30);
                            }
                            if (localStorage.getItem("userId") && !userId) {
                                setCookie("userId", localStorage.getItem("userId"), 30);
                            }
                        })();
    
                        document.addEventListener("DOMContentLoaded", () => {
                            const slider = document.getElementById("slider-imagens");
                            const prevArrow = document.getElementById("prev-arrow");
                            const nextArrow = document.getElementById("next-arrow");
                            const dotsContainer = document.getElementById("slider-dots");
                            const totalSlides = ${imagens.length || 1};
                            let currentSlide = 0;
    
                            function updateSlider() {
                                slider.style.transform = \`translateX(-\${currentSlide * 100}vw)\`;
                                document.querySelectorAll(".dot").forEach((dot, index) => dot.classList.toggle("active", index === currentSlide));
                                prevArrow.style.display = currentSlide === 0 ? "none" : "block";
                                nextArrow.style.display = currentSlide === totalSlides - 1 ? "none" : "block";
                            }
    
                            function goToSlide(index) {
                                currentSlide = Math.max(0, Math.min(index, totalSlides - 1));
                                updateSlider();
                            }
    
                            prevArrow.addEventListener("click", () => { if (currentSlide > 0) { currentSlide--; updateSlider(); } });
                            nextArrow.addEventListener("click", () => { if (currentSlide < totalSlides - 1) { currentSlide++; updateSlider(); } });
                            dotsContainer.addEventListener("click", (e) => {
                                const dot = e.target.closest(".dot");
                                if (dot) goToSlide(Array.from(dotsContainer.children).indexOf(dot));
                            });
    
                            updateSlider();
    
                            function verificarLogin(acao) {
                                const token = localStorage.getItem("token");
                                const userId = localStorage.getItem("userId");
                                if (!token || !userId) {
                                    exibirNotificacao(acao);
                                    return false;
                                }
                                return true;
                            }
    
                            function exibirNotificacao(acao) {
                                const mensagem = acao === "afiliar-se" ? "Efetue Login para afiliar-se." : "Efetue Login para conectar-se.";
                                const overlay = document.createElement("div");
                                overlay.id = "notificacao-overlay";
                                overlay.innerHTML = \`
                                    <div class="notificacao">
                                        <p>\${mensagem}</p>
                                        <div class="botoes">
                                            <button id="notificacao-btn-login" class="notificacao-btn-azul">Fazer Login</button>
                                            <button id="notificacao-btn-cancelar" class="notificacao-btn-cinza">Cancelar</button>
                                        </div>
                                    </div>
                                \`;
                                document.body.appendChild(overlay);
    
                                document.getElementById("notificacao-btn-login").addEventListener("click", () => {
                                    window.location.href = "https://meuleaditapema.com.br/login?imovel=${id}";
                                });
                                document.getElementById("notificacao-btn-cancelar").addEventListener("click", () => {
                                    document.body.removeChild(overlay);
                                });
                            }
    
                            async function criarPedidoImovel(imovelId) {
                                const token = localStorage.getItem("token");
                                const userId = localStorage.getItem("userId");
    
                                if (!verificarLogin("conectar")) return;
    
                                try {
                                    const pedidoData = {
                                        userId: userId,
                                        token: token,
                                        entregue: false,
                                        pago: false,
                                        imoveis_id: [imovelId], // Envia o ID do imóvel
                                        leads_id: [] // Sem leads neste caso
                                    };
    
                                    console.log("Enviando pedido para o backend:", pedidoData);
    
                                    const response = await fetch('https://backand.meuleaditapema.com.br/criar-pedido', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify(pedidoData)
                                    });
    
                                    if (!response.ok) {
                                        const errorData = await response.json();
                                        throw new Error(errorData.error || 'Erro ao criar o pedido');
                                    }
    
                                    const result = await response.json();
                                    console.log("Resposta do backend:", result);
    
                                    if (result.success && result.invoiceUrl) {
                                        window.location.href = result.invoiceUrl;
                                    } else {
                                        alert('Pedido criado com sucesso, mas não foi possível redirecionar para o pagamento.');
                                    }
                                } catch (error) {
                                    console.error("Erro ao criar pedido:", error);
                                    alert(\`Erro ao processar o pagamento: \${error.message}\`);
                                }
                            }
    
                            document.getElementById("btn-afiliar").addEventListener("click", () => {
                                if (verificarLogin("afiliar-se")) console.log("Afiliado com sucesso!");
                            });
    
                            document.getElementById("btn-conectar").addEventListener("click", () => {
                                criarPedidoImovel('${id}');
                            });
                        });
                    </script>
                </body>
                </html>
            `;
            res.send(html);
        } else {
            console.log(`Domínio não reconhecido para /${id}: ${req.headers.host}`);
            res.status(400).send("Domínio não reconhecido");
        }
    } catch (err) {
        console.error("Erro na consulta:", err);
        res.status(500).send("Erro interno do servidor");
    }
});












// Rota raiz para lead.meuleaditapema.com.br
appLead.get("/", (req, res) => {
    console.log("[Lead] Raiz acessada via lead.meuleaditapema.com.br");
    res.send("Por favor, forneça o ID do lead na URL, ex.: https://lead.meuleaditapema.com.br/1");
});

// Rota para capturar ID em lead.meuleaditapema.com.br (porta 3002)
appLead.get("/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `
            SELECT 
                c.disponivel,
                c.interesse,
                c.valor_lead
            FROM clientes c
            WHERE c.id = $1
            `,
            [id]
        );

        if (result.rowCount === 0) {
            console.log(`[Lead] Lead ${id} não encontrado`);
            return res.status(404).send("Lead não encontrado");
        }

        const lead = result.rows[0];
        console.log(`[Lead] Dados do lead ${id}:`, lead);

        const logoUrl = 'http://cloud.meuleaditapema.com.br/uploads/bc8e96dd-0f77-4955-ba77-21ed098ad2fa.ico';
        const disponibilidadeTexto = lead.disponivel ? "Disponível" : "Indisponível";
        const disponibilidadeClasse = lead.disponivel ? "disponivel" : "indisponivel";

        const html = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>${lead.interesse || "Detalhes do Lead"}</title>
              <meta name="description" content="Veja lead: ${lead.interesse || 'Sem interesse especificado'}, preço de ${parseFloat(lead.valor_lead || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}">
              <meta property="og:title" content="${lead.interesse || "Lead sem título"}">
              <meta property="og:description" content="Veja lead: ${lead.interesse || 'Sem interesse especificado'}, preço de ${parseFloat(lead.valor_lead || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}">
              <meta property="og:image" content="${logoUrl}">
              <meta property="og:url" content="https://lead.meuleaditapema.com.br/${id}">
              <meta property="og:type" content="article">
              <link rel="icon" type="image/x-icon" href="${logoUrl}">
              <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
              <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: 'Roboto', 'Helvetica', 'Arial', sans-serif; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); color: #333; line-height: 1.6; display: flex; flex-direction: column; min-height: 100vh; }
                .header { text-align: center; padding: 20px 0; background: #fff; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1); }
                .header img { width: 80px; height: auto; }
                .container { max-width: 600px; margin: 40px auto; padding: 20px; background: #fff; border-radius: 15px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); flex: 1; display: flex; flex-direction: column; justify-content: center; }
                .titulo-lead { font-size: 28px; font-weight: 700; color: #2c3e50; text-align: center; margin-bottom: 20px; }
                .status { font-size: 20px; font-weight: 500; text-align: center; padding: 10px; border-radius: 8px; margin-bottom: 20px; }
                .disponivel { background: #e6ffe6; color: #2ecc71; border: 2px solid #2ecc71; }
                .indisponivel { background: #ffe6e6; color: #e74c3c; border: 2px solid #e74c3c; animation: pulse 2s infinite; }
                @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
                .btn-comprar { display: block; width: 100%; max-width: 300px; margin: 0 auto; padding: 15px; font-size: 18px; font-weight: 600; color: #fff; background: #3498db; border: none; border-radius: 10px; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(52, 152, 219, 0.3); }
                .btn-comprar:hover { background: #2980b9; transform: translateY(-3px); box-shadow: 0 6px 20px rgba(52, 152, 219, 0.5); }
                .btn-comprar:disabled { background: #bdc3c7; cursor: not-allowed; box-shadow: none; }
                @media (max-width: 768px) { .container { margin: 20px; padding: 15px; } .titulo-lead { font-size: 24px; } .status { font-size: 18px; } .btn-comprar { font-size: 16px; padding: 12px; } }
                @media (max-width: 480px) { .header img { width: 60px; } .titulo-lead { font-size: 20px; } .status { font-size: 16px; } .btn-comprar { font-size: 14px; padding: 10px; } }
              </style>
            </head>
            <body>
              <header class="header">
                <img src="${logoUrl}" alt="Meu Lead Itapema Logo">
              </header>
              <div class="container">
                <h1 class="titulo-lead">${lead.interesse || "Lead sem título"}</h1>
                <p class="status ${disponibilidadeClasse}">${disponibilidadeTexto}</p>
                <button class="btn-comprar" ${lead.disponivel ? '' : 'disabled'} onclick="comprarLead()">Comprar por ${parseFloat(lead.valor_lead || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</button>
              </div>
              <script>
                function comprarLead() {
                  const token = localStorage.getItem("token");
                  if (!token) {
                    const overlay = document.createElement("div");
                    overlay.id = "notificacao-overlay";
                    overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;";
                    overlay.innerHTML = \`
                      <div style="background: #fff; padding: 20px; border-radius: 10px; text-align: center; max-width: 400px; width: 90%; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);">
                        <p style="font-size: 16px; margin-bottom: 15px;">Efetue login para comprar este lead.</p>
                        <div style="display: flex; justify-content: space-between; gap: 10px;">
                          <button onclick="window.location.href='/login?id=${id}'" style="background: #3498db; color: #fff; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; width: 48%;">Fazer Login</button>
                          <button onclick="document.body.removeChild(document.getElementById('notificacao-overlay'))" style="background: #ecf0f1; color: #333; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; width: 48%;">Cancelar</button>
                        </div>
                      </div>
                    \`;
                    document.body.appendChild(overlay);
                  } else {
                    alert("Lead comprado com sucesso! (Funcionalidade a implementar)");
                  }
                }
              </script>
            </body>
            </html>
        `;
        res.send(html);
    } catch (err) {
        console.error("[Lead] Erro na consulta:", err);
        res.status(500).send("Erro interno do servidor");
    }
});





























const httpServerLead = appLead.listen(portLead, () => {
    console.log(`Servidor Lead rodando em http://localhost:${portLead}`);
});






