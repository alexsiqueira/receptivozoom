const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Em produção os segredos não podem vir de fallbacks hardcoded (conhecidos no repo).
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.DATABASE_URL)) {
  console.error('ERRO: JWT_SECRET e DATABASE_URL são obrigatórios em produção.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || process.env.jwt_secret || 'super_secret_jwt_token_trt12_zoom';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || process.env.google_client_id || '68734281789-7m9ak2vclsaoji4amn3da4p9826lsalp.apps.googleusercontent.com').trim();

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/zoom_db'
});

app.use(express.json());
app.use(cookieParser());

// Fallback seed data for meetings
const seedMeetings = [
  { unidade: 'Itajaí - 01a Vara', descricao: 'Sala de audiências', zoom_id: '4732411211' },
  { unidade: 'Itajaí - 02a Vara', descricao: 'Sala de audiências', zoom_id: '86234313077' },
  { unidade: 'Itajaí - 03a Vara', descricao: 'Sala de audiências', zoom_id: '4732411230' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiências entre 8h e 8h29min', zoom_id: '82827253075' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 8h30min', zoom_id: '4732411280' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 9h00min', zoom_id: '86126311393' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 9h30min', zoom_id: '89485341412' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 10h00min', zoom_id: '84062567431' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 10h30min', zoom_id: '81338106875' },
  { unidade: 'Navegantes - 01a Vara', descricao: 'Audiência das 11h00min', zoom_id: '82355134488' },
  { unidade: 'CEJUSC - Itajaí e Navegantes', descricao: 'Sala de Audiências', zoom_id: '4732411294' }
];

// Initialize Database (Auto-Migration & Seed)
async function initDb() {
  let retries = 5;
  while (retries) {
    try {
      console.log('Connecting to database...');
      await pool.query('SELECT NOW()');
      break;
    } catch (err) {
      console.error(`Database connection failed. Retries left: ${retries - 1}`, err.message);
      retries -= 1;
      if (retries === 0) {
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  try {
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id SERIAL PRIMARY KEY,
        unidade TEXT NOT NULL,
        descricao TEXT NOT NULL,
        zoom_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        unidade TEXT NOT NULL,
        audiencia TEXT NOT NULL,
        papel TEXT NOT NULL,
        nome TEXT,
        documento TEXT,
        oab TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    console.log('Database tables verified/created.');

    // Seed meetings data if empty
    const checkMeetings = await pool.query('SELECT COUNT(*) FROM meetings');
    if (parseInt(checkMeetings.rows[0].count, 10) === 0) {
      console.log('Seeding initial Zoom ID data...');
      for (const m of seedMeetings) {
        await pool.query(
          'INSERT INTO meetings (unidade, descricao, zoom_id) VALUES ($1, $2, $3)',
          [m.unidade, m.descricao, m.zoom_id]
        );
      }
      console.log('Seeding meetings complete.');
    }

    // Seed primary admins (idempotent: doesn't fail or duplicate on re-init)
    const seedAdmins = [
      'csi@trt12.jus.br',
      'alex.campos@trt12.jus.br',
      'alex.siqueira@trt12.jus.br',
      'alexsiqueira@trt12.jus.br',
      'alex@trt12.jus.br',
      '4220@trt12.jus.br'
    ];
    if (process.env.ADMIN_EMAIL) {
      seedAdmins.push(process.env.ADMIN_EMAIL.trim().toLowerCase());
    }
    for (const email of seedAdmins) {
      await pool.query(
        'INSERT INTO admins (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
        [email]
      );
    }
    console.log('Seeding admins complete.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Authentication Middleware
async function requireAdmin(req, res, next) {
  const token = req.cookies.token;
  const isApiRequest = req.originalUrl.includes('/api/') || req.path.startsWith('/api/');
  const loginUrl = '/audiencias/login.html';

  if (!token) {
    if (isApiRequest) {
      return res.status(401).json({ error: 'Acesso negado: faça login primeiro.' });
    }
    return res.redirect(loginUrl);
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if the user is still in the admin list
    const adminCheck = await pool.query('SELECT * FROM admins WHERE email = $1', [decoded.email]);
    if (adminCheck.rows.length === 0) {
      res.clearCookie('token', { path: '/' });
      if (isApiRequest) {
        return res.status(403).json({ error: 'Acesso negado: usuário não é mais administrador.' });
      }
      return res.redirect(`${loginUrl}?error=no_permission`);
    }

    req.user = decoded;
    next();
  } catch (err) {
    res.clearCookie('token', { path: '/' });
    if (isApiRequest) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
    return res.redirect(`${loginUrl}?error=session_expired`);
  }
}

// Router com todas as rotas da aplicação (suporta /audiencias e /)
const router = express.Router();

// ================= AUTH ENDPOINTS =================

// Public: Get auth config to see if Google login is enabled
router.get('/api/auth/config', (req, res) => {
  res.json({
    googleEnabled: !!GOOGLE_CLIENT_ID,
    googleClientId: GOOGLE_CLIENT_ID
  });
});

// Public: Authenticate via Google ID Token or Dev Fallback
router.post('/api/auth/login', async (req, res) => {
  const { idToken, devEmail } = req.body;
  let email = '';
  const currentClientId = GOOGLE_CLIENT_ID || '68734281789-7m9ak2vclsaoji4amn3da4p9826lsalp.apps.googleusercontent.com';

  try {
    if (idToken) {
      // Verify token authenticity via Google Web API
      const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
      const response = await fetch(verifyUrl);
      if (!response.ok) {
        const errText = await response.text();
        console.error('Falha na validação do token do Google:', response.status, errText);
        return res.status(400).json({ error: `Token do Google inválido ou expirado (${response.status}).` });
      }
      const payload = await response.json();

      if (payload.aud !== currentClientId) {
        console.error(`Audience mismatch: esperado ${currentClientId}, recebido ${payload.aud}`);
        return res.status(400).json({ error: 'Erro de integridade do Client ID do Google.' });
      }

      email = (payload.email || '').trim().toLowerCase();
    } else if (devEmail) {
      email = devEmail.trim().toLowerCase();
    } else {
      return res.status(400).json({ error: 'Token do Google ou e-mail é obrigatório.' });
    }

    // Domain validation: must end in @trt12.jus.br
    if (!email.endsWith('@trt12.jus.br')) {
      console.warn(`Tentativa de login com domínio inválido: ${email}`);
      return res.status(403).json({ error: `Acesso restrito: o e-mail ${email} não pertence ao domínio @trt12.jus.br.` });
    }

    // Check database authorization (case-insensitive)
    const adminCheck = await pool.query('SELECT * FROM admins WHERE LOWER(email) = LOWER($1)', [email]);
    if (adminCheck.rows.length === 0) {
      console.warn(`E-mail institucional não autorizado no banco: ${email}`);
      return res.status(403).json({ error: `O e-mail ${email} não está cadastrado como administrador no banco de dados.` });
    }

    // Create session JWT
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '2h' });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 2 * 60 * 60 * 1000 // 2 hours
    });

    console.log(`Login bem-sucedido para administrador: ${email}`);
    res.json({ success: true, email });
  } catch (err) {
    console.error('Erro no servidor durante a autenticação:', err);
    res.status(500).json({ error: `Erro no servidor durante a autenticação: ${err.message}` });
  }
});

// Public: Logout
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ success: true });
});

