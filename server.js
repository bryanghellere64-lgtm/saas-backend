import express from "express";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import session from "express-session"; // Adicionado para suporte a login
import passport from "passport"; // Adicionado para suporte a login
import { Strategy as GoogleStrategy } from "passport-google-oauth20"; // Adicionado para suporte a login
import { google } from "googleapis"; // Adicionado para integração com Agenda
import "dotenv/config";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO DE SESSÃO E PASSPORT ---
app.use(session({ 
  secret: process.env.SESSION_SECRET || "nossoagendamento", 
  resave: false, 
  saveUninitialized: true 
}));

app.use(passport.initialize());
app.use(passport.session());

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

// --- ALTERAÇÃO 1: GARANTIR COLUNA EMAIL ---
const setupDatabase = async () => {
  try {
    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
  } catch (err) {
    console.error("Erro banco:", err);
  }
};
setupDatabase();

// Variável global simples para armazenar o token (em produção, salve no banco de dados)
let lastGoogleAccessToken = "";

// =========================
// 🔥 FUNÇÃO GOOGLE CALENDAR
// =========================

async function createGoogleCalendarEvent(userToken, appointment, guestEmail) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: userToken });

  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: `Agendamento: ${appointment.nome}`,
    description: "Agendamento criado via SaaS Agendamento Automático",
    start: {
      dateTime: new Date(appointment.data).toISOString(),
      timeZone: "America/Sao_Paulo",
    },
    end: {
      // Define o fim para 30 minutos após o início
      dateTime: new Date(new Date(appointment.data).getTime() + 30 * 60000).toISOString(),
      timeZone: "America/Sao_Paulo",
    },
    // Suporte ao e-mail do convidado
    attendees: guestEmail ? [{ email: guestEmail }] : [],
  };

  try {
    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      sendUpdates: "all", // Envia o convite por e-mail para o paciente
      sendNotifications: true, // ADICIONADO PARA FORÇAR O ENVIO EM APPS DE TESTE
    });
    console.log("✅ Evento criado na Google Agenda:", response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error("❌ Erro ao criar evento na agenda:", error);
  }
}

// =========================
// 🔥 CONFIGURAÇÃO OAUTH GOOGLE
// =========================

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "https://saas-backend-1i9q.onrender.com/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // CAPTURA O TOKEN PARA USAR NA AGENDA
      lastGoogleAccessToken = accessToken;

      const email = profile.emails[0].value;
      const nome = profile.displayName;
      
      let user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      
      if (user.rows.length === 0) {
        user = await pool.query(
          "INSERT INTO users (nome, email, senha) VALUES ($1, $2, $3) RETURNING *",
          [nome, email, 'google-auth-' + crypto.randomBytes(4).toString('hex')]
        );
      }
      
      return done(null, user.rows[0]);
    } catch (err) {
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// =========================
// 🔥 ROTAS DE LOGIN GOOGLE
// =========================

app.get("/auth/google", passport.authenticate("google", { 
  scope: ["profile", "email", "https://www.googleapis.com/auth/calendar.events"] 
}));

app.get("/auth/google/callback", 
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email }, 
      process.env.JWT_SECRET, 
      { expiresIn: "1d" }
    );
    // Retorna o token para o usuário (em produção, redirecione para seu frontend)
    res.json({ message: "Login via Google realizado!", token });
  }
);

app.get("/", (req, res) => {
  res.send("SaaS rodando 🚀");
});


// =========================
// 🔥 WEBHOOK WHATSAPP
// =========================

// Verificação
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "meu_token_123";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Query recebida:", req.query);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  } else {
    console.log("❌ Erro na verificação do webhook");
    return res.sendStatus(403);
  }
});

