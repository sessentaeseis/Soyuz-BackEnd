const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./database');

const app = express();
const port = process.env.PORT || 3000;
const sessions = new Map();
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origem nao permitida pelo CORS.'));
    },
    credentials: true,
  }),
);

app.use(express.json());

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function notFound(res, entity = 'Registro') {
  return res.status(404).json({ message: `${entity} nao encontrado.` });
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    user,
    createdAt: Date.now(),
  });
  return token;
}

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  const session = token ? sessions.get(token) : null;

  if (!session) {
    return res.status(401).json({ message: 'Sessao invalida ou expirada.' });
  }

  req.user = session.user;
  req.token = token;
  return next();
}

function isProfessional(user) {
  return user?.role === 'professional';
}

function requireProfessional(req, res, next) {
  if (!isProfessional(req.user)) {
    return res.status(403).json({ message: 'Acesso restrito a profissionais cadastrados.' });
  }

  return next();
}

function canAccessUser(req, userId) {
  return isProfessional(req.user) || Number(req.user.id) === Number(userId);
}

async function canAccessMoodEntry(req, entryId) {
  if (isProfessional(req.user)) return true;

  const entries = await db.listMoodEntries(req.user.id);
  return entries.some((entry) => Number(entry.id) === Number(entryId));
}

app.get('/', (req, res) => {
  res.json({
    name: 'Mentalize API',
    slogan: 'Equilibre, Mentalize.',
    database: db.hasDatabaseUrl ? 'postgres-cloud' : 'memory-demo',
    endpoints: ['/api/auth/register', '/api/auth/login', '/api/users', '/api/professionals', '/api/mood-entries', '/api/summary'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', database: db.hasDatabaseUrl ? 'configured' : 'demo-memory' });
});

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const user = await db.registerUser(req.body);
  const token = createSession(user);
  res.status(201).json({ token, user });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const user = await db.authenticateUser(req.body.email, req.body.password);

  if (!user) {
    return res.status(401).json({ message: 'Email ou senha invalidos.' });
  }

  const token = createSession(user);
  return res.json({ token, user });
}));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.token);
  res.status(204).send();
});

app.get('/api/users', requireAuth, asyncRoute(async (req, res) => {
  if (!isProfessional(req.user)) {
    return res.json([req.user]);
  }

  return res.json(await db.listUsers());
}));

app.post('/api/users', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const user = await db.createUser(req.body);
  res.status(201).json(user);
}));

app.put('/api/users/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!canAccessUser(req, req.params.id)) {
    return res.status(403).json({ message: 'Voce so pode alterar a propria conta.' });
  }

  const user = await db.updateUser(req.params.id, req.body);
  if (!user) return notFound(res, 'Usuario');

  if (Number(req.user.id) === Number(user.id)) {
    req.user = user;
    sessions.set(req.token, { user, createdAt: Date.now() });
  }

  return res.json(user);
}));

app.delete('/api/users/:id', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const deleted = await db.deleteUser(req.params.id);
  if (!deleted) return notFound(res, 'Usuario');
  return res.status(204).send();
}));

app.get('/api/professionals', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  res.json(await db.listProfessionals());
}));

app.post('/api/professionals', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const professional = await db.createProfessional(req.body);
  res.status(201).json(professional);
}));

app.put('/api/professionals/:id', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const professional = await db.updateProfessional(req.params.id, req.body);
  if (!professional) return notFound(res, 'Profissional');
  return res.json(professional);
}));

app.delete('/api/professionals/:id', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const deleted = await db.deleteProfessional(req.params.id);
  if (!deleted) return notFound(res, 'Profissional');
  return res.status(204).send();
}));

app.get('/api/mood-entries', requireAuth, asyncRoute(async (req, res) => {
  const userId = isProfessional(req.user) ? req.query.userId : req.user.id;
  res.json(await db.listMoodEntries(userId));
}));

app.post('/api/mood-entries', requireAuth, asyncRoute(async (req, res) => {
  const body = isProfessional(req.user) ? req.body : { ...req.body, user_id: req.user.id };
  const entry = await db.createMoodEntry(body);
  res.status(201).json(entry);
}));

app.put('/api/mood-entries/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!(await canAccessMoodEntry(req, req.params.id))) {
    return notFound(res, 'Registro emocional');
  }

  const body = isProfessional(req.user) ? req.body : { ...req.body, user_id: req.user.id };
  const entry = await db.updateMoodEntry(req.params.id, body);
  if (!entry) return notFound(res, 'Registro emocional');
  return res.json(entry);
}));

app.delete('/api/mood-entries/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!(await canAccessMoodEntry(req, req.params.id))) {
    return notFound(res, 'Registro emocional');
  }

  const deleted = await db.deleteMoodEntry(req.params.id);
  if (!deleted) return notFound(res, 'Registro emocional');
  return res.status(204).send();
}));

app.get('/api/summary', requireAuth, asyncRoute(async (req, res) => {
  const userId = isProfessional(req.user) ? req.query.userId : req.user.id;
  res.json(await db.getSummary(userId));
}));

app.use((req, res) => {
  res.status(404).json({ message: 'Rota nao encontrada.' });
});

app.use((error, req, res, next) => {
  const status = error.status || 500;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    message: error.message || 'Erro interno no servidor.',
  });
});

db.initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Mentalize API rodando em http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao inicializar o banco de dados:', error);
    process.exit(1);
  });