// Protected: Get current logged-in user profile
router.get('/api/auth/me', requireAdmin, (req, res) => {
  res.json({ email: req.user.email });
});


// ================= PUBLIC PORTAL APIs =================

// Diagnóstico de conexão e status do PostgreSQL
router.get('/api/db-status', async (req, res) => {
  try {
    const dbTest = await pool.query('SELECT NOW() as db_time');
    const meetingsCount = await pool.query('SELECT COUNT(*) FROM meetings');
    const meetingsList = await pool.query('SELECT id, unidade, descricao, zoom_id FROM meetings ORDER BY id ASC');
    const adminsCount = await pool.query('SELECT COUNT(*) FROM admins');
    const adminsList = await pool.query('SELECT id, email, created_at FROM admins ORDER BY id ASC');

    res.json({
      status: 'OK - Conectado ao PostgreSQL com sucesso',
      db_time: dbTest.rows[0].db_time,
      meetings_total: parseInt(meetingsCount.rows[0].count, 10),
      meetings: meetingsList.rows,
      admins_total: parseInt(adminsCount.rows[0].count, 10),
      admins: adminsList.rows.map(a => a.email),
      google_client_id_configured: !!GOOGLE_CLIENT_ID
    });
  } catch (err) {
    console.error('[DB-STATUS ERROR]', err);
    res.status(500).json({
      status: 'ERRO - Falha na conexão com o banco de dados PostgreSQL',
      error: err.message
    });
  }
});

router.get('/api/meetings', async (req, res) => {
  try {
    console.log('[API] GET /api/meetings requisitado');
    const result = await pool.query('SELECT id as db_id, unidade, descricao, zoom_id as id, zoom_id FROM meetings ORDER BY unidade ASC, descricao ASC, id ASC');
    console.log(`[API] GET /api/meetings retornou ${result.rows.length} registros`);
    res.json(result.rows);
  } catch (err) {
    console.error('[API ERROR] Falha ao consultar meetings no banco:', err);
    res.status(500).json({ error: 'Erro ao carregar dados do banco: ' + err.message });
  }
});

