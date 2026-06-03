const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
if (!hasDatabaseUrl) {
  // Sem DATABASE_URL não existe persistência no Supabase.
  // Mantemos o "modo demo" apenas como código legado, mas ele fica desativado por padrão.
  throw new Error('DATABASE_URL precisa estar configurada para usar o Supabase (modo demo desativado).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const memory = {
  users: [],
  professionals: [],
  moodEntries: [],
};

const counters = {
  users: 1,
  professionals: 1,
  moodEntries: 1,
};

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL não configurada. Usando armazenamento em memória.');
  }

  return pool.query(sql, params);
}

async function initDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL não encontrada. API rodando em modo demo sem persistência.');
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
      professional_notes TEXT,
      reviewed_by INTEGER REFERENCES professionals(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS professional_patient_relationships (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(24) DEFAULT 'active',
      assigned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      UNIQUE(professional_id, user_id)
    );

    ALTER TABLE mood_entries ADD COLUMN IF NOT EXISTS professional_notes TEXT;
    ALTER TABLE mood_entries ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES professionals(id) ON DELETE SET NULL;
    ALTER TABLE mood_entries ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
  `);
}

function normalizeUser(row) {
  if (!row) return null;
  const { password, ...safeUser } = row;
  return { ...safeUser, role: safeUser.role || 'user' };
}

function normalizeRole(role, { allowAdmin = true } = {}) {
  if (role === 'admin' && allowAdmin) return 'admin';
  if (role === 'professional') return 'professional';
  return 'user';
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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function validateCrp(crp) {
  return /^\d{2}\/?\d{4,6}$/.test(String(crp || '').trim());
}

function validateUserData(data, { requirePassword = false } = {}) {
  if (!String(data.name || '').trim() || !validateEmail(data.email)) {
    const error = new Error('Informe um nome e um email válido.');
    error.status = 400;
    throw error;
  }

  if (requirePassword && (!data.password || String(data.password).length < 6)) {
    const error = new Error('A senha precisa ter pelo menos 6 caracteres.');
    error.status = 400;
    throw error;
  }
}

function mapDbError(error) {
  if (error?.code === '23505') {
    const message = String(error.constraint || '').includes('crp')
      ? 'Este CRP já está cadastrado.'
      : 'Este email já está cadastrado.';
    const mapped = new Error(message);
    mapped.status = 409;
    return mapped;
  }

  return error;
}

async function runDb(operation) {
  try {
    return await operation();
  } catch (error) {
    throw mapDbError(error);
  }
}

function makeRecommendation(entries) {
  if (!entries.length) {
    return {
      title: 'Primeiro registro',
      summary: 'Comece com um check-in emocional breve para liberar análises personalizadas.',
      actions: ['Registrar humor de hoje', 'Adicionar contexto do momento', 'Revisar recomendações depois de três registros'],
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
      summary: `${mainEmotion} apareceu com intensidade média ${average.toFixed(1)} nos registros recentes.`,
      actions: ['Agendar pausa guiada de 5 minutos', 'Compartilhar registros com profissional autorizado', 'Priorizar sono e reduzir estímulos antes de dormir'],
    };
  }

  if (average >= 4) {
    return {
      title: 'Oscilação moderada',
      summary: `${mainEmotion} está presente, mas ainda há espaço para intervenções simples.`,
      actions: ['Fazer exercício de respiração quadrada', 'Anotar gatilhos recorrentes', 'Planejar uma atividade restauradora curta'],
    };
  }

  return {
    title: 'Boa estabilidade',
    summary: `Os registros recentes mostram baixa intensidade média (${average.toFixed(1)}).`,
    actions: ['Manter rotina de check-in', 'Registrar hábitos que ajudaram', 'Revisar padrões semanalmente'],
  };
}

async function getUserById(id) {
  if (!pool) {
    return normalizeUser(memory.users.find((user) => user.id === Number(id)));
  }

  const result = await query(
    'SELECT id, name, preferred_name, email, role, created_at FROM users WHERE id = $1 LIMIT 1',
    [id],
  );
  return normalizeUser(result.rows[0]);
}

async function listUsers() {
  if (!pool) return memory.users.map(normalizeUser);

  const result = await query(
    'SELECT id, name, preferred_name, email, role, created_at FROM users ORDER BY created_at DESC, id DESC',
  );
  return result.rows.map(normalizeUser);
}

async function createUser(data) {
  validateUserData(data);

  if (!pool) {
    const email = normalizeEmail(data.email);
    if (memory.users.some((user) => normalizeEmail(user.email) === email)) {
      const error = new Error('Este email já está cadastrado.');
      error.status = 409;
      throw error;
    }

    const user = {
      id: counters.users++,
      name: String(data.name).trim(),
      preferred_name: data.preferred_name || null,
      email,
      password: data.password ? await bcrypt.hash(data.password, 10) : '',
      role: normalizeRole(data.role),
      created_at: new Date().toISOString(),
    };
    memory.users.unshift(user);
    return normalizeUser(user);
  }

  const password = data.password ? await bcrypt.hash(data.password, 10) : '';
  const result = await runDb(() => query(
    `INSERT INTO users (name, preferred_name, email, password, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, preferred_name, email, role, created_at`,
    [String(data.name).trim(), data.preferred_name || null, normalizeEmail(data.email), password, normalizeRole(data.role)],
  ));
  return normalizeUser(result.rows[0]);
}

async function updateUser(id, data) {
  if (!pool) {
    const index = memory.users.findIndex((user) => user.id === Number(id));
    if (index === -1) return null;

    if (data.email && !validateEmail(data.email)) {
      const error = new Error('Informe um email válido.');
      error.status = 400;
      throw error;
    }

    memory.users[index] = {
      ...memory.users[index],
      name: data.name ?? memory.users[index].name,
      preferred_name: data.preferred_name ?? memory.users[index].preferred_name,
      email: data.email ? normalizeEmail(data.email) : memory.users[index].email,
      role: data.role ? normalizeRole(data.role) : memory.users[index].role,
    };
    return normalizeUser(memory.users[index]);
  }

  if (data.email && !validateEmail(data.email)) {
    const error = new Error('Informe um email válido.');
    error.status = 400;
    throw error;
  }

  const result = await runDb(() => query(
    `UPDATE users
     SET name = COALESCE($1, name),
         preferred_name = COALESCE($2, preferred_name),
         email = COALESCE($3, email),
         role = COALESCE($4, role)
     WHERE id = $5
     RETURNING id, name, preferred_name, email, role, created_at`,
    [data.name || null, data.preferred_name || null, data.email ? normalizeEmail(data.email) : null, data.role ? normalizeRole(data.role) : null, id],
  ));
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
  const publicData = { ...data, role: normalizeRole(data.role, { allowAdmin: false }) };

  validateUserData(publicData, { requirePassword: true });

  if (publicData.role === 'professional' && !validateCrp(publicData.crp)) {
    const error = new Error('CRP inválido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  const existing = await findUserByEmail(publicData.email);
  if (existing) {
    const error = new Error('Este email ja esta cadastrado.');
    error.status = 409;
    throw error;
  }

  const user = await createUser(publicData);

  if (publicData.role === 'professional') {
    await createProfessional({
      name: publicData.name,
      email: publicData.email,
      crp: publicData.crp,
      specialty: publicData.specialty,
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
    const error = new Error('Nome, email e CRP são obrigatórios.');
    error.status = 400;
    throw error;
  }

  if (!validateEmail(data.email)) {
    const error = new Error('Informe um email válido.');
    error.status = 400;
    throw error;
  }

  if (!validateCrp(data.crp)) {
    const error = new Error('CRP inválido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const email = normalizeEmail(data.email);
    if (memory.professionals.some((professional) => normalizeEmail(professional.email) === email)) {
      const error = new Error('Este email já está cadastrado.');
      error.status = 409;
      throw error;
    }

    if (memory.professionals.some((professional) => professional.crp === data.crp)) {
      const error = new Error('Este CRP já está cadastrado.');
      error.status = 409;
      throw error;
    }

    const professional = {
      id: counters.professionals++,
      name: String(data.name).trim(),
      email,
      crp: data.crp,
      specialty: data.specialty || null,
      verified: true,
      created_at: new Date().toISOString(),
    };
    memory.professionals.unshift(professional);
    return professional;
  }

  const result = await runDb(() => query(
    `INSERT INTO professionals (name, email, crp, specialty, verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, crp, specialty, verified, created_at`,
    [String(data.name).trim(), normalizeEmail(data.email), data.crp, data.specialty || null, true],
  ));
  return result.rows[0];
}

async function updateProfessional(id, data) {
  if (data.crp && !validateCrp(data.crp)) {
    const error = new Error('CRP inválido. Use o formato 06/123456 ou 06123456.');
    error.status = 400;
    throw error;
  }

  if (data.email && !validateEmail(data.email)) {
    const error = new Error('Informe um email válido.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const index = memory.professionals.findIndex((professional) => professional.id === Number(id));
    if (index === -1) return null;
    memory.professionals[index] = {
      ...memory.professionals[index],
      name: data.name ?? memory.professionals[index].name,
      email: data.email ? normalizeEmail(data.email) : memory.professionals[index].email,
      crp: data.crp ?? memory.professionals[index].crp,
      specialty: data.specialty ?? memory.professionals[index].specialty,
      verified: data.crp ? true : memory.professionals[index].verified,
    };
    return memory.professionals[index];
  }

  const result = await runDb(() => query(
    `UPDATE professionals
     SET name = COALESCE($1, name),
         email = COALESCE($2, email),
         crp = COALESCE($3, crp),
         specialty = COALESCE($4, specialty),
         verified = COALESCE($5, verified)
     WHERE id = $6
     RETURNING id, name, email, crp, specialty, verified, created_at`,
    [data.name || null, data.email ? normalizeEmail(data.email) : null, data.crp || null, data.specialty || null, data.crp ? true : null, id],
  ));
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

async function getMoodEntryById(id) {
  if (!pool) {
    return memory.moodEntries.find((entry) => entry.id === Number(id)) || null;
  }

  const result = await query(
    'SELECT id, user_id, emotion, intensity, context, triggers, notes, created_at, updated_at FROM mood_entries WHERE id = $1 LIMIT 1',
    [id],
  );
  return result.rows[0] || null;
}

async function listMoodEntries(userId, pagination = {}) {
  const limit = Math.min(Math.max(Number(pagination.limit) || 500, 1), 500);
  const offset = Math.max(Number(pagination.offset) || 0, 0);

  if (!pool) {
    return memory.moodEntries
      .filter((entry) => !userId || entry.user_id === Number(userId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit);
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
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return result.rows;
}

async function createMoodEntry(data) {
  if (!data.user_id || !data.emotion || !data.intensity) {
    const error = new Error('Usuário, emoção e intensidade são obrigatórios.');
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
      professional_notes: data.professional_notes ?? memory.moodEntries[index].professional_notes,
      reviewed_by: data.reviewed_by ? Number(data.reviewed_by) : memory.moodEntries[index].reviewed_by,
      reviewed_at: data.reviewed_by ? new Date().toISOString() : memory.moodEntries[index].reviewed_at,
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
         professional_notes = COALESCE($7, professional_notes),
         reviewed_by = COALESCE($8, reviewed_by),
         reviewed_at = COALESCE($9, reviewed_at),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $10
     RETURNING id, user_id, emotion, intensity, context, triggers, notes, professional_notes, reviewed_by, reviewed_at, created_at, updated_at`,
    [
      data.user_id || null,
      data.emotion || null,
      data.intensity ? Number(data.intensity) : null,
      data.context || null,
      data.triggers !== undefined ? parseTriggers(data.triggers) : null,
      data.notes || null,
      data.professional_notes || null,
      data.reviewed_by ? Number(data.reviewed_by) : null,
      data.reviewed_by ? new Date().toISOString() : null,
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

async function addProfessionalPatientRelationship(professionalId, userId, notes = null) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  if (!professionalId || !userId) {
    const error = new Error('ID do profissional e ID do usuário são obrigatórios.');
    error.status = 400;
    throw error;
  }

  try {
    const result = await query(
      `INSERT INTO professional_patient_relationships (professional_id, user_id, notes)
       VALUES ($1, $2, $3)
       RETURNING id, professional_id, user_id, status, assigned_date, notes`,
      [professionalId, userId, notes || null],
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code === '23505') {
      const err = new Error('Este relacionamento já existe.');
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

async function listPatientsByProfessional(professionalId, status = null) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  let where = 'WHERE professional_id = $1';
  const params = [professionalId];
  if (status) {
    where += ' AND status = $2';
    params.push(status);
  }

  const result = await query(
    `SELECT ppr.id, ppr.professional_id, ppr.user_id, ppr.status, ppr.assigned_date, ppr.notes,
            u.id as user_id, u.name, u.email, u.created_at as user_created_at
     FROM professional_patient_relationships ppr
     JOIN users u ON ppr.user_id = u.id
     ${where}
     ORDER BY ppr.assigned_date DESC`,
    params,
  );
  return result.rows;
}

async function getProfessionalsByPatient(userId) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  const result = await query(
    `SELECT ppr.id, ppr.professional_id, ppr.user_id, ppr.status, ppr.assigned_date, ppr.notes,
            p.id as prof_id, p.name, p.email, p.crp, p.specialty, p.verified
     FROM professional_patient_relationships ppr
     JOIN professionals p ON ppr.professional_id = p.id
     WHERE ppr.user_id = $1 AND ppr.status = 'active'
     ORDER BY ppr.assigned_date DESC`,
    [userId],
  );
  return result.rows;
}

async function updateRelationshipStatus(relationshipId, status) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  if (!['active', 'inactive', 'paused'].includes(status)) {
    const error = new Error('Status inválido. Use: active, inactive ou paused.');
    error.status = 400;
    throw error;
  }

  const result = await query(
    `UPDATE professional_patient_relationships
     SET status = $1
     WHERE id = $2
     RETURNING id, professional_id, user_id, status, assigned_date, notes`,
    [status, relationshipId],
  );
  return result.rows[0] || null;
}

async function removeProfessionalPatientRelationship(relationshipId) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  const result = await query(
    'DELETE FROM professional_patient_relationships WHERE id = $1 RETURNING id',
    [relationshipId],
  );
  return result.rowCount > 0;
}

async function reviewMoodEntry(entryId, professionalId, professionalNotes) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  if (!entryId || !professionalId) {
    const error = new Error('ID da entrada e do profissional são obrigatórios.');
    error.status = 400;
    throw error;
  }

  const result = await query(
    `UPDATE mood_entries
     SET professional_notes = $1,
         reviewed_by = $2,
         reviewed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
     RETURNING id, user_id, emotion, intensity, context, triggers, notes, professional_notes, reviewed_by, reviewed_at, created_at, updated_at`,
    [professionalNotes || null, professionalId, entryId],
  );
  return result.rows[0] || null;
}

async function getReviewedEntriesByProfessional(professionalId) {
  if (!pool) {
    throw new Error('Operação não suportada sem banco de dados configurado.');
  }

  const result = await query(
    `SELECT me.id, me.user_id, me.emotion, me.intensity, me.context, me.triggers, me.notes, 
            me.professional_notes, me.reviewed_by, me.reviewed_at, me.created_at, me.updated_at,
            u.name, u.email
     FROM mood_entries me
     JOIN users u ON me.user_id = u.id
     WHERE me.reviewed_by = $1
     ORDER BY me.reviewed_at DESC, me.created_at DESC`,
    [professionalId],
  );
  return result.rows;
}

function buildAnalytics(entries) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const byEmotion = {};
  const byDay = {};
  const calendarDays = {};

  entries.forEach((entry) => {
    const intensity = Number(entry.intensity);
    const emotion = entry.emotion;

    if (!byEmotion[emotion]) {
      byEmotion[emotion] = { count: 0, totalIntensity: 0 };
    }
    byEmotion[emotion].count += 1;
    byEmotion[emotion].totalIntensity += intensity;

    const createdAt = new Date(entry.created_at);
    const dayKey = createdAt.toISOString().slice(0, 10);
    if (!byDay[dayKey]) {
      byDay[dayKey] = { count: 0, totalIntensity: 0 };
    }
    byDay[dayKey].count += 1;
    byDay[dayKey].totalIntensity += intensity;

    if (createdAt.getFullYear() === year && createdAt.getMonth() === month) {
      const day = createdAt.getDate();
      if (!calendarDays[day]) {
        calendarDays[day] = { count: 0, totalIntensity: 0 };
      }
      calendarDays[day].count += 1;
      calendarDays[day].totalIntensity += intensity;
    }
  });

  const trend = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const bucket = byDay[key];
    trend.push({
      date: key,
      label: date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
      avg_intensity: bucket ? Number((bucket.totalIntensity / bucket.count).toFixed(1)) : null,
      count: bucket?.count || 0,
    });
  }

  const emotions = Object.entries(byEmotion)
    .map(([emotion, bucket]) => ({
      emotion,
      count: bucket.count,
      avg_intensity: Number((bucket.totalIntensity / bucket.count).toFixed(1)),
    }))
    .sort((a, b) => b.count - a.count);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const contexts = entries.reduce((acc, entry) => {
    if (entry.context) acc[entry.context] = (acc[entry.context] || 0) + 1;
    return acc;
  }, {});

  return {
    emotions,
    trend,
    calendar: {
      year,
      month: month + 1,
      month_label: now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      first_weekday: new Date(year, month, 1).getDay(),
      days: Array.from({ length: daysInMonth }, (_, index) => {
        const day = index + 1;
        const bucket = calendarDays[day];
        return {
          day,
          count: bucket?.count || 0,
          avg_intensity: bucket ? Number((bucket.totalIntensity / bucket.count).toFixed(1)) : null,
        };
      }),
    },
    by_context: Object.entries(contexts)
      .map(([context, count]) => ({ context, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  };
}

async function getSummary(userId) {
  const entries = await listMoodEntries(userId, { limit: 500, offset: 0 });
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
    analytics: buildAnalytics(entries),
  };
}

module.exports = {
  hasDatabaseUrl,
  initDatabase,
  getUserById,
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
  getMoodEntryById,
  createMoodEntry,
  updateMoodEntry,
  deleteMoodEntry,
  getSummary,
  addProfessionalPatientRelationship,
  listPatientsByProfessional,
  getProfessionalsByPatient,
  updateRelationshipStatus,
  removeProfessionalPatientRelationship,
  reviewMoodEntry,
  getReviewedEntriesByProfessional,
};
