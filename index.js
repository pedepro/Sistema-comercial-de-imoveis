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
app.post('/login', async (req, res) => {
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




app.get('/list-imoveis', async (req, res) => {
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


app.get('/list-clientes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