router.post('/api/access-logs', async (req, res) => {
  const { timestamp, unidade, audiencia, papel, nome, documento, oab } = req.body;
  try {
    await pool.query(
      `INSERT INTO access_logs (timestamp, unidade, audiencia, papel, nome, documento, oab) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        timestamp || new Date(),
        unidade || 'Desconhecida',
        audiencia || 'Desconhecida',
        papel || 'Desconhecido',
        nome || null,
        documento || null,
        oab || null
      ]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Error creating access log:', err);
    res.status(500).json({ error: 'Erro ao registrar acesso' });
  }
});


// ================= PROTECTED ADMIN APIs =================

// Admin Route to serve files (protect admin.html directly)
router.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Logs Endpoint
router.get('/api/access-logs', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT timestamp, unidade, audiencia, papel, nome, documento, oab FROM access_logs ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching access logs:', err);
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

// CRUD: List meetings
router.get('/api/admin/meetings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, unidade, descricao, zoom_id FROM meetings ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar reuniões' });
  }
});

// CRUD: Create meeting
router.post('/api/admin/meetings', requireAdmin, async (req, res) => {
  const { unidade, descricao, zoom_id } = req.body;
  if (!unidade || !descricao || !zoom_id) {
    return res.status(400).json({ error: 'Campos obrigatórios: unidade, descricao, zoom_id' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO meetings (unidade, descricao, zoom_id) VALUES ($1, $2, $3) RETURNING *',
      [unidade, descricao, zoom_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar reunião' });
  }
});

// CRUD: Update meeting
router.put('/api/admin/meetings/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { unidade, descricao, zoom_id } = req.body;
  if (!unidade || !descricao || !zoom_id) {
    return res.status(400).json({ error: 'Campos obrigatórios: unidade, descricao, zoom_id' });
  }
  try {
    const result = await pool.query(
      'UPDATE meetings SET unidade = $1, descricao = $2, zoom_id = $3 WHERE id = $4 RETURNING *',
      [unidade, descricao, zoom_id, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Reunião não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar reunião' });
  }
});

// CRUD: Delete meeting
router.delete('/api/admin/meetings/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Reunião não encontrada' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir reunião' });
  }
});

// ================= ADMIN USER MANAGEMENT APIs =================

// List admin users
router.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, created_at FROM admins ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar administradores.' });
  }
});

// Add admin user
router.post('/api/admin/users', requireAdmin, async (req, res) => {
  let { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'O campo e-mail é obrigatório.' });
  }
  email = email.trim().toLowerCase();

  // Validate institutional domain
  if (!email.endsWith('@trt12.jus.br')) {
    return res.status(400).json({ error: 'Domínio inválido: somente e-mails @trt12.jus.br são permitidos.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO admins (email) VALUES ($1) RETURNING id, email, created_at',
      [email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // Unique constraint error
      return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar administrador.' });
  }
});

// Remove admin user
router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Retrieve email to check safety restrictions
    const targetUser = await pool.query('SELECT email FROM admins WHERE id = $1', [id]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: 'Administrador não encontrado.' });
    }

    const targetEmail = targetUser.rows[0].email;

    // Protection 1: Cannot delete primary csi admin
    if (targetEmail === 'csi@trt12.jus.br') {
      return res.status(403).json({ error: 'Acesso negado: o administrador primário csi@trt12.jus.br não pode ser excluído.' });
    }

    // Protection 2: Cannot delete yourself
    if (targetEmail === req.user.email) {
      return res.status(403).json({ error: 'Acesso negado: você não pode remover a si mesmo da administração.' });
    }

    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir administrador.' });
  }
});

// Servir arquivos estáticos (HTML, CSS, JS, imagens) da pasta public em /audiencias e na raiz /
app.use('/audiencias', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Servir endpoints de APIs e autenticação em /audiencias e na raiz /
app.use('/audiencias', router);
app.use('/', router);

// Fallback de roteamento (SPA / páginas não encontradas)
app.get(['/audiencias/*', '*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (GOOGLE_CLIENT_ID) {
    console.log(`Google Sign-In ativo (Client ID: ${GOOGLE_CLIENT_ID.substring(0, 12)}...)`);
  } else {
    console.warn('AVISO: GOOGLE_CLIENT_ID não encontrado nas variáveis de ambiente.');
  }
  await initDb();
});
