const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./database');

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const defaultOrigins = isProduction ? '' : 'http://localhost:5173,http://127.0.0.1:5173';
const allowedOrigins = (process.env.CORS_ORIGIN || defaultOrigins)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const jwtSecret = process.env.JWT_SECRET || (isProduction ? null : 'mentalize-dev-secret-change-me');
const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 8);

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET precisa estar configurado em produção.');
}

if (isProduction && !allowedOrigins.length) {
  throw new Error('CORS_ORIGIN precisa apontar para o domínio real do frontend em produção.');
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origem não permitida pelo CORS.'));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 600),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas requisições. Tente novamente em alguns minutos.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.' },
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

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
  return res.status(404).json({ message: `${entity} não encontrado.` });
}

// FIX: Gera um JWT retornado no corpo da resposta (Bearer token).
// O frontend armazena no localStorage e envia via Authorization: Bearer.
function createSessionToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user' },
    jwtSecret,
    { expiresIn: Math.floor(sessionMaxAgeMs / 1000) },
  );
}

// FIX: requireAuth agora aceita token via Authorization: Bearer header
// (padrão usado pelo frontend) além de cookie (compatibilidade futura).
async function requireAuth(req, res, next) {
  let token = null;

  // Tenta Authorization: Bearer primeiro (padrão do frontend)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fallback: cookie (para uso futuro com SSR/proxy)
  if (!token) {
    token = req.cookies?.['mentalize_session'];
  }

  if (!token) {
    return res.status(401).json({ message: 'Sessão inválida ou expirada.' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = await db.getUserById(payload.sub);

    if (!user) {
      return res.status(401).json({ message: 'Sessão inválida ou expirada.' });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: 'Sessão inválida ou expirada.' });
  }
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

  const entry = await db.getMoodEntryById(entryId);
  return Number(entry?.user_id) === Number(req.user.id);
}

function parsePagination(query) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

function sanitizeUserPayload(data, allowRole = false) {
  const payload = { ...data };
  if (!allowRole) delete payload.role;
  return payload;
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

// FIX: Retorna { token, user } no corpo para que o frontend possa armazenar o JWT.
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const user = await db.registerUser(req.body);
  const token = createSessionToken(user);
  res.status(201).json({ token, user });
}));

// FIX: Retorna { token, user } no corpo.
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const user = await db.authenticateUser(req.body.email, req.body.password);

  if (!user) {
    return res.status(401).json({ message: 'Email ou senha inválidos.' });
  }

  const token = createSessionToken(user);
  return res.json({ token, user });
}));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  // Com JWT stateless o logout é gerenciado pelo cliente descartando o token.
  res.status(204).send();
});

app.get('/api/users', requireAuth, asyncRoute(async (req, res) => {
  if (!isProfessional(req.user)) {
    return res.json([req.user]);
  }

  return res.json(await db.listUsers());
}));

app.post('/api/users', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const user = await db.createUser(sanitizeUserPayload(req.body));
  res.status(201).json(user);
}));

app.put('/api/users/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!canAccessUser(req, req.params.id)) {
    return res.status(403).json({ message: 'Você só pode alterar a própria conta.' });
  }

  const user = await db.updateUser(req.params.id, sanitizeUserPayload(req.body));
  if (!user) return notFound(res, 'Usuário');

  return res.json(user);
}));

app.delete('/api/users/:id', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const deleted = await db.deleteUser(req.params.id);
  if (!deleted) return notFound(res, 'Usuário');
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

// FIX: Retorna array diretamente (sem wrapper paginado) para compatibilidade com o frontend.
app.get('/api/mood-entries', requireAuth, asyncRoute(async (req, res) => {
  const userId = isProfessional(req.user) ? req.query.userId : req.user.id;
  const pagination = parsePagination(req.query);
  const entries = await db.listMoodEntries(userId, pagination);
  res.json(entries);
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

// ===== PROFESSIONAL-PATIENT RELATIONSHIPS =====

app.post('/api/professionals/:professionalId/patients/:userId', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const relationship = await db.addProfessionalPatientRelationship(
    req.params.professionalId,
    req.params.userId,
    req.body.notes || null,
  );
  res.status(201).json(relationship);
}));

app.get('/api/professionals/:professionalId/patients', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const patients = await db.listPatientsByProfessional(req.params.professionalId, req.query.status);
  res.json(patients);
}));

app.get('/api/users/:userId/professionals', requireAuth, asyncRoute(async (req, res) => {
  if (!canAccessUser(req, req.params.userId)) {
    return res.status(403).json({ message: 'Você não pode acessar informações de outro usuário.' });
  }

  const professionals = await db.getProfessionalsByPatient(req.params.userId);
  res.json(professionals);
}));

app.put('/api/relationships/:relationshipId/status', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const updated = await db.updateRelationshipStatus(req.params.relationshipId, req.body.status);
  if (!updated) return notFound(res, 'Relacionamento');
  res.json(updated);
}));

app.delete('/api/relationships/:relationshipId', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const deleted = await db.removeProfessionalPatientRelationship(req.params.relationshipId);
  if (!deleted) return notFound(res, 'Relacionamento');
  res.status(204).send();
}));

// ===== MOOD ENTRIES REVIEWS =====

app.put('/api/mood-entries/:entryId/review', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const entry = await db.getMoodEntryById(req.params.entryId);
  if (!entry) return notFound(res, 'Registro emocional');

  // Verifica se o profissional tem relação com o paciente
  const patients = await db.listPatientsByProfessional(req.user.id, 'active');
  const hasAccess = patients.some((p) => Number(p.user_id) === Number(entry.user_id));

  if (!hasAccess) {
    return res.status(403).json({ message: 'Você só pode revisar registros de seus pacientes.' });
  }

  const reviewed = await db.reviewMoodEntry(
    req.params.entryId,
    req.user.id,
    req.body.professional_notes || null,
  );
  res.json(reviewed);
}));

app.get('/api/professionals/:professionalId/reviewed-entries', requireAuth, requireProfessional, asyncRoute(async (req, res) => {
  const entries = await db.getReviewedEntriesByProfessional(req.params.professionalId);
  res.json(entries);
}));

app.use((req, res) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
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
    if (error && error.code === 'ENOTFOUND') {
      console.error(
        'Erro ENOTFOUND: o hostname do `DATABASE_URL` nao foi resolvido (DNS). ' +
        'Tente copiar novamente a connection string do Supabase (preferindo "Transaction pooler"), ' +
        'e verifique se sua rede/DNS (VPN, firewall corporativo) permite acesso aos endpoints do Supabase.'
      );
    }
    process.exit(1);
  });
