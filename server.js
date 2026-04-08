import express from "express";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";

const { Pool } = pkg;

const app = express();

app.use(cors());
app.use(express.json());

const SECRET = "segredo";

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "saas",
  password: "Br@12062000",
  port: 5432
});

// TESTE
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

    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "Email já cadastrado" });
    }

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

    if (!user) {
      return res.status(400).json({ error: "Usuário não encontrado" });
    }

    const passwordMatch = await bcrypt.compare(senha, user.senha);

    if (!passwordMatch) {
      return res.status(400).json({ error: "Senha inválida" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});


// Middleware auth
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Token não enviado" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
}


// CRIAR APPOINTMENT (com token)
app.post("/appointments", authMiddleware, async (req, res) => {
  const { nome, telefone, data } = req.body;
  const user_id = req.user.id;

  try {
    const confirm_token = crypto.randomBytes(16).toString("hex");

    const result = await pool.query(
      "INSERT INTO appointments (user_id, nome, telefone, data, sent, status, confirm_token) VALUES ($1, $2, $3, $4, false, 'pending', $5) RETURNING *",
      [user_id, nome, telefone, data, confirm_token]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});


// LISTAR APPOINTMENTS
app.get("/appointments", authMiddleware, async (req, res) => {
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE user_id = $1",
      [user_id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});


// ================================
// ✅ CONFIRMAÇÃO COM TOKEN
// ================================
app.get("/confirm/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  console.log("CONFIRM ROUTE CHAMADA ID:", id);

  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE id = $1",
      [id]
    );

    const appt = result.rows[0];

    if (!appt) {
      return res.status(404).send("Agendamento não encontrado");
    }

    if (appt.confirm_token !== token) {
      return res.status(401).send("Token inválido");
    }

    await pool.query(
      "UPDATE appointments SET status = 'confirmed' WHERE id = $1",
      [id]
    );

    res.send("Presença confirmada ✅");

  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao confirmar");
  }
});


// ================================
// 📊 DASHBOARD STATS
// ================================
app.get("/stats", authMiddleware, async (req, res) => {
  const user_id = req.user.id;

  try {
    const total = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id = $1",
      [user_id]
    );

    const confirmed = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id = $1 AND status = 'confirmed'",
      [user_id]
    );

    const pending = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id = $1 AND status = 'pending'",
      [user_id]
    );

    res.json({
      total: total.rows[0].count,
      confirmed: confirmed.rows[0].count,
      pending: pending.rows[0].count
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});


// ================================
// 🔔 SCHEDULER AUTOMÁTICO
// ================================
async function sendWhatsApp(telefone, mensagem) {
  console.log(`📲 Enviando para ${telefone}: ${mensagem}`);
}

async function processAppointments() {
  try {
    const now = new Date();

    const result = await pool.query(
      "SELECT * FROM appointments WHERE sent = false"
    );

    for (const appt of result.rows) {
      const apptDate = new Date(appt.data);

      if (apptDate <= now) {
        await sendWhatsApp(
          appt.telefone,
          `Olá ${appt.nome}, lembrete do seu atendimento! Confirme aqui: http://localhost:3000/confirm/${appt.id}?token=${appt.confirm_token}`
        );

        await pool.query(
          "UPDATE appointments SET sent = true WHERE id = $1",
          [appt.id]
        );

        console.log("✅ Enviado:", appt.id);
      }
    }

  } catch (err) {
    console.error("Erro no scheduler:", err);
  }
}

setInterval(processAppointments, 60000);


// START SERVER
app.listen(3000, "0.0.0.0", () => {
  console.log("Servidor rodando em http://localhost:3000");
});