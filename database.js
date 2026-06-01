const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const pool = hasDatabaseUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    })
  : null;

const memory = {
  users: [
    {
      id: 1,
      name: 'Usuario Demo',
      preferred_name: 'Demo',
      email: 'demo@mentalize.local',
      password: '',
      role: 'user',
      created_at: new Date().toISOString(),
    },
  ],
  professionals: [
    {
      id: 1,
      name: 'Dra. Clara Moreira',
      email: 'clara@mentalize.local',
      crp: '06/123456',
      specialty: 'Terapia cognitivo-comportamental',
      verified: true,
      created_at: new Date().toISOString(),
    },
  ],
  moodEntries: [
    {
      id: 1,
      user_id: 1,
      emotion: 'Ansiedade',
      intensity: 6,
      context: 'Rotina de trabalho',
      triggers: ['prazos', 'sono irregular'],
      notes: 'Respiracao guiada ajudou no fim do dia.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
};

const counters = {
  users: 2,
  professionals: 2,
  moodEntries: 2,
};

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL nao configurada. Usando armazenamento em memoria.');
  }

  return pool.query(sql, params);
}

async function initDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL nao encontrada. API rodando em modo demo sem persistencia.');
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      preferred_name VARCHAR(120),
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) DEFAULT '',
      role VARCHAR(24) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(120);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(24) DEFAULT 'user';
    ALTER TABLE users ALTER COLUMN password SET DEFAULT '';
    ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS professionals (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      crp VARCHAR(32) UNIQUE NOT NULL,
      specialty VARCHAR(255),
      verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mood_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emotion VARCHAR(80) NOT NULL,
      intensity INTEGER NOT NULL CHECK (intensity BETWEEN 1 AND 10),
      context TEXT,
      triggers TEXT[] DEFAULT '{}',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function normalizeUser(row) {
  if (!row) return null;
  const { password, ...safeUser } = row;
  return { ...safeUser, role: safeUser.role || 'user' };
}

function parseTriggers(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }

  if (!value) return [];

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateCrp(crp) {
  return /^\d{2}\/?\d{4,6}$/.test(String(crp || '').trim());
}

function makeRecommendation(entries) {
  if (!entries.length) {
    return {
      title: 'Primeiro registro',
      summary: 'Comece com um check-in emocional breve para liberar analises personalizadas.',
      actions: ['Registrar humor de hoje', 'Adicionar contexto do momento', 'Revisar recomendacoes depois de tres registros'],
    };
  }

  const recent = entries.slice(0, 7);
  const average = recent.reduce((sum, entry) => sum + Number(entry.intensity), 0) / recent.length;
  const emotionCounts = recent.reduce((acc, entry) => {
    acc[entry.emotion] = (acc[entry.emotion] || 0) + 1;
    return acc;
  }, {});
  const mainEmotion = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0][0];

  if (average >= 7) {
    return {
      title: 'Intensidade elevada',
      summary: `${mainEmotion} apareceu com intensidade media ${average.toFixed(1)} nos registros recentes.`,
      actions: ['Agendar pausa guiada de 5 minutos', 'Compartilhar registros com profissional autorizado', 'Priorizar sono e reduzir estimulos antes de dormir'],
    };
  }

  if (average >= 4) {
    return {
      title: 'Oscilacao moderada',
      summary: `${mainEmotion} esta presente, mas ainda ha espaco para intervencoes simples.`,
      actions: ['Fazer exercicio de respiracao quadrada', 'Anotar gatilhos recorrentes', 'Planejar uma atividade restauradora curta'],
    };
  }

  return {
    title: 'Boa estabilidade',
    summary: `Os registros recentes mostram baixa intensidade media (${average.toFixed(1)}).`,
    actions: ['Manter rotina de check-in', 'Registrar habitos que ajudaram', 'Revisar padroes semanalmente'],
  };
}

async function listUsers() {
  if (!pool) return memory.users.map(normalizeUser);

  const result = await query(
    'SELECT id, name, preferred_name, email, role, created_at FROM users ORDER BY created_at DESC, id DESC',
  );
  return result.rows.map(normalizeUser);
}

async function createUser(data) {
  if (!data.name || !data.email) {
    const error = new Error('Nome e email sao obrigatorios.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const user = {
      id: counters.users++,
      name: data.name,
      preferred_name: data.preferred_name || null,
      email: data.email,
      password: data.password ? await bcrypt.hash(data.password, 10) : '',
      role: data.role === 'professional' ? 'professional' : 'user',
      created_at: new Date().toISOString(),
    };
    memory.users.unshift(user);
    return normalizeUser(user);
  }

  const password = data.password ? await bcrypt.hash(data.password, 10) : '';
  const result = await query(
    `INSERT INTO users (name, preferred_name, email, password, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, preferred_name, email, role, created_at`,
    [data.name, data.preferred_name || null, data.email, password, data.role === 'professional' ? 'professional' : 'user'],
  );
  return normalizeUser(result.rows[0]);
}

