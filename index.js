const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios'); // Adicionado o módulo axios
require('dotenv').config();
const cors = require('cors');
const fs = require('fs').promises; // Módulo para manipular arquivos assíncronos

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





// Função para processar envios agendados
// Função para processar envios agendados
const processarEnviosAgendados = async () => {
    const agora = new Date();
    const agoraLocal = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    console.log(`⏰ Hora atual do servidor (GMT-3): ${agoraLocal.toLocaleString('pt-BR')}`);

    const limiteTolerancia = 60 * 1000; // 60 segundos em milissegundos
    const dataLimiteLocal = new Date(agoraLocal.getTime() - limiteTolerancia);
    console.log(`📅 Data limite (agora - 60s, GMT-3): ${dataLimiteLocal.toLocaleString('pt-BR')}`);

    try {
        // Busca todos os envios para depuração
        const todosQuery = `
            SELECT id, agendado AT TIME ZONE 'America/Sao_Paulo' AS agendado, finalizado
            FROM envio_em_massa
            ORDER BY agendado;
        `;
        const todosResult = await pool.query(todosQuery);
        console.log('🔍 Todos os envios encontrados no banco (GMT-3):');
        todosResult.rows.forEach(envio => {
            const dataAgendada = new Date(envio.agendado);
            console.log(`  - ID: ${envio.id}, Agendado: ${dataAgendada.toLocaleString('pt-BR')}, Finalizado: ${envio.finalizado}`);
            console.log(`    ISO (armazenado, UTC): ${envio.agendado.toISOString()}`);
        });

        // Busca envios pendentes no fuso local
        const pendentesQuery = `
            SELECT *
            FROM envio_em_massa
            WHERE finalizado = FALSE
            AND agendado AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' <= $1
            AND agendado AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' >= $2
        `;
        const values = [agoraLocal, dataLimiteLocal];
        const result = await pool.query(pendentesQuery, values);
        const enviosPendentes = result.rows;

        console.log(`🔍 Envios pendentes filtrados (finalizado = FALSE, agendado entre ${dataLimiteLocal.toLocaleString('pt-BR')} e ${agoraLocal.toLocaleString('pt-BR')}):`);
        if (enviosPendentes.length === 0) {
            console.log('ℹ️ Nenhum envio pendente encontrado no intervalo de tolerância.');
        } else {
            enviosPendentes.forEach(envio => {
                const dataAgendada = new Date(envio.agendado);
                const diffMs = agoraLocal - dataAgendada;
                console.log(`  - ID: ${envio.id}, Agendado: ${dataAgendada.toLocaleString('pt-BR')}, Diferença: ${diffMs / 1000}s`);
                console.log(`    ISO (UTC): ${dataAgendada.toISOString()}`);
            });
        }

        for (const envio of enviosPendentes) {
            console.log(`✅ Processando envio ID ${envio.id} agendado para ${new Date(envio.agendado).toLocaleString('pt-BR')}`);

            // Busca os detalhes completos do envio, incluindo corretores
            const detalhesQuery = `
                SELECT 
                    em.*,
                    json_agg(
                        json_build_object(
                            'phone', c.phone,
                            'name', c.name,
                            'creci', c.creci,
                            'email', c.email
                        )
                    ) FILTER (WHERE c.id IS NOT NULL) as corretores_detalhes
                FROM envio_em_massa em
                CROSS JOIN LATERAL unnest(em.corretores) AS corr(id)
                LEFT JOIN corretores c ON c.id = corr.id
                WHERE em.id = $1
                GROUP BY em.id;
            `;
            const detalhesResult = await pool.query(detalhesQuery, [envio.id]);

            if (detalhesResult.rows.length === 0) {
                console.log(`⚠️ Envio ID ${envio.id} não encontrado nos detalhes. Pulando...`);
                continue;
            }

            const envioDetalhado = detalhesResult.rows[0];
            console.log(`ℹ️ Detalhes do envio ID ${envio.id} recuperados com sucesso.`);

            // Chama a função de processamento diretamente
            try {
                await processarEnvioEmMassa(envioDetalhado);
                console.log(`✅ Envio ID ${envio.id} processado com sucesso pela função interna`);
            } catch (processError) {
                console.error(`❌ Erro ao processar envio ID ${envio.id} internamente:`, processError.message);
            }
        }
    } catch (error) {
        console.error('❌ Erro ao processar envios agendados:', error);
    }
};

// Inicia o processamento imediatamente e a cada 60 segundos
processarEnviosAgendados();
setInterval(processarEnviosAgendados, 60 * 1000);

// Função para pausar a execução por um tempo (em milissegundos)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Função para formatar a mensagem com os dados do corretor
const formatarMensagem = (mensagem, corretor) => {
    return mensagem
        .replace('@name', corretor.name || '')
        .replace('@email', corretor.email || '')
        .replace('@phone', corretor.phone || '');
};