// 🔥 RECEBER E RESPONDER MENSAGEM (AJUSTADO PARA BOTÕES E RESPOSTA DE CONFIRMAÇÃO)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      
      const buttonText = message.button?.text || message.interactive?.button_reply?.title;
      const text = message.text?.body;

      console.log(`📩 Mensagem de ${from}: ${buttonText ? 'BOTÃO: ' + buttonText : 'TEXTO: ' + text}`);

      if (buttonText === "Sim, confirmar") {
          // Busca com flexibilidade para o número (com ou sem o prefixo 55)
          const result = await pool.query(
              "UPDATE appointments SET status='confirmed' WHERE (telefone=$1 OR telefone=SUBSTRING($1, 3)) AND status='pending' RETURNING *",
              [from]
          );
          
          const appt = result.rows[0];

          if (appt) {
            console.log(`✅ Agendamento de ${appt.nome} confirmado.`);

            if (lastGoogleAccessToken) {
              // 1. Cria o evento na agenda
              await createGoogleCalendarEvent(lastGoogleAccessToken, appt, appt.email);

              // 2. Envia a resposta de confirmação sugerida por você
              await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  messaging_product: "whatsapp",
                  to: from,
                  type: "text",
                  text: { 
                    body: "Perfeito! Seu horário está confirmado. Acabei de enviar um convite para o seu e-mail para você salvar no seu calendário! 🗓️✅" 
                  }
                })
              });
            } else {
              console.log("❌ Erro: Token do Google ausente.");
            }
          }

      } else if (buttonText === "Não, cancelar") {
          await pool.query(
              "UPDATE appointments SET status='cancelled' WHERE (telefone=$1 OR telefone=SUBSTRING($1, 3)) AND status='pending'",
              [from]
          );
          console.log(`❌ Agendamento de ${from} cancelado.`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(500);
  }
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
  const { nome, telefone, data, email } = req.body;
  const user_id = req.user.id;

  // --- ADICIONE ESTAS LINHAS AQUI (DEBUG) ---
  console.log("-----------------------------------------");
  console.log("🔍 DEBUG: Iniciando criação de agendamento");
  console.log("🔍 DEBUG: Token do Google presente?", !!lastGoogleAccessToken);
  console.log("🔍 DEBUG: E-mail do paciente:", email);
  // ------------------------------------------

  // TRAVA DE SEGURANÇA: Evita erro 23502 (Not Null Violation)
  if (!nome || !telefone || !data) {
    return res.status(400).json({ error: "Campos obrigatórios faltando: nome, telefone ou data." });
  }

  // --- MANTER O 9 PARA TESTE ---
  let telLimpo = telefone.replace(/\D/g, '');

  try {
    const confirm_token = crypto.randomBytes(16).toString("hex");

    const result = await pool.query(
      `INSERT INTO appointments 
      (user_id, nome, telefone, data, sent, status, confirm_token, email) 
      VALUES ($1,$2,$3,$4,false,'pending',$5,$6) 
      RETURNING *`,
      [user_id, nome, telLimpo, data, confirm_token, email]
    );

    const newAppointment = result.rows[0];

    res.json(newAppointment);
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

// EDITAR
app.put("/appointments/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { nome, telefone, data } = req.body;
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      `UPDATE appointments 
       SET nome=$1, telefone=$2, data=$3 
       WHERE id=$4 AND user_id=$5 
       RETURNING *`,
      [nome, telefone, data, id, user_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// EXCLUIR
app.delete("/appointments/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      "DELETE FROM appointments WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agendamento não encontrado" });
    }

    res.json({ message: "Agendamento excluído com sucesso" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// CONFIRMAR (Link de fallback)
app.get("/confirm/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE id = $1",
      [id]
    );

    const appt = result.rows[0];

    if (!appt) return res.status(404).send("Agendamento não encontrado");
    if (appt.confirm_token !== token)
      return res.status(401).send("Token inválido");

    await pool.query(
      "UPDATE appointments SET status='confirmed' WHERE id=$1",
      [id]
    );

    res.send("Presença confirmada ✅");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao confirmar");
  }
});

// CANCELAR (Link de fallback)
app.get("/cancel/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE id = $1",
      [id]
    );

    const appt = result.rows[0];

    if (!appt) return res.status(404).send("Agendamento não encontrado");
    if (appt.confirm_token !== token)
      return res.status(401).send("Token inválido");

    await pool.query(
      "UPDATE appointments SET status='cancelled' WHERE id=$1",
      [id]
    );

    res.send("Agendamento cancelado ❌");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao cancelar");
  }
});

// STATS
app.get("/stats", authMiddleware, async (req, res) => {
  const user_id = req.user.id;

  try {
    const total = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id=$1",
      [user_id]
    );

    const confirmed = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id=$1 AND status='confirmed'",
      [user_id]
    );

    const pending = await pool.query(
      "SELECT COUNT(*) FROM appointments WHERE user_id=$1 AND status='pending'",
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

// WHATSAPP
async function sendWhatsApp(telefone, appt) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: telefone,
          type: "template",
          template: {
            name: "agendamento", 
            language: { code: "en" }, 
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: appt.nome }, 
                  { type: "text", text: "Dentista João" },
                  { type: "text", text: new Date(appt.data).toLocaleString('pt-BR') }
                ]
              }
            ]
          }
        })
      }
    );

    const text = await response.text();
    console.log("Resposta WhatsApp:", text);

  } catch (err) {
    console.error("Erro ao enviar WhatsApp:", err);
  }
}

// 🔥 SCHEDULER DE TESTE (ENVIO IMEDIATO)
async function processAppointments() {
  try {
    const result = await pool.query(
      "SELECT * FROM appointments WHERE sent=false AND status='pending'"
    );

    for (const appt of result.rows) {
      console.log(`🚀 GATILHO DE TESTE: Disparando para ${appt.nome}`);
      await sendWhatsApp(appt.telefone, appt);

      await pool.query(
        "UPDATE appointments SET sent=true WHERE id=$1",
        [appt.id]
      );
    }
  } catch (err) {
    console.error("Erro no scheduler:", err);
  }
}

setInterval(processAppointments, 60000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});