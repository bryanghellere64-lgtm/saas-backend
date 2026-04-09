import express from "express";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fetch from "node-fetch";
import "dotenv/config";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
  ssl: process.env.DB_HOST?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

app.get("/", (req, res) => {
  res.send("SaaS rodando 🚀");
});

// REGISTER
app.post("/register", async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const exists = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (exists.rows.length > 0)
      return res.status(400).json({ error: "Email já cadastrado" });

    const hashedPassword = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      "INSERT INTO users (nome, email, senha) VALUES ($1, $2, $3) RETURNING *",
      [nome, email, hashedPassword]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// LOGIN
app.post("/login", async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];

    if (!user)
      return res.status(400).json({ error: "Usuário não encontrado" });

    const passwordMatch = await bcrypt.compare(senha, user.senha);

    if (!passwordMatch)
      return res.status(400).json({ error: "Senha inválida" });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// AUTH
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ error: "Token não enviado" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// CRIAR
app.post("/appointments", authMiddleware, async (req, res) => {
  const { nome, telefone, data } = req.body;
  const user_id = req.user.id;

  try {
    const confirm_token = crypto.randomBytes(16).toString("hex");

    const result = await pool.query(
      `INSERT INTO appointments 
      (user_id, nome, telefone, data, sent, status, confirm_token) 
      VALUES ($1,$2,$3,$4,false,'pending',$5) 
      RETURNING *`,
      [user_id, nome, telefone, data, confirm_token]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// LISTAR
app.get("/appointments", authMiddleware, async (req, res) => {
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE user_id = $1 ORDER BY data DESC",
      [user_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// WHATSAPP
async function sendWhatsApp(telefone, mensagem) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: telefone,
          type: "text",
          text: {
            body: mensagem
          }
        })
      }
    );

    const data = await response.json();
    console.log("WhatsApp enviado:", data);

  } catch (err) {
    console.error("Erro ao enviar WhatsApp:", err);
  }
}

// SCHEDULER
async function processAppointments() {
  try {
    const now = new Date();

    const result = await pool.query(
      "SELECT * FROM appointments WHERE sent=false"
    );

    for (const appt of result.rows) {
      const apptDate = new Date(appt.data);

      if (apptDate <= now) {
        await sendWhatsApp(
          appt.telefone,
`Olá ${appt.nome} 👋

Você confirma seu agendamento?

✅ Confirmar:
https://saas-backend-1i9q.onrender.com/confirm/${appt.id}?token=${appt.confirm_token}

❌ Cancelar:
https://saas-backend-1i9q.onrender.com/cancel/${appt.id}?token=${appt.confirm_token}`
        );

        await pool.query(
          "UPDATE appointments SET sent=true WHERE id=$1",
          [appt.id]
        );
      }
    }
  } catch (err) {
    console.error("Erro no scheduler:", err);
  }
}

setInterval(processAppointments, 60000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});