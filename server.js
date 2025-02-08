const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const app = express();
const port = 3002;

const pool = new Pool({
  connectionString: "postgres://postgres:postgres123@95.217.182.223:2223/pedeprodatabase",
});

app.use(cors());
app.use(express.static("public"));

// Retorna todas as tabelas do banco de dados
app.get("/tables", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retorna as colunas de uma tabela específica
app.get("/columns/:table", async (req, res) => {
  const { table } = req.params;
  try {
    const result = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [table]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retorna os primeiros 100 registros de uma tabela específica
app.get("/data/:table", async (req, res) => {
  const { table } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM ${table} LIMIT 100`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});