// Função para processar o envio em massa
const processarEnvioEmMassa = async (envio) => {
    let sucesso = true; // Flag para rastrear se houve sucesso total

    try {
        // Verifica se os campos necessários estão presentes
        if (!envio.id || !envio.corretores_detalhes || !envio.mensagem || typeof envio.email !== 'boolean' || typeof envio.whatsapp !== 'boolean') {
            throw new Error('Dados incompletos no envio');
        }

        const { id, email, whatsapp, intervalo, mensagem, corretores_detalhes, titulo, tipo_imovel, html_email } = envio;
        console.log(`✅ Iniciando processamento do envio ID ${id}. Email: ${email}, WhatsApp: ${whatsapp}, Intervalo: ${intervalo}ms, Tipo Imóvel: ${tipo_imovel}`);

        // Processa cada corretor
        for (let i = 0; i < corretores_detalhes.length; i++) {
            const corretor = corretores_detalhes[i];
            const mensagemFormatada = formatarMensagem(mensagem, corretor);
            const tituloFormatado = formatarMensagem(titulo || '', corretor); // Formata o título, se existir
            const conteudoEmail = tipo_imovel ? formatarMensagem(html_email || '', corretor) : mensagemFormatada; // Usa html_email se tipo_imovel for true
            console.log(`📋 Processando corretor ${corretor.name} (ID ${id})`);

            // Envio por email, se habilitado
            if (email && corretor.email) {
                try {
                    const emailResponse = await axios.post(
                        'https://automacao.meuleaditapema.com.br/webhook-test/enviar-email-corretor-em-massa',
                        {
                            email: corretor.email,
                            mensagem: conteudoEmail, // Usa html_email se tipo_imovel for true, senão usa mensagem
                            titulo: tituloFormatado // Inclui o título formatado no envio de email
                        },
                        { headers: { 'Content-Type': 'application/json' } }
                    );
                    console.log(`✉️ Email enviado com sucesso para ${corretor.email} - Status: ${emailResponse.status}`);
                } catch (emailError) {
                    console.error(`❌ Erro ao enviar email para ${corretor.email}:`, emailError.message);
                    sucesso = false; // Marca como falha parcial
                }
            }

            // Envio por WhatsApp, se habilitado
            if (whatsapp && corretor.phone) {
                try {
                    const whatsappResponse = await axios.post(
                        'https://server.zapnerd.cloud/message/sendText/meuleaditapema',
                        {
                            number: corretor.phone,
                            text: mensagemFormatada, // Sempre usa mensagem para WhatsApp
                            delay: 1200,
                            linkPreview: true
                        },
                        {
                            headers: {
                                'apikey': 'BCF8A5D3D512-456E-BF07-D80CCA3714FC',
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    console.log(`📱 WhatsApp enviado com sucesso para ${corretor.phone} - Status: ${whatsappResponse.status}`);
                } catch (whatsappError) {
                    console.error(`❌ Erro ao enviar WhatsApp para ${corretor.phone}:`, whatsappError.message);
                    sucesso = false; // Marca como falha parcial
                }
            }

            // Aguarda o intervalo antes de processar o próximo corretor, se houver mais corretores
            if (i < corretores_detalhes.length - 1 && (email || whatsapp)) {
                console.log(`⏳ Aguardando intervalo de ${intervalo}ms antes do próximo envio...`);
                await delay(intervalo);
            }
        }

        console.log(`✅ Envio ID ${id} concluído ${sucesso ? 'com sucesso' : 'com erros'}`);
        return { success: sucesso, message: `Envio ID ${id} processado ${sucesso ? 'com sucesso' : 'com erros'}` };
    } catch (error) {
        console.error(`❌ Erro ao processar envio em massa ID ${envio.id}:`, error.message);
        throw error;
    } finally {
        // Atualiza o campo finalizado para true, mesmo com erros
        try {
            const updateQuery = `
                UPDATE envio_em_massa
                SET finalizado = TRUE
                WHERE id = $1;
            `;
            await pool.query(updateQuery, [envio.id]);
            console.log(`✅ Status do envio ID ${envio.id} atualizado para finalizado = TRUE`);
        } catch (updateError) {
            console.error(`❌ Erro ao atualizar status do envio ID ${envio.id} para finalizado:`, updateError.message);
        }
    }
};
































// Busca do Facebook Pixel na tabela mli_ajustes (id = 1)
app.get('/ajustes/facebook-pixel', async (req, res) => {
    try {
        // Query para buscar o facebook_pixel onde id = 1
        const query = `
            SELECT facebook_pixel
            FROM mli_ajustes
            WHERE id = 1;
        `;

        // Executa a query
        const result = await pool.query(query);

        // Verifica se o registro existe
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Registro com id = 1 não encontrado' });
        }

        // Retorna o valor do facebook_pixel
        res.status(200).json({
            facebook_pixel: result.rows[0].facebook_pixel
        });

    } catch (error) {
        console.error('❌ Erro ao buscar facebook_pixel:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});




// Atualização do Facebook Pixel na tabela mli_ajustes (apenas id = 1)
app.put('/ajustes/facebook-pixel', async (req, res) => {
    try {
        const { facebook_pixel } = req.body; // Recebe o novo valor do Facebook Pixel via corpo da requisição

        // Validação básica
        if (!facebook_pixel || typeof facebook_pixel !== 'string') {
            return res.status(400).json({ error: 'O campo facebook_pixel é obrigatório e deve ser uma string' });
        }

        // Query para atualizar a coluna facebook_pixel onde id = 1
        const query = `
            UPDATE mli_ajustes
            SET facebook_pixel = $1
            WHERE id = 1
            RETURNING *;  -- Retorna os dados atualizados
        `;
        const values = [facebook_pixel];

        // Executa a query
        const result = await pool.query(query, values);

        // Verifica se o registro foi atualizado
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Registro com id = 1 não encontrado' });
        }

        // Retorna o registro atualizado
        res.status(200).json({
            message: 'Facebook Pixel atualizado com sucesso',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('❌ Erro ao atualizar facebook_pixel:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});




app.get('/get-content', async (req, res) => {
    try {
        // Busca os ajustes (apenas id = 1)
        const ajustesResult = await pool.query('SELECT * FROM mli_ajustes WHERE id = 1');
        if (ajustesResult.rowCount === 0) {
            return res.status(404).json({ error: 'Ajustes com id = 1 não encontrados' });
        }

        // Busca todos os valores
        const valoresResult = await pool.query('SELECT * FROM mli_valores');

        // Busca todos os feedbacks
        const feedbacksResult = await pool.query('SELECT * FROM mli_feedbacks');

        // Monta o response com os dados
        const response = {
            ajustes: ajustesResult.rows[0], // Apenas a primeira linha
            valores: valoresResult.rows,    // Todas as linhas
            feedbacks: feedbacksResult.rows // Todas as linhas
        };

        res.json(response);
    } catch (err) {
        console.error('Erro ao buscar conteúdo:', err);
        res.status(500).json({ error: 'Erro interno no servidor', details: err.message });
    }
});








app.post('/edit-content', async (req, res) => {
    const { table, action, data } = req.body;

    // Validação inicial
    if (!table || !action || !data) {
        return res.status(400).json({ error: 'Parâmetros "table", "action" e "data" são obrigatórios' });
    }

    if (!['mli_ajustes', 'mli_valores', 'mli_feedbacks'].includes(table)) {
        return res.status(400).json({ error: 'Tabela inválida' });
    }

    if (!['update', 'create', 'delete'].includes(action) && !(table === 'mli_ajustes' && action === 'update')) {
        return res.status(400).json({ error: 'Ação inválida ou não permitida para a tabela' });
    }

    try {
        if (table === 'mli_ajustes') {
            // Só permite atualização da linha id = 1
            const { titulo, subtitulo, tipo_apn, video, imagens } = data;
            const result = await pool.query(
                `
                UPDATE mli_ajustes 
                SET 
                    titulo = $1, 
                    subtitulo = $2, 
                    tipo_apn = $3, 
                    video = $4, 
                    imagens = $5 
                WHERE id = 1
                RETURNING *
                `,
                [titulo, subtitulo, tipo_apn, video, imagens]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Linha com id = 1 não encontrada em mli_ajustes' });
            }
            res.json({ message: 'Ajustes atualizados com sucesso', data: result.rows[0] });
        } 
        else if (table === 'mli_valores') {
            if (action === 'create') {
                const { img, titulo, subtitulo } = data;
                const result = await pool.query(
                    `
                    INSERT INTO mli_valores (img, titulo, subtitulo) 
                    VALUES ($1, $2, $3) 
                    RETURNING *
                    `,
                    [img, titulo, subtitulo]
                );
                res.json({ message: 'Valor criado com sucesso', data: result.rows[0] });
            } 
            else if (action === 'update') {
                const { id, img, titulo, subtitulo } = data;
                const result = await pool.query(
                    `
                    UPDATE mli_valores 
                    SET img = $1, titulo = $2, subtitulo = $3 
                    WHERE id = $4 
                    RETURNING *
                    `,
                    [img, titulo, subtitulo, id]
                );
                if (result.rowCount === 0) {
                    return res.status(404).json({ error: 'Valor não encontrado' });
                }
                res.json({ message: 'Valor atualizado com sucesso', data: result.rows[0] });
            } 
            else if (action === 'delete') {
                const { id } = data;
                const result = await pool.query(
                    'DELETE FROM mli_valores WHERE id = $1 RETURNING *',
                    [id]
                );
                if (result.rowCount === 0) {
                    return res.status(404).json({ error: 'Valor não encontrado' });
                }
                res.json({ message: 'Valor excluído com sucesso', data: result.rows[0] });
            }
        } 
        else if (table === 'mli_feedbacks') {
            if (action === 'create') {
                const { img, nome, comentario } = data;
                const result = await pool.query(
                    `
                    INSERT INTO mli_feedbacks (img, nome, comentario) 
                    VALUES ($1, $2, $3) 
                    RETURNING *
                    `,
                    [img, nome, comentario]
                );
                res.json({ message: 'Feedback criado com sucesso', data: result.rows[0] });
            } 
            else if (action === 'update') {
                const { id, img, nome, comentario } = data;
                const result = await pool.query(
                    `
                    UPDATE mli_feedbacks 
                    SET img = $1, nome = $2, comentario = $3 
                    WHERE id = $4 
                    RETURNING *
                    `,
                    [img, nome, comentario, id]
                );
                if (result.rowCount === 0) {
                    return res.status(404).json({ error: 'Feedback não encontrado' });
                }
                res.json({ message: 'Feedback atualizado com sucesso', data: result.rows[0] });
            } 
            else if (action === 'delete') {
                const { id } = data;
                const result = await pool.query(
                    'DELETE FROM mli_feedbacks WHERE id = $1 RETURNING *',
                    [id]
                );
                if (result.rowCount === 0) {
                    return res.status(404).json({ error: 'Feedback não encontrado' });
                }
                res.json({ message: 'Feedback excluído com sucesso', data: result.rows[0] });
            }
        }
    } catch (err) {
        console.error(`Erro ao editar ${table}:`, err);
        res.status(500).json({ error: 'Erro interno no servidor', details: err.message });
    }
});



// Caminho para o arquivo JSON
const textosFilePath = './textos.json';

// Rota para pegar os textos (GET)
app.get('/textos', async (req, res) => {
    try {
        const data = await fs.readFile(textosFilePath, 'utf8');
        const textos = JSON.parse(data);
        res.json({ success: true, textos });
    } catch (error) {
        console.error('Erro ao ler textos:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar textos' });
    }
});

// Rota para editar os textos (POST)
app.post('/editar-textos', async (req, res) => {
    try {
        const novosTextos = req.body; // Recebe o objeto completo com os dados

        // Lê o arquivo atual
        let textosAtuais = {};
        try {
            const data = await fs.readFile(textosFilePath, 'utf8');
            textosAtuais = JSON.parse(data);
        } catch (err) {
            // Se o arquivo não existir, começamos com um objeto vazio
            console.warn('Arquivo textos.json não encontrado, criando novo.');
        }

        // Mescla os textos atuais com os novos
        const textosAtualizados = { ...textosAtuais, ...novosTextos };

        // Salva o arquivo
        await fs.writeFile(textosFilePath, JSON.stringify(textosAtualizados, null, 2), 'utf8');
        
        res.json({ success: true, message: 'Textos atualizados com sucesso' });
    } catch (error) {
        console.error('Erro ao editar textos:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar textos' });
    }
});
















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



// 1. Rota para criar/popular envio_em_massa
app.post('/envio-em-massa', async (req, res) => {
    try {
        const {
            corretores,
            mensagem,
            email,
            whatsapp,
            intervalo,
            agendado,
            titulo,        // Novo campo opcional
            tipo_imovel,   // Novo campo opcional, padrão false
            html_email     // Novo campo opcional
        } = req.body;

        const query = `
            INSERT INTO envio_em_massa (
                corretores,
                mensagem,
                email,
                whatsapp,
                intervalo,
                agendado,
                titulo,
                tipo_imovel,
                html_email
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;

        const values = [
            corretores || [],               // Array de inteiros, vazio se não fornecido
            mensagem || null,               // Null se não fornecido
            email !== undefined ? email : false, // Padrão false
            whatsapp !== undefined ? whatsapp : false, // Padrão false
            intervalo !== undefined ? intervalo : 3000, // Padrão 3000ms
            agendado || null,               // Se null, usa default do banco (data atual + 1 min)
            titulo || null,                 // Null se não fornecido
            tipo_imovel !== undefined ? tipo_imovel : false, // Padrão false
            html_email || null              // Null se não fornecido
        ];

        const result = await pool.query(query, values);
        
        res.status(201).json({
            data: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Erro ao criar envio em massa:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// 2. Rota para buscar envios com detalhes dos corretores
app.get('/envio-em-massa', async (req, res) => {
    try {
        const {
            page,            // Paginação: página atual
            limit,           // Paginação: itens por página
            search,          // Busca por mensagem
            sortBy = 'created_at', // Ordenação
            sortOrder = 'DESC'     // Ordem
        } = req.query;

        // Constrói a query base
        let query = `
            SELECT 
                em.*,
                json_agg(
                    json_build_object(
                        'phone', c.phone,
                        'name', c.name,
                        'creci', c.creci,
                        'email', c.email
                    )
                ) FILTER (WHERE c.id IS NOT NULL) as corretores_detalhes
            FROM envio_em_massa em
            CROSS JOIN LATERAL unnest(em.corretores) AS corr(id)
            LEFT JOIN corretores c ON c.id = corr.id
        `;
        let conditions = [];
        let values = [];

        // Busca por mensagem
        if (search) {
            conditions.push(`mensagem ILIKE $${values.length + 1}`);
            values.push(`%${search}%`);
        }

        // Junta as condições
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Conta total de registros
        const countQuery = `
            SELECT COUNT(*) 
            FROM envio_em_massa
            ${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}
        `;
        const countResult = await pool.query(countQuery, values);
        const totalItems = parseInt(countResult.rows[0].count);

        // Validação e aplicação da ordenação
        const validSortFields = ['created_at', 'agendado', 'intervalo'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
        const validSortOrders = ['ASC', 'DESC'];
        const order = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

        query += ` GROUP BY em.id ORDER BY ${sortField} ${order}`;

        // Aplica paginação se fornecida
        let paginationApplied = false;
        let totalPages = 1;
        if (page && limit) {
            const pageNum = parseInt(page) || 1;
            const limitNum = parseInt(limit) || 10;
            const offset = (pageNum - 1) * limitNum;
            totalPages = Math.ceil(totalItems / limitNum);
            query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
            values.push(limitNum, offset);
            paginationApplied = true;
        }

        const result = await pool.query(query, values);

        // Formata a resposta
        const response = {
            data: result.rows,
            pagination: paginationApplied ? {
                currentPage: parseInt(page) || 1,
                itemsPerPage: parseInt(limit) || 10,
                totalItems,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1
            } : undefined
        };

        res.status(200).json(response);
    } catch (error) {
        console.error('❌ Erro ao listar envios em massa:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});


app.get('/envio-em-massa/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                em.*,
                json_agg(
                    json_build_object(
                        'phone', c.phone,
                        'name', c.name,
                        'creci', c.creci,
                        'email', c.email
                    )
                ) FILTER (WHERE c.id IS NOT NULL) as corretores_detalhes
            FROM envio_em_massa em
            CROSS JOIN LATERAL unnest(em.corretores) AS corr(id)
            LEFT JOIN corretores c ON c.id = corr.id
            WHERE em.id = $1
            GROUP BY em.id;
        `;
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Envio não encontrado' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('❌ Erro ao buscar envio por ID:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// 3. Rota para atualizar finalizado e agendado
app.patch('/envio-em-massa/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { finalizado, agendado, corretores } = req.body;

        if (finalizado === undefined && agendado === undefined && corretores === undefined) {
            return res.status(400).json({ error: 'Nenhum campo para atualização fornecido' });
        }

        let query = 'UPDATE envio_em_massa SET ';
        let updates = [];
        let values = [];
        let paramCount = 1;

        if (finalizado !== undefined) {
            updates.push(`finalizado = $${paramCount}`);
            values.push(finalizado);
            paramCount++;
        }
        if (agendado !== undefined) {
            updates.push(`agendado = $${paramCount}`);
            values.push(agendado);
            paramCount++;
        }
        if (corretores !== undefined) {
            updates.push(`corretores = $${paramCount}`);
            values.push(corretores); // Array de inteiros
            paramCount++;
        }

        query += updates.join(', ') + ` WHERE id = $${paramCount} RETURNING *`;
        values.push(id);

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Envio não encontrado' });
        }

        res.status(200).json({
            data: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Erro ao atualizar envio em massa:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});


// 4. Rota para deletar envio em massa
app.delete('/envio-em-massa/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const query = `
            DELETE FROM envio_em_massa
            WHERE id = $1
            RETURNING *;
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Envio não encontrado' });
        }

        res.status(200).json({
            data: result.rows[0],
            message: 'Envio em massa deletado com sucesso'
        });
    } catch (error) {
        console.error('❌ Erro ao deletar envio em massa:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
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

        // Filtro por categoria (padrão)
        if (req.query.categoria) {
            const categoria = parseInt(req.query.categoria);
            if (isNaN(categoria) || (categoria !== 1 && categoria !== 2)) {
                return res.status(400).json({ success: false, error: 'Categoria deve ser 1 (Médio Padrão) ou 2 (Alto Padrão)' });
            }
            query += ' AND i.categoria = $' + (params.length + 1);
            params.push(categoria);
        }

        // Filtro por imóvel pronto (NOVO)
        if (req.query.imovel_pronto) {
            const imovelPronto = req.query.imovel_pronto === 'true';
            query += ' AND i.imovel_pronto = $' + (params.length + 1);
            params.push(imovelPronto);
        }

        // Filtro por mobiliado (NOVO)
        if (req.query.mobiliado) {
            const mobiliado = req.query.mobiliado === 'true';
            query += ' AND i.mobiliado = $' + (params.length + 1);
            params.push(mobiliado);
        }

        // Filtro por destaque (se fornecido)
        if (req.query.destaque) {
            const destaque = req.query.destaque === 'true';
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
        if (req.query.categoria) {
            totalQuery += ' AND i.categoria = $' + (totalParams.length + 1);
            totalParams.push(parseInt(req.query.categoria));
        }
        if (req.query.imovel_pronto) {
            totalQuery += ' AND i.imovel_pronto = $' + (totalParams.length + 1);
            totalParams.push(req.query.imovel_pronto === 'true');
        }
        if (req.query.mobiliado) {
            totalQuery += ' AND i.mobiliado = $' + (totalParams.length + 1);
            totalParams.push(req.query.mobiliado === 'true');
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

//lista apenas clientes disponiveis aceita filtros e paginação
app.get('/list/clientes', async (req, res) => {
    try {
        console.log("🚀 Recebendo requisição em /list-clientes-disponiveis");
        console.log("📥 Query Params recebidos:", req.query);

        let query = 'SELECT * FROM clientes WHERE disponivel = true'; // Filtro fixo para disponivel = true
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

        // Filtros booleanos (exceto disponivel, que agora é fixo)
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

        if (req.query.destaque !== undefined) {
            const destaque = req.query.destaque === 'true' || req.query.destaque === true;
            query += ` AND destaque = $${index}`;
            values.push(destaque);
            console.log(`📌 Filtro destaque: ${destaque}`);
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
            let similarQuery = 'SELECT * FROM clientes WHERE disponivel = true AND nome ILIKE $1 LIMIT 5';
            let similarValues = [`%${req.query.busca}%`];
            const similarResult = await pool.query(similarQuery, similarValues);
            clientes = similarResult.rows;
            console.log(`📌 Itens parecidos encontrados: ${clientes.length}`);
        }

        // Consulta de contagem
        let countQuery = 'SELECT COUNT(*) FROM clientes WHERE disponivel = true'; // Filtro fixo para disponivel = true
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

        if (req.query.destaque !== undefined) {
            const destaque = req.query.destaque === 'true' || req.query.destaque === true;
            countQuery += ` AND destaque = $${countIndex}`;
            countValues.push(destaque);
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
        console.error("❌ Erro ao buscar clientes disponíveis:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


//lista todos os clientes e aceita filtros e paginação
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

        if (req.query.destaque !== undefined) {
            const destaque = req.query.destaque === 'true' || req.query.destaque === true;
            query += ` AND destaque = $${index}`;
            values.push(destaque);
            console.log(`📌 Filtro destaque: ${destaque}`);
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

        if (req.query.destaque !== undefined) {
            const destaque = req.query.destaque === 'true' || req.query.destaque === true;
            countQuery += ` AND destaque = $${countIndex}`;
            countValues.push(destaque);
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




// Rota para atualizar um lead existente
app.put('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            titulo, 
            nome, 
            categoria, 
            endereco, 
            tipo_imovel, 
            interesse, 
            valor, 
            valor_lead, 
            whatsapp, 
            disponivel,
            aprovado,
            destaque 
        } = req.body;

        console.log(`🚀 Recebendo requisição em /clientes/${id} para atualização`);
        console.log("📥 Dados recebidos:", req.body);

        // Verifica se o lead existe e obtém o estado atual de 'aprovado'
        const checkQuery = 'SELECT aprovado FROM clientes WHERE id = $1';
        const checkResult = await pool.query(checkQuery, [id]);
        if (checkResult.rows.length === 0) {
            console.warn(`⚠️ Lead com ID ${id} não encontrado`);
            return res.status(404).json({ success: false, error: "Lead não encontrado" });
        }

        const currentAprovado = checkResult.rows[0].aprovado;

        // Validação: Não permitir disponivel = true se aprovado for false
        if (disponivel !== undefined && aprovado !== undefined) {
            // Caso ambos sejam enviados na requisição
            if (disponivel === true && aprovado === false) {
                console.warn(`⚠️ Tentativa de tornar disponível sem aprovação. Disponível: ${disponivel}, Aprovado: ${aprovado}`);
                return res.status(400).json({ 
                    success: false, 
                    error: "Não é possível tornar um lead disponível se ele não estiver aprovado" 
                });
            }
        } else if (disponivel === true) {
            // Caso apenas disponivel seja enviado, verifica o estado atual de aprovado
            if (currentAprovado === false) {
                console.warn(`⚠️ Tentativa de tornar disponível sem aprovação. Estado atual de aprovado: ${currentAprovado}`);
                return res.status(400).json({ 
                    success: false, 
                    error: "Não é possível tornar um lead disponível se ele não estiver aprovado" 
                });
            }
        }

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
        if (destaque !== undefined) {
            fields.push(`destaque = $${index}`);
            values.push(destaque);
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


// Rota para buscar detalhes de um lead específico por ID
app.get('/clientes/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT id, disponivel, cotas_compradas, categoria, ai_created, created_at, 
                    destaque, valor, interesse, tipo_imovel, valor_lead, titulo 
             FROM clientes 
             WHERE id = $1 
             LIMIT 1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Lead não encontrado" });
        }

        res.json({ cliente: result.rows[0] });
    } catch (error) {
        console.error("Erro ao buscar lead:", error);
        res.status(500).json({ error: "Erro interno ao buscar lead" });
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



// lista imoveis de um corretor 
app.get('/list-imoveis/:id', async (req, res) => {
    const corretorId = req.params.id;
    const limit = parseInt(req.query.limit) || 6;  // Alinha com o nome esperado pelo front-end
    const offset = parseInt(req.query.offset) || 0;

    try {
        // Consulta para obter os arrays de IDs de imóveis do corretor
        const corretorResult = await pool.query(
            'SELECT imoveis_comprados, imoveis_afiliados FROM corretores WHERE id = $1',
            [corretorId]
        );

        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const imoveisComprados = corretorResult.rows[0].imoveis_comprados || [];
        const imoveisAfiliados = corretorResult.rows[0].imoveis_afiliados || [];
        const todosImoveisIds = [...new Set([...imoveisComprados, ...imoveisAfiliados])];

        if (todosImoveisIds.length === 0) {
            return res.status(200).json({ success: true, imoveis: [], total: 0 });
        }

        // Consulta para contar o total de imóveis
        const totalResult = await pool.query(
            'SELECT COUNT(*) FROM imoveis WHERE id = ANY($1)',
            [todosImoveisIds]
        );
        const total = parseInt(totalResult.rows[0].count);

        // Consulta principal com paginação
        const query = `
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
            ORDER BY i.id
            LIMIT $2 OFFSET $3
        `;
        const params = [todosImoveisIds, limit, offset];

        const result = await pool.query(query, params);

        // Adicionando informação de origem
        const imoveisComOrigem = result.rows.map(imovel => {
            const origem = imoveisComprados.includes(imovel.id) 
                ? (imoveisAfiliados.includes(imovel.id) ? 'ambos' : 'comprado') 
                : 'afiliado';
            return { ...imovel, origem };
        });

        res.json({
            success: true,
            imoveis: imoveisComOrigem,
            total: total
        });
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



// Rota para listar os clientes de um corretor, com suporte à paginação
app.get('/list-clientes/:id', async (req, res) => {
    const corretorId = req.params.id;  // Obtendo o ID do corretor a partir da URL
    const limit = parseInt(req.query.limit) || 10;  // Número de itens por página, padrão 10
    const offset = parseInt(req.query.offset) || 0;  // Ponto de início, padrão 0

    try {
        // Consulta para obter o array de IDs de clientes do corretor
        const corretorResult = await pool.query(
            'SELECT clientes FROM corretores WHERE id = $1',
            [corretorId]
        );

        // Verificando se o corretor foi encontrado
        if (corretorResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Corretor não encontrado' });
        }

        const clientesIds = corretorResult.rows[0].clientes;

        // Verificando se o corretor tem clientes associados
        if (!clientesIds || clientesIds.length === 0) {
            return res.status(200).json({ success: true, clientes: [], total: 0 });
        }

        // Consulta para contar o total de clientes (sem paginação)
        const totalResult = await pool.query(
            'SELECT COUNT(*) FROM clientes WHERE id = ANY($1)',
            [clientesIds]
        );
        const total = parseInt(totalResult.rows[0].count);

        // Consulta para obter os clientes com base nos IDs, com paginação
        const clientesResult = await pool.query(
            'SELECT * FROM clientes WHERE id = ANY($1) ORDER BY id LIMIT $2 OFFSET $3',
            [clientesIds, limit, offset]
        );

        // Retornando os clientes encontrados com o total
        res.json({
            success: true,
            clientes: clientesResult.rows,
            total: total
        });
    } catch (err) {
        console.error('Erro ao listar clientes:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// rota para listar pedidos de um corretor
app.get('/list-pedidos/:id', async (req, res) => {
    const corretorId = req.params.id;
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    try {
        // Consulta principal para obter os pedidos do corretor
        const pedidosResult = await pool.query(
            `SELECT *
             FROM pedido 
             WHERE corretor = $1
             ORDER BY id
             LIMIT $2 OFFSET $3`,
            [corretorId, limit, offset]
        );

        if (pedidosResult.rows.length === 0) {
            return res.status(200).json({ 
                success: true, 
                pedidos: [], 
                total: 0 
            });
        }

        // Conta o total de pedidos
        const totalResult = await pool.query(
            'SELECT COUNT(*) FROM pedido WHERE corretor = $1',
            [corretorId]
        );
        const total = parseInt(totalResult.rows[0].count);

        // Processar cada pedido para buscar informações relacionadas
        const pedidosEnriquecidos = await Promise.all(pedidosResult.rows.map(async (pedido) => {
            // Buscar dados dos imóveis
            let imoveis = [];
            if (pedido.imoveis_id && pedido.imoveis_id.length > 0) {
                const imoveisResult = await pool.query(
                    `SELECT i.*,
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
                     WHERE i.id = ANY($1)`,
                    [pedido.imoveis_id]
                );
                imoveis = imoveisResult.rows;
            }

            // Buscar dados dos leads/clientes
            let clientes = [];
            if (pedido.leads_id && pedido.leads_id.length > 0) {
                const clientesResult = await pool.query(
                    'SELECT * FROM clientes WHERE id = ANY($1)',
                    [pedido.leads_id]
                );
                clientes = clientesResult.rows;
            }

            // Retornar pedido com os dados enriquecidos
            return {
                ...pedido,
                imoveis: imoveis,
                clientes: clientes
            };
        }));

        res.json({
            success: true,
            pedidos: pedidosEnriquecidos,
            total: total
        });

    } catch (err) {
        console.error('Erro na rota /list-pedidos:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/pedidos/cancelar', async (req, res) => {
    try {
        const { pedidoId, refund } = req.body;

        if (!pedidoId) {
            return res.status(400).json({ error: 'ID do pedido é obrigatório' });
        }

        // Atualiza o pedido
        const query = `
            UPDATE pedido
            SET cancelado = true,
                pago = $1
            WHERE id = $2
            RETURNING *;
        `;
        const values = [refund ? false : true, pedidoId]; // Se refund = true, seta pago = false
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Pedido não encontrado' });
        }

        res.status(200).json({ message: 'Pedido cancelado com sucesso', pedido: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao cancelar pedido:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
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



// 📌 Rota para recuperar token e nome do corretor por email
app.post('/autenticacao/novasenha', async (req, res) => {
    const { email } = req.body; // Pegando o email do corpo da requisição

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: "Email é obrigatório e deve ser uma string." });
    }

    try {
        const result = await pool.query(
            "SELECT token, name FROM corretores WHERE email = $1",
            [email.trim().toLowerCase()] // Normaliza o email para evitar problemas com maiúsculas/minúsculas
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Corretor não encontrado com esse email." });
        }

        res.status(200).json(result.rows[0]); // Retorna apenas { token, name }
    } catch (error) {
        console.error("Erro ao buscar corretor por email:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});




// 📌 Rota para atualizar senha do corretor
app.post('/update-password', async (req, res) => {
    const { email, token, newPassword } = req.body;

    // Validação dos campos obrigatórios
    if (!email || !token || !newPassword) {
        return res.status(400).json({ error: "Email, token e nova senha são obrigatórios." });
    }

    try {
        // Etapa 1: Busca o corretor pelo email e verifica o token
        const result = await pool.query(
            "SELECT id, token FROM corretores WHERE email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Corretor não encontrado." });
        }

        const corretor = result.rows[0];

        // Etapa 2: Valida se o token enviado corresponde ao token do corretor
        if (token !== corretor.token) {
            return res.status(401).json({ error: "Token inválido." });
        }

        // Etapa 3: Gera um novo token
        const novoToken = gerarToken();

        // Etapa 4: Atualiza a senha e o token no banco
        const updateResult = await pool.query(
            "UPDATE corretores SET password = $1, token = $2 WHERE email = $3 RETURNING id, token",
            [newPassword, novoToken, email]
        );

        // Etapa 5: Retorna a resposta com o novo token
        res.status(200).json({
            id: updateResult.rows[0].id,
            token: updateResult.rows[0].token,
            message: "Senha atualizada com sucesso."
        });

    } catch (error) {
        console.error("Erro ao atualizar senha:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});








app.get('/corretores', async (req, res) => {
    try {
        const {
            page,                 // Paginação: página atual (opcional)
            limit,                // Paginação: itens por página (opcional)
            search,               // Busca por nome, email ou whatsapp
            sortBy = 'created_at', // Ordenação: created_at, name, etc
            sortOrder = 'DESC',   // Ordem: ASC ou DESC
            minPedidos,           // Filtro: mínimo de pedidos
            maxPedidos,           // Filtro: máximo de pedidos
            semImoveis,          // Filtro: corretores sem imóveis
            semClientes,         // Filtro: corretores sem clientes
            semPedidos           // Filtro: corretores sem pedidos
        } = req.query;

        // Constrói a query base
        let query = 'SELECT * FROM corretores';
        let conditions = [];
        let values = [];

        // 1. Busca por proximidade (nome, email ou whatsapp)
        if (search) {
            conditions.push(
                `(name ILIKE $${values.length + 1} OR 
                  email ILIKE $${values.length + 1} OR 
                  phone ILIKE $${values.length + 1})`
            );
            values.push(`%${search}%`);
        }

        // 2. Filtros por número de pedidos
        if (minPedidos || maxPedidos) {
            if (minPedidos) {
                conditions.push(`array_length(pedidos, 1) >= $${values.length + 1}`);
                values.push(parseInt(minPedidos));
            }
            if (maxPedidos) {
                conditions.push(`array_length(pedidos, 1) <= $${values.length + 1}`);
                values.push(parseInt(maxPedidos));
            }
        }

        // 3. Filtros de ausência
        if (semImoveis === 'true') {
            conditions.push(`(imoveis_comprados IS NULL OR array_length(imoveis_comprados, 1) = 0)`);
        }
        if (semClientes === 'true') {
            conditions.push(`(clientes IS NULL OR array_length(clientes, 1) = 0)`);
        }
        if (semPedidos === 'true') {
            conditions.push(`(pedidos IS NULL OR array_length(pedidos, 1) = 0)`);
        }

        // Junta as condições na query
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // 4. Validação e aplicação da ordenação
        const validSortFields = ['created_at', 'name', 'email', 'phone'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
        const validSortOrders = ['ASC', 'DESC'];
        const order = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

        // Conta total de registros
        const countQuery = `SELECT COUNT(*) FROM corretores${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}`;
        const countResult = await pool.query(countQuery, values);
        const totalItems = parseInt(countResult.rows[0].count);

        // Aplica ordenação
        query += ` ORDER BY ${sortField} ${order}`;

        // Aplica paginação apenas se page e limit forem fornecidos
        let paginationApplied = false;
        let totalPages = 1;
        if (page && limit) {
            const pageNum = parseInt(page) || 1;
            const limitNum = parseInt(limit) || 10;
            const offset = (pageNum - 1) * limitNum;
            totalPages = Math.ceil(totalItems / limitNum);
            query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
            values.push(limitNum, offset);
            paginationApplied = true;
        }

        // Executa a query principal
        const result = await pool.query(query, values);

        // Formata a resposta
        const response = {
            data: result.rows,
            pagination: paginationApplied ? {
                currentPage: parseInt(page) || 1,
                itemsPerPage: parseInt(limit) || 10,
                totalItems,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1
            } : undefined
        };

        res.status(200).json(response);

    } catch (error) {
        console.error('❌ Erro ao listar corretores:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});


// Listagem de pedidos para o dashboard
app.get('/pedidos', async (req, res) => {
    try {
        const {
            page = 1,              // Paginação: página atual
            limit = 10,            // Paginação: itens por página
            startDate,             // Filtro: data inicial (created_at)
            endDate,               // Filtro: data final (created_at)
            minValue,              // Filtro: valor mínimo (total_value)
            maxValue,              // Filtro: valor máximo (total_value)
            entregue,              // Filtro: entregue (true/false)
            pago,                  // Filtro: pago (true/false)
            comImoveis,            // Filtro: pedidos com imóveis
            comLeads,              // Filtro: pedidos com leads
            cancelado              // Filtro: cancelado (true/false) - NOVO
        } = req.query;

        // Calcula offset para paginação
        const offset = (page - 1) * limit;

        // Constrói a query base para pedidos
        let query = `
            SELECT p.*,
                   json_agg(i.*) FILTER (WHERE i.id IS NOT NULL) AS imoveis,
                   json_agg(c.*) FILTER (WHERE c.id IS NOT NULL) AS clientes
            FROM pedido p
            LEFT JOIN imoveis i ON i.id = ANY(p.imoveis_id)
            LEFT JOIN clientes c ON c.id = ANY(p.leads_id)
        `;
        let conditions = [];
        let values = [];
        let valueIndex = 1;

        // Filtro por intervalo de datas (created_at)
        if (startDate) {
            conditions.push(`p.created_at >= $${valueIndex}`);
            values.push(startDate);
            valueIndex++;
        }
        if (endDate) {
            conditions.push(`p.created_at <= $${valueIndex}`);
            values.push(endDate);
            valueIndex++;
        }

        // Filtro por intervalo de valores (total_value)
        if (minValue) {
            conditions.push(`p.total_value >= $${valueIndex}`);
            values.push(parseFloat(minValue));
            valueIndex++;
        }
        if (maxValue) {
            conditions.push(`p.total_value <= $${valueIndex}`);
            values.push(parseFloat(maxValue));
            valueIndex++;
        }

        // Filtro por entregue
        if (entregue === 'true') {
            conditions.push(`p.entregue = true`);
        } else if (entregue === 'false') {
            conditions.push(`p.entregue = false`);
        }

        // Filtro por pago
        if (pago === 'true') {
            conditions.push(`p.pago = true`);
        } else if (pago === 'false') {
            conditions.push(`p.pago = false`);
        }

        // Filtro por pedidos com imóveis
        if (comImoveis === 'true') {
            conditions.push(`p.imoveis_id IS NOT NULL AND array_length(p.imoveis_id, 1) > 0`);
        }

        // Filtro por pedidos com leads
        if (comLeads === 'true') {
            conditions.push(`p.leads_id IS NOT NULL AND array_length(p.leads_id, 1) > 0`);
        }

        // Filtro por cancelado - NOVO
        if (cancelado === 'true') {
            conditions.push(`p.cancelado = true`);
        } else if (cancelado === 'false') {
            conditions.push(`p.cancelado = false`);
        }

        // Junta as condições na query
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Agrupa os resultados por pedido para evitar duplicatas
        query += ' GROUP BY p.id';

        // Conta total de registros para paginação
        const countQuery = `
            SELECT COUNT(DISTINCT p.id)
            FROM pedido p
            ${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}
        `;
        const countResult = await pool.query(countQuery, values);
        const totalItems = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalItems / limit);

        // Adiciona ordenação e paginação
        query += `
            ORDER BY p.created_at DESC
            LIMIT $${valueIndex} OFFSET $${valueIndex + 1}
        `;
        values.push(limit, offset);

        // Executa a query principal
        const result = await pool.query(query, values);

        // Formata a resposta
        const response = {
            data: result.rows,
            pagination: {
                currentPage: parseInt(page),
                itemsPerPage: parseInt(limit),
                totalItems,
                totalPages,
                hasNext: parseInt(page) < totalPages,
                hasPrevious: parseInt(page) > 1
            }
        };

        res.status(200).json(response);

    } catch (error) {
        console.error('❌ Erro ao listar pedidos:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});



// Rota para buscar corretores por lista de IDs
app.post('/corretores/by-ids', async (req, res) => {
    try {
        const { corretorIds } = req.body;

        // Validação básica
        if (!corretorIds || !Array.isArray(corretorIds) || corretorIds.length === 0) {
            return res.status(400).json({ error: 'A lista de IDs de corretores é obrigatória e deve ser um array não vazio.' });
        }

        // Constrói a query
        const query = `
            SELECT id, name, email, phone, pedidos, imoveis_comprados, clientes, created_at
            FROM corretores
            WHERE id = ANY($1)
        `;
        const values = [corretorIds]; // Passa a lista de IDs como um array para o PostgreSQL

        // Executa a query
        const result = await pool.query(query, values);

        // Formata a resposta
        const response = {
            data: result.rows,
            total: result.rowCount
        };

        res.status(200).json(response);

    } catch (error) {
        console.error('❌ Erro ao buscar corretores por IDs:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
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





































app.post('/imoveis/novo', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        console.log('Dados recebidos do frontend (imóvel):', req.body);

        // Função auxiliar para converter e validar valores numéricos
        const parseNumeric = (value, fieldName, maxDigits, precision = 0, required = false) => {
            if (value === undefined || value === '' || value === null) {
                if (required) throw new Error(`Campo ${fieldName} é obrigatório`);
                return null;
            }
            const parsed = Number(value);
            if (isNaN(parsed)) throw new Error(`Valor inválido para ${fieldName}: ${value}`);
            const totalDigits = Math.floor(parsed).toString().length;
            if (totalDigits > maxDigits - precision) {
                throw new Error(`Valor de ${fieldName} excede o limite de ${maxDigits - precision} dígitos inteiros: ${value}`);
            }
            return parsed;
        };

        // Dados completos do imóvel, incluindo toggles
        const imovelData = {
            valor: parseNumeric(req.body.valor, 'Valor', 12, 2, true),
            banheiros: parseNumeric(req.body.banheiros, 'Banheiros', 10, 0, true),
            metros_quadrados: parseNumeric(req.body.metros_quadrados, 'Metros Quadrados', 10, 2, true),
            andar: parseNumeric(req.body.andar, 'Andar', 10),
            imovel_pronto: req.body.imovel_pronto !== undefined ? req.body.imovel_pronto : false,
            mobiliado: req.body.mobiliado !== undefined ? req.body.mobiliado : false,
            price_contato: parseNumeric(req.body.price_contato, 'Preço Contato', 10, 2) || 39.90,
            vagas_garagem: parseNumeric(req.body.vagas_garagem, 'Vagas Garagem', 10) || 0,
            cidade: parseNumeric(req.body.cidade, 'Cidade', 10),
            categoria: parseNumeric(req.body.categoria, 'Categoria', 10),
            quartos: parseNumeric(req.body.quartos, 'Quartos', 10, 0, true),
            texto_principal: req.body.texto_principal || '',
            whatsapp: req.body.whatsapp || '',
            tipo: req.body.tipo || '',
            endereco: req.body.endereco || '',
            descricao: req.body.descricao || '',
            nome_proprietario: req.body.nome_proprietario || '',
            descricao_negociacao: req.body.descricao_negociacao || '',
            estado: req.body.estado || null,
            enviarEmail: req.body.enviarEmail !== undefined ? req.body.enviarEmail : false,
            enviarWhatsapp: req.body.enviarWhatsapp !== undefined ? req.body.enviarWhatsapp : false
        };

        // Validação de campos obrigatórios
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
            .filter(([key]) => imovelData[key] === null || imovelData[key] === '' || imovelData[key] === undefined)
            .map(([, label]) => label);

        if (missingFields.length > 0) {
            throw new Error(`Campos obrigatórios faltando ou inválidos: ${missingFields.join(', ')}`);
        }

        // Query SQL para criar o imóvel
        const imovelQuery = `
            INSERT INTO imoveis (
                valor, banheiros, metros_quadrados, andar, imovel_pronto, mobiliado, price_contato, 
                vagas_garagem, cidade, categoria, quartos, texto_principal, whatsapp, tipo, endereco, 
                descricao, nome_proprietario, descricao_negociacao, estado
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            RETURNING id
        `;
        const imovelValues = [
            imovelData.valor, imovelData.banheiros, imovelData.metros_quadrados, imovelData.andar,
            imovelData.imovel_pronto, imovelData.mobiliado, imovelData.price_contato, imovelData.vagas_garagem,
            imovelData.cidade, imovelData.categoria, imovelData.quartos, imovelData.texto_principal,
            imovelData.whatsapp, imovelData.tipo, imovelData.endereco, imovelData.descricao,
            imovelData.nome_proprietario, imovelData.descricao_negociacao, imovelData.estado
        ];

        console.log('Valores enviados para o banco (imóvel):', imovelValues);

        const imovelResult = await client.query(imovelQuery, imovelValues);
        const imovelId = imovelResult.rows[0].id;

        // Criação do envio_em_massa apenas se enviarEmail ou enviarWhatsapp for true
        if (imovelData.enviarEmail || imovelData.enviarWhatsapp) {
            // Busca todos os corretores ativos
            const corretoresQuery = `
                SELECT id FROM corretores WHERE ativo = TRUE;
            `;
            const corretoresResult = await client.query(corretoresQuery);
            const corretoresIds = corretoresResult.rows.map(row => row.id);

            // Gera a data atual ajustada para o fuso horário local, no formato ISO
            const localDate = new Date();
            const timezoneOffset = localDate.getTimezoneOffset(); // Offset em minutos (ex.: -180 para UTC-3)
            const adjustedDate = new Date(localDate.getTime() - timezoneOffset * 60 * 1000);
            const isoScheduleDate = adjustedDate.toISOString();

            // Gera o HTML dinâmico para html_email
            const htmlEmail = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nova Conexão de Imóvel - Lead Itapema</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Poppins', 'Helvetica', Arial, sans-serif; background-color: #e9ecef; color: #333; }
        .container { max-width: 650px; margin: 30px auto; background-color: #ffffff; border-radius: 15px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15); }
        .header { background: linear-gradient(135deg, #1877f2, #00d4ff); padding: 40px 20px; text-align: center; position: relative; overflow: hidden; }
        .header::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle, rgba(255, 255, 255, 0.2), transparent); animation: pulse 8s infinite; }
        .header img { max-width: 220px; height: auto; position: relative; z-index: 1; }
        .content { padding: 40px; text-align: center; }
        .content h1 { font-size: 28px; font-weight: 700; color: #1877f2; margin: 0 0 20px; text-transform: uppercase; letter-spacing: 1px; }
        .content p { font-size: 16px; line-height: 1.6; margin: 0 0 25px; color: #555; }
        .lead-info { background: linear-gradient(135deg, #f0f2f5, #ffffff); padding: 20px; border-radius: 10px; margin-bottom: 30px; text-align: left; box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05); }
        .lead-info p { margin: 8px 0; font-size: 15px; }
        .lead-info strong { color: #1877f2; font-weight: 600; }
        .cta-button { display: inline-block; padding: 18px 40px; font-size: 18px; font-weight: 700; color: #fff; text-decoration: none; text-transform: uppercase; background: linear-gradient(135deg, #FFD700, #FF8C00); border-radius: 50px; box-shadow: 0 8px 25px rgba(255, 215, 0, 0.5); transition: all 0.3s ease; position: relative; overflow: hidden; }
        .cta-button::before { content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.2); transition: all 0.4s ease; }
        .cta-button:hover::before { left: 100%; }
        .cta-button:hover { transform: scale(1.05); box-shadow: 0 12px 35px rgba(255, 215, 0, 0.7); }
        .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 13px; color: #777; border-top: 1px solid #e9ecef; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.2); opacity: 0.2; } 100% { transform: scale(1); opacity: 0.5; } }
        @media (max-width: 600px) { .content { padding: 20px; } .cta-button { padding: 14px 30px; font-size: 16px; } .header { padding: 30px 15px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="https://cloud.meuleaditapema.com.br/uploads/3cbeb5c8-1937-40b0-8f03-765d7a5eba77.png" alt="Lead Itapema Logo">
        </div>
        <div class="content">
            <h1>🏡 Imóvel de Alto Padrão Disponível!</h1>
            <p>Uma nova conexão foi identificada! Este imóvel exclusivo está pronto para ser apresentado aos seus clientes mais exigentes.</p>
            <div class="lead-info">
                <p><strong>Detalhes:</strong> ${imovelData.tipo} com ${imovelData.quartos} quartos, ${imovelData.banheiros} banheiros e ${imovelData.vagas_garagem} vagas de garagem.</p>
                <p><strong>Negociação:</strong> ${imovelData.descricao_negociacao || 'Proprietário aberto a propostas compatíveis com o mercado.'}</p>
            </div>
            <p>Acesse agora para ver mais informações e conectar-se com essa oportunidade de venda única.</p>
            <a href="https://imovel.meuleaditapema.com.br/${imovelId}" class="cta-button">Ver Imóvel</a>
        </div>
        <div class="footer">
            <p>Lead Itapema - Onde grandes negócios começam. © 2025</p>
        </div>
    </div>
</body>
</html>
            `;

            // Query para criar o envio_em_massa
            const envioQuery = `
                INSERT INTO envio_em_massa (
                    corretores,
                    mensagem,
                    email,
                    whatsapp,
                    intervalo,
                    agendado,
                    titulo,
                    tipo_imovel,
                    html_email
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id;
            `;
            const envioValues = [
                corretoresIds,                          // Lista de IDs dos corretores ativos
                imovelData.texto_principal,            // Usado para WhatsApp
                imovelData.enviarEmail,                // Reflete o toggle enviarEmail
                imovelData.enviarWhatsapp,             // Reflete o toggle enviarWhatsapp
                5000,                                  // Intervalo padrão de 5000ms
                isoScheduleDate,                       // Data atual ajustada para ISO
                `Novo Imóvel Disponível - ${imovelData.texto_principal}`, // Título dinâmico
                true,                                  // Tipo_imovel sempre true
                htmlEmail                              // HTML dinâmico
            ];

            console.log('Valores enviados para envio_em_massa:', envioValues);
            const envioResult = await client.query(envioQuery, envioValues);
            const envioId = envioResult.rows[0].id;
            console.log(`Envio em massa criado com ID ${envioId}`);
        } else {
            console.log('Nenhum envio em massa criado, pois enviarEmail e enviarWhatsapp são false');
        }

        // Commit da transação
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

//rota de editar um imovel
app.put('/imoveis/:id', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const imovelId = req.params.id;
        console.log('ID do imóvel recebido:', imovelId);
        console.log('Dados recebidos do frontend para atualização:', req.body);

        // Busca os dados atuais do imóvel no banco
        const currentQuery = `
            SELECT * FROM imoveis WHERE id = $1
        `;
        const currentResult = await client.query(currentQuery, [imovelId]);
        if (currentResult.rows.length === 0) {
            throw new Error('Imóvel não encontrado');
        }
        const currentImovel = currentResult.rows[0];
        console.log('Dados atuais do imóvel no banco:', currentImovel);

        // Função auxiliar para converter valores numéricos
        const parseNumeric = (value, defaultValue, isNotNull = false) => {
            if (value === undefined) return defaultValue; // Mantém o valor atual se não enviado
            if (value === '' || value === null) {
                if (isNotNull) throw new Error(`Campo numérico não pode ser vazio`);
                return null; // Converte string vazia ou null em null, se permitido
            }
            const parsed = Number(value);
            if (isNaN(parsed)) throw new Error(`Valor inválido para campo numérico: ${value}`);
            return parsed;
        };

        // Define os valores a serem atualizados, mantendo os atuais se não enviados
        const imovelData = {
            valor: parseNumeric(req.body.valor, currentImovel.valor, true), // NOT NULL
            banheiros: parseNumeric(req.body.banheiros, currentImovel.banheiros, true), // NOT NULL
            metros_quadrados: parseNumeric(req.body.metros_quadrados, currentImovel.metros_quadrados, true), // NOT NULL
            andar: parseNumeric(req.body.andar, currentImovel.andar), // Permite NULL
            imovel_pronto: req.body.imovel_pronto !== undefined ? req.body.imovel_pronto : (currentImovel.imovel_pronto ?? false), // Assume false se não existir ainda
            mobiliado: req.body.mobiliado !== undefined ? req.body.mobiliado : currentImovel.mobiliado,
            price_contato: parseNumeric(req.body.price_contato, currentImovel.price_contato), // Permite NULL
            vagas_garagem: parseNumeric(req.body.vagas_garagem, currentImovel.vagas_garagem), // Permite NULL
            cidade: parseNumeric(req.body.cidade, currentImovel.cidade), // Permite NULL
            categoria: parseNumeric(req.body.categoria, currentImovel.categoria), // Permite NULL
            quartos: parseNumeric(req.body.quartos, currentImovel.quartos || 0, true), // Assume NOT NULL baseado no código
            texto_principal: req.body.texto_principal !== undefined ? req.body.texto_principal : currentImovel.texto_principal,
            whatsapp: req.body.whatsapp !== undefined ? req.body.whatsapp : currentImovel.whatsapp,
            tipo: req.body.tipo !== undefined ? req.body.tipo : currentImovel.tipo || '',
            endereco: req.body.endereco !== undefined ? req.body.endereco : currentImovel.endereco,
            descricao: req.body.descricao !== undefined ? req.body.descricao : currentImovel.descricao,
            nome_proprietario: req.body.nome_proprietario !== undefined ? req.body.nome_proprietario : currentImovel.nome_proprietario,
            descricao_negociacao: req.body.descricao_negociacao !== undefined ? req.body.descricao_negociacao : currentImovel.descricao_negociacao,
            estado: req.body.estado !== undefined ? req.body.estado : currentImovel.estado // Mantém o valor atual se não enviado
        };

        // Log dos valores que serão salvos no banco
        console.log('Valores a serem salvos no banco:', imovelData);

        // Validação de campos obrigatórios
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
            .filter(([key]) => req.body[key] !== undefined && (imovelData[key] === null || imovelData[key] === ''))
            .map(([, label]) => label);

        if (missingFields.length > 0) {
            throw new Error(`Campos obrigatórios faltando ou inválidos: ${missingFields.join(', ')}`);
        }

        const updateQuery = `
            UPDATE imoveis
            SET 
                valor = $1, 
                banheiros = $2, 
                metros_quadrados = $3, 
                andar = $4, 
                imovel_pronto = $5, 
                mobiliado = $6, 
                price_contato = $7, 
                vagas_garagem = $8, 
                cidade = $9, 
                categoria = $10, 
                quartos = $11, 
                texto_principal = $12, 
                whatsapp = $13, 
                tipo = $14, 
                endereco = $15, 
                descricao = $16, 
                nome_proprietario = $17, 
                descricao_negociacao = $18,
                estado = $19
            WHERE id = $20
            RETURNING id, imovel_pronto, mobiliado
        `;
        const values = [
            imovelData.valor, imovelData.banheiros, imovelData.metros_quadrados, imovelData.andar,
            imovelData.imovel_pronto, imovelData.mobiliado, imovelData.price_contato, imovelData.vagas_garagem,
            imovelData.cidade, imovelData.categoria, imovelData.quartos, imovelData.texto_principal,
            imovelData.whatsapp, imovelData.tipo, imovelData.endereco, imovelData.descricao,
            imovelData.nome_proprietario, imovelData.descricao_negociacao, imovelData.estado, imovelId
        ];

        console.log('Query de atualização:', updateQuery);
        console.log('Valores enviados para o banco:', values);

        const result = await client.query(updateQuery, values);

        if (result.rows.length === 0) {
            throw new Error('Imóvel não encontrado');
        }

        console.log('Resultado do banco após atualização:', result.rows[0]);

        await client.query('COMMIT');
        res.json({ 
            success: true, 
            message: 'Imóvel atualizado com sucesso', 
            imovelId,
            imovel_pronto: result.rows[0].imovel_pronto,
            mobiliado: result.rows[0].mobiliado
        });
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

        // Enviar notificação ao n8n
        const n8nUrl = process.env.n8n_novo_pedido;
        const pedidoData = {
            pedido_id: pedidoId,
            total_value: total_value,
            corretor_id: corretorId,
            cobranca_id: cobranca_id,
            invoice_url: invoiceUrl,
            imoveis_id: imoveis_id || [],
            leads_id: leads_id || [],
            criado_em: new Date().toISOString()
        };
        console.log("📤 Enviando notificação ao n8n:", pedidoData);

        try {
            await axios.post(n8nUrl, pedidoData, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ Notificação enviada ao n8n com sucesso para ${n8nUrl}`);
        } catch (n8nError) {
            console.error("❌ Erro ao enviar notificação ao n8n:", n8nError.message);
            if (n8nError.response) {
                console.error("   - Resposta do n8n:", n8nError.response.data);
            }
            // Não falha a requisição principal, apenas loga o erro
        }

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
                    c.valor,
                    c.titulo,
                    c.id
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
                    <title>${lead.titulo || lead.interesse || "Lead Imobiliário"}</title>
                    <meta name="description" content="${categoriaTexto} - ${lead.interesse || 'Sem interesse especificado'}">
                    <meta property="og:title" content="${lead.titulo || lead.interesse || "Lead Imobiliário"}">
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
                        /* Novo CSS do Checkout */
                        .checkout-overlay {
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0, 0, 0, 0.7);
                            backdrop-filter: blur(4px);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            z-index: 2000;
                            animation: fadeIn 0.3s ease;
                            overflow: hidden;
                        }
                        .checkout-modal {
                            background: #ffffff;
                            width: 100%;
                            max-width: 850px;
                            height: 85vh;
                            border-radius: 16px;
                            padding: 0;
                            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
                            display: flex;
                            flex-direction: column;
                            font-family: 'Inter', 'Segoe UI', 'Helvetica', 'Arial', sans-serif;
                            overflow: hidden;
                        }
                        @keyframes fadeIn {
                            from { opacity: 0; }
                            to { opacity: 1; }
                        }
                        .checkout-header {
                            position: relative;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            padding: 20px 30px;
                            margin-bottom: 25px;
                        }
                        .checkout-header h2 {
                            font-size: 26px;
                            font-weight: 600;
                            color: #1a1a1a;
                            letter-spacing: -0.5px;
                        }
                        .close-icon {
                            cursor: pointer;
                            font-size: 28px;
                            color: #888;
                            transition: color 0.2s ease;
                        }
                        .close-icon:hover {
                            color: #333;
                        }
                        .checkout-content {
                            flex-grow: 1;
                            overflow-y: auto;
                            padding: 0 30px;
                        }
                        .lead-info {
                            margin-bottom: 30px;
                            background: #f9fafb;
                            padding: 15px;
                            border-radius: 10px;
                            border: 1px solid #e5e7eb;
                        }
                        .lead-info div {
                            font-size: 16px;
                            color: #2d3748;
                            margin: 8px 0;
                            line-height: 1.5;
                        }
                        .similar-leads {
                            margin-bottom: 30px;
                        }
                        .similar-leads h3 {
                            font-size: 20px;
                            font-weight: 600;
                            color: #1a1a1a;
                            margin-bottom: 15px;
                        }
                        .similar-leads-container {
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                            gap: 15px;
                        }
                        .mini-lead-card {
                            padding: 15px;
                            background: #ffffff;
                            border-radius: 10px;
                            border: 1px solid #e5e7eb;
                            cursor: pointer;
                            transition: all 0.2s ease;
                            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.05);
                        }
                        .mini-lead-card:hover {
                            transform: translateY(-3px);
                            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
                        }
                        .mini-lead-card.selected {
                            background: #4f46e5;
                            color: #ffffff;
                            border-color: #4f46e5;
                        }
                        .mini-lead-card.medio-padrao .lead-badge {
                            background: #60a5fa;
                        }
                        .mini-lead-card.alto-padrao .lead-badge {
                            background: #f59e0b;
                        }
                        .mini-lead-card .lead-badge {
                            font-size: 12px;
                            padding: 5px 10px;
                            border-radius: 12px;
                            color: #fff;
                            margin-bottom: 10px;
                            font-weight: 500;
                            text-transform: uppercase;
                            display: inline-block;
                        }
                        .mini-lead-card .lead-sku,
                        .mini-lead-card .lead-interesse,
                        .mini-lead-card .lead-titulo {
                            font-size: 14px;
                            margin: 6px 0;
                            color: #4b5563;
                            overflow: hidden;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                        }
                        .mini-lead-card .lead-titulo {
                            font-weight: bold;
                        }
                        .mini-lead-card.selected .lead-sku,
                        .mini-lead-card.selected .lead-interesse,
                        .mini-lead-card.selected .lead-titulo {
                            color: #ffffff;
                        }
                        .checkout-footer {
                            border-top: 1px solid #e5e7eb;
                            padding: 20px 30px;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            background: #ffffff;
                        }
                        .total-price {
                            font-size: 20px;
                            font-weight: 600;
                            color: #1a1a1a;
                        }
                        .checkout-buttons {
                            display: flex;
                            gap: 15px;
                        }
                        .confirm-btn {
                            padding: 12px 24px;
                            background-color: #4f46e5;
                            color: #ffffff;
                            border: none;
                            border-radius: 8px;
                            font-size: 15px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.2s ease;
                        }
                        .confirm-btn:hover {
                            background-color: #4338ca;
                            transform: translateY(-2px);
                            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                        }
                        @media (max-width: 800px) {
                            .checkout-overlay {
                                background: rgba(0, 0, 0, 0.9);
                                align-items: flex-start;
                                margin: 0;
                                padding: 0;
                            }
                            .checkout-modal {
                                width: 100vw;
                                height: 100vh;
                                max-width: none;
                                max-height: none;
                                border-radius: 0;
                                padding: 0;
                                box-shadow: none;
                                z-index: 2500;
                                overflow: hidden;
                            }
                            .checkout-header {
                                position: sticky;
                                top: 0;
                                background: #ffffff;
                                z-index: 10;
                                padding: 15px 20px;
                                margin-bottom: 0;
                                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
                            }
                            .checkout-header h2 {
                                font-size: 24px;
                            }
                            .checkout-content {
                                padding: 20px;
                                max-height: calc(100vh - 120px);
                                overflow-y: auto;
                                overflow-x: hidden;
                            }
                            .similar-leads-container {
                                display: flex;
                                flex-wrap: nowrap;
                                overflow-x: auto;
                                gap: 12px;
                                padding-bottom: 10px;
                            }
                            .mini-lead-card {
                                min-width: 200px;
                                padding: 12px;
                            }
                            .mini-lead-card .lead-interesse,
                            .mini-lead-card .lead-titulo {
                                font-size: 13px;
                            }
                            .checkout-footer {
                                position: sticky;
                                bottom: 0;
                                background: #ffffff;
                                z-index: 10;
                                padding: 15px 20px;
                                box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.05);
                            }
                            .total-price {
                                font-size: 18px;
                            }
                            .confirm-btn {
                                padding: 10px 20px;
                                font-size: 14px;
                            }
                            .lead-info {
                                padding: 12px;
                            }
                        }
                        @media (max-width: 600px) {
                            .checkout-header h2 {
                                font-size: 22px;
                            }
                            .mini-lead-card {
                                min-width: 180px;
                            }
                            .mini-lead-card .lead-interesse,
                            .mini-lead-card .lead-titulo {
                                font-size: 12px;
                            }
                            .total-price {
                                font-size: 16px;
                            }
                            .confirm-btn {
                                padding: 8px 16px;
                                font-size: 13px;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="${logoUrl}" alt="Meu Lead Itapema" class="logo">
                        <h1>${lead.titulo || `Lead ${id}`}</h1>
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
                            const lead = ${JSON.stringify(lead)};
                            const overlay = document.createElement("div");
                            overlay.className = "checkout-overlay";
                            overlay.innerHTML = \`
                                <div class="checkout-modal">
                                    <div class="checkout-header">
                                        <h2>Confirmar Compra de Lead</h2>
                                        <i class="close-icon" onclick="this.closest('.checkout-overlay').remove()">✖</i>
                                    </div>
                                    <div class="checkout-content">
                                        <div class="lead-info">
                                            <div>SKU: \${lead.id || "N/A"}</div>
                                            <div>Título: \${lead.titulo || "Não especificado"}</div>
                                            <div>Interesse: \${lead.interesse || "Não especificado"}</div>
                                            <div>Valor do Lead: \${valorFormatado}</div>
                                        </div>
                                        <div class="similar-leads">
                                            <h3>Leads Semelhantes</h3>
                                            <div class="similar-leads-container" id="similar-leads-container"></div>
                                        </div>
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
                        }
                        async function carregarLeadsSemelhantes(leadId, padrao, valorFormatado) {
                            try {
                                const response = await fetch(\`https://backand.meuleaditapema.com.br/list-clientes?limit=10&categoria=\${padrao === "alto-padrao" ? 2 : 1}\`);
                                const data = await response.json();
                                const similarLeadsContainer = document.getElementById("similar-leads-container");
                                const selectedLeads = [leadId];
                                let totalPrice = parseFloat(valorFormatado.replace("R$", "").replace(".", "").replace(",", "."));
                                if (data.clientes && Array.isArray(data.clientes)) {
                                    const filteredLeads = data.clientes.filter(lead => String(lead.id) !== String(leadId));
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
                                            <div class="lead-titulo">\${lead.titulo || "Sem Título"}</div>
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
                                const pedidoData = {
                                    userId: userId,
                                    token: token,
                                    entregue: false,
                                    pago: false,
                                    imoveis_id: [],
                                    leads_id: selectedLeads
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

                                document.querySelector(".checkout-overlay").remove();

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