async function updateUser(id, data) {
  if (!pool) {
    const index = memory.users.findIndex((user) => user.id === Number(id));
    if (index === -1) return null;
    memory.users[index] = {
      ...memory.users[index],
      name: data.name ?? memory.users[index].name,
      preferred_name: data.preferred_name ?? memory.users[index].preferred_name,
      email: data.email ?? memory.users[index].email,
    };
    return normalizeUser(memory.users[index]);
  }

  const result = await query(
    `UPDATE users
     SET name = COALESCE($1, name),
         preferred_name = COALESCE($2, preferred_name),
         email = COALESCE($3, email)
     WHERE id = $4
     RETURNING id, name, preferred_name, email, role, created_at`,
    [data.name || null, data.preferred_name || null, data.email || null, id],
  );
  return normalizeUser(result.rows[0]);
}

async function findUserByEmail(email) {
  if (!email) return null;

  if (!pool) {
    return memory.users.find((user) => user.email.toLowerCase() === String(email).toLowerCase()) || null;
  }

  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  return result.rows[0] || null;
}

async function authenticateUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.password) return null;

  const matches = await bcrypt.compare(password || '', user.password);
  return matches ? normalizeUser(user) : null;
}

async function registerUser(data) {
  if (!data.password || String(data.password).length < 6) {
    const error = new Error('A senha precisa ter pelo menos 6 caracteres.');
    error.status = 400;
    throw error;
  }

  if (data.role === 'professional' && !validateCrp(data.crp)) {
    const error = new Error('CRP invalido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  const existing = await findUserByEmail(data.email);
  if (existing) {
    const error = new Error('Este email ja esta cadastrado.');
    error.status = 409;
    throw error;
  }

  const user = await createUser(data);

  if (data.role === 'professional') {
    await createProfessional({
      name: data.name,
      email: data.email,
      crp: data.crp,
      specialty: data.specialty,
    });
  }

  return user;
}

async function deleteUser(id) {
  if (!pool) {
    const index = memory.users.findIndex((user) => user.id === Number(id));
    if (index === -1) return false;
    memory.users.splice(index, 1);
    memory.moodEntries = memory.moodEntries.filter((entry) => entry.user_id !== Number(id));
    return true;
  }

  const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function listProfessionals() {
  if (!pool) return memory.professionals;

  const result = await query(
    'SELECT id, name, email, crp, specialty, verified, created_at FROM professionals ORDER BY created_at DESC, id DESC',
  );
  return result.rows;
}

async function createProfessional(data) {
  if (!data.name || !data.email || !data.crp) {
    const error = new Error('Nome, email e CRP sao obrigatorios.');
    error.status = 400;
    throw error;
  }

  if (!validateCrp(data.crp)) {
    const error = new Error('CRP invalido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const professional = {
      id: counters.professionals++,
      name: data.name,
      email: data.email,
      crp: data.crp,
      specialty: data.specialty || null,
      verified: true,
      created_at: new Date().toISOString(),
    };
    memory.professionals.unshift(professional);
    return professional;
  }

  const result = await query(
    `INSERT INTO professionals (name, email, crp, specialty, verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, crp, specialty, verified, created_at`,
    [data.name, data.email, data.crp, data.specialty || null, true],
  );
  return result.rows[0];
}

async function updateProfessional(id, data) {
  if (data.crp && !validateCrp(data.crp)) {
    const error = new Error('CRP invalido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const index = memory.professionals.findIndex((professional) => professional.id === Number(id));
    if (index === -1) return null;
    memory.professionals[index] = {
      ...memory.professionals[index],
      name: data.name ?? memory.professionals[index].name,
      email: data.email ?? memory.professionals[index].email,
      crp: data.crp ?? memory.professionals[index].crp,
      specialty: data.specialty ?? memory.professionals[index].specialty,
      verified: data.crp ? true : memory.professionals[index].verified,
    };
    return memory.professionals[index];
  }

  const result = await query(
    `UPDATE professionals
     SET name = COALESCE($1, name),
         email = COALESCE($2, email),
         crp = COALESCE($3, crp),
         specialty = COALESCE($4, specialty),
         verified = COALESCE($5, verified)
     WHERE id = $6
     RETURNING id, name, email, crp, specialty, verified, created_at`,
    [data.name || null, data.email || null, data.crp || null, data.specialty || null, data.crp ? true : null, id],
  );
  return result.rows[0];
}

async function deleteProfessional(id) {
  if (!pool) {
    const index = memory.professionals.findIndex((professional) => professional.id === Number(id));
    if (index === -1) return false;
    memory.professionals.splice(index, 1);
    return true;
  }

  const result = await query('DELETE FROM professionals WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function listMoodEntries(userId) {
  if (!pool) {
    return memory.moodEntries
      .filter((entry) => !userId || entry.user_id === Number(userId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const params = [];
  let where = '';
  if (userId) {
    params.push(userId);
    where = 'WHERE user_id = $1';
  }

  const result = await query(
    `SELECT id, user_id, emotion, intensity, context, triggers, notes, created_at, updated_at
     FROM mood_entries
     ${where}
     ORDER BY created_at DESC, id DESC`,
    params,
  );
  return result.rows;
}

async function createMoodEntry(data) {
  if (!data.user_id || !data.emotion || !data.intensity) {
    const error = new Error('Usuario, emocao e intensidade sao obrigatorios.');
    error.status = 400;
    throw error;
  }

  const intensity = Number(data.intensity);
  if (intensity < 1 || intensity > 10) {
    const error = new Error('A intensidade precisa ficar entre 1 e 10.');
    error.status = 400;
    throw error;
  }

  const entry = {
    user_id: Number(data.user_id),
    emotion: data.emotion,
    intensity,
    context: data.context || null,
    triggers: parseTriggers(data.triggers),
    notes: data.notes || null,
  };

  if (!pool) {
    const now = new Date().toISOString();
    const created = { id: counters.moodEntries++, ...entry, created_at: now, updated_at: now };
    memory.moodEntries.unshift(created);
    return created;
  }

  const result = await query(
    `INSERT INTO mood_entries (user_id, emotion, intensity, context, triggers, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, emotion, intensity, context, triggers, notes, created_at, updated_at`,
    [entry.user_id, entry.emotion, entry.intensity, entry.context, entry.triggers, entry.notes],
  );
  return result.rows[0];
}

async function updateMoodEntry(id, data) {
  if (data.intensity && (Number(data.intensity) < 1 || Number(data.intensity) > 10)) {
    const error = new Error('A intensidade precisa ficar entre 1 e 10.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const index = memory.moodEntries.findIndex((entry) => entry.id === Number(id));
    if (index === -1) return null;
    memory.moodEntries[index] = {
      ...memory.moodEntries[index],
      user_id: data.user_id ? Number(data.user_id) : memory.moodEntries[index].user_id,
      emotion: data.emotion ?? memory.moodEntries[index].emotion,
      intensity: data.intensity ? Number(data.intensity) : memory.moodEntries[index].intensity,
      context: data.context ?? memory.moodEntries[index].context,
      triggers: data.triggers !== undefined ? parseTriggers(data.triggers) : memory.moodEntries[index].triggers,
      notes: data.notes ?? memory.moodEntries[index].notes,
      updated_at: new Date().toISOString(),
    };
    return memory.moodEntries[index];
  }

  const result = await query(
    `UPDATE mood_entries
     SET user_id = COALESCE($1, user_id),
         emotion = COALESCE($2, emotion),
         intensity = COALESCE($3, intensity),
         context = COALESCE($4, context),
         triggers = COALESCE($5, triggers),
         notes = COALESCE($6, notes),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
     RETURNING id, user_id, emotion, intensity, context, triggers, notes, created_at, updated_at`,
    [
      data.user_id || null,
      data.emotion || null,
      data.intensity ? Number(data.intensity) : null,
      data.context || null,
      data.triggers !== undefined ? parseTriggers(data.triggers) : null,
      data.notes || null,
      id,
    ],
  );
  return result.rows[0];
}

async function deleteMoodEntry(id) {
  if (!pool) {
    const index = memory.moodEntries.findIndex((entry) => entry.id === Number(id));
    if (index === -1) return false;
    memory.moodEntries.splice(index, 1);
    return true;
  }

  const result = await query('DELETE FROM mood_entries WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function getSummary(userId) {
  const entries = await listMoodEntries(userId);
  const average = entries.length
    ? entries.reduce((sum, entry) => sum + Number(entry.intensity), 0) / entries.length
    : 0;
  const highIntensity = entries.filter((entry) => Number(entry.intensity) >= 7).length;
  const contexts = entries.reduce((acc, entry) => {
    if (entry.context) acc[entry.context] = (acc[entry.context] || 0) + 1;
    return acc;
  }, {});

  return {
    total_entries: entries.length,
    average_intensity: Number(average.toFixed(1)),
    high_intensity_entries: highIntensity,
    main_context: Object.entries(contexts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    recommendation: makeRecommendation(entries),
  };
}

module.exports = {
  hasDatabaseUrl,
  initDatabase,
  authenticateUser,
  registerUser,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listProfessionals,
  createProfessional,
  updateProfessional,
  deleteProfessional,
  listMoodEntries,
  createMoodEntry,
  updateMoodEntry,
  deleteMoodEntry,
  getSummary,
};
