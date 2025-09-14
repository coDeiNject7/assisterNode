// Load .env at the very top
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const pool = require('./db');
const { generateToken } = require('./auth');
const authMiddleware = require('./middleware/authMiddleware');
const app = express();
const schedule = require('node-schedule');
const scheduledReminderJobs = new Map();
const admin = require('./firebase');

// ✅ Parse JSON
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Debugging content type
app.use((req, res, next) => {
  console.log('Incoming content-type:', req.headers['content-type']);
  next();
});

app.post('/test-json', (req, res) => {
  console.log('Test json body:', req.body);
  res.json({ received: req.body });
});

// Utility function for queries
const queryPromise = (sql, params = []) =>
  pool.query(sql, params).then(([rows]) => rows);

// Table creation SQL (same as before)
const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20) UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const createUserTokensTable = `
CREATE TABLE IF NOT EXISTS user_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(512) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

const createCategoriesTable = `
CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

const createTodosTable = `
CREATE TABLE IF NOT EXISTS todos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('pending','completed') DEFAULT 'pending',
  priority ENUM('low','medium','high') DEFAULT 'medium',
  category_id INT,
  due_date DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);`;

const createSongsTable = `
CREATE TABLE IF NOT EXISTS songs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255),
  artist VARCHAR(255),
  movie VARCHAR(255),
  year VARCHAR(10),
  genre VARCHAR(100),
  composers VARCHAR(255),
  audio_lang VARCHAR(50),
  label VARCHAR(255),
  file_url TEXT,
  album_art_url TEXT,
  local_mp3 TEXT,
  local_jpg TEXT,
  youtube_url TEXT,
  lyrics JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const createUserFcmTokensTable = `
CREATE TABLE IF NOT EXISTS user_fcm_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  fcm_token VARCHAR(512) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

app.get("/", (req, res) => {
  res.send("🚀 Assister API is running!");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);

  runMigrations();
});

// Create tables
async function runMigrations() {
  try {
    console.log("⚙️ Running database migrations...");
    await queryPromise(createUsersTable);
    await queryPromise(createCategoriesTable);
    await queryPromise(createTodosTable);
    await queryPromise(createUserTokensTable);
    await queryPromise(createUserFcmTokensTable);
    await queryPromise(createSongsTable);
    console.log("✅ All tables ready");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
}

// Public route: Get all songs metadata
app.get('/public/songs', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM songs ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public route: Search songs by a word in the title
app.get('/public/songs/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

  try {
    console.log('Search term:', q);
    const likeQuery = `%${q}%`;
    const rows = await queryPromise('SELECT * FROM songs WHERE title LIKE ?', [likeQuery]);
    console.log('DB results:', rows);
    res.json(rows); // Return results array, empty if no matches
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public route: Get single song metadata by ID
app.get('/public/songs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT * FROM songs WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Authentication Routes ----------

async function getUserFcmTokens(userId) {
  try {
    const rows = await queryPromise('SELECT fcm_token FROM user_fcm_tokens WHERE user_id = ?', [userId]);
    return rows.map(row => row.fcm_token);
  } catch (err) {
    console.error('Failed to fetch FCM tokens for user:', userId, err);
    return [];
  }
}

async function sendPushNotification(fcmTokens, title, body) {
  if (!fcmTokens.length) {
    console.log('No FCM tokens for user; skipping notification');
    return;
  }

  const payload = {
    notification: { title, body },
    tokens: fcmTokens,
  };

  try {
    const response = await admin.messaging().sendMulticast(payload);
    console.log(`Sent ${response.successCount} push notifications; ${response.failureCount} failed`);
  } catch (error) {
    console.error('Error sending push notifications:', error);
  }
}

function scheduleReminderNotification(todoId, reminderDateUTC, fcmTokens, title) {
  if (scheduledReminderJobs.has(todoId)) {
    scheduledReminderJobs.get(todoId).cancel();
  }

  if (reminderDateUTC <= new Date()) {
    console.log(`Reminder time already passed for todo ${todoId}, skipping scheduling`);
    return;
  }

  const job = schedule.scheduleJob(reminderDateUTC, async () => {
    await sendPushNotification(fcmTokens, 'Todo Reminder', title);
    scheduledReminderJobs.delete(todoId);
  });

  scheduledReminderJobs.set(todoId, job);
  console.log(`Scheduled reminder for todo ${todoId} at ${reminderDateUTC}`);
}

function cancelReminderNotification(todoId) {
  if (scheduledReminderJobs.has(todoId)) {
    scheduledReminderJobs.get(todoId).cancel();
    scheduledReminderJobs.delete(todoId);
    console.log(`Cancelled reminder for todo ${todoId}`);
  }
}

// Signup
app.post(
  '/signup',
  body('email').isEmail(),
  body('phone').isMobilePhone().withMessage('Invalid phone number'),
  body('password').isLength({ min: 6 }),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  }),
  async (req, res) => {
    console.log('Signup body:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, phone, password, name } = req.body;

    try {
      // Check if email or phone already exists
      const existingUsers = await queryPromise(
        'SELECT * FROM users WHERE email = ? OR phone = ?',
        [email, phone]
      );
      if (existingUsers.length > 0) {
        return res.status(409).json({ error: 'Email or phone already registered' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await queryPromise(
        'INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)',
        [name, email, phone, hashedPassword]
      );

      // Fetch the newly inserted user (excluding password for security)
      const [newUser] = await queryPromise(
        'SELECT id, name, email, phone, created_at FROM users WHERE id = ?',
        [result.insertId]
      );

      res.status(201).json({ user: newUser });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Signin (by email OR phone)
app.post(
  '/signin',
  body('identifier').notEmpty().withMessage('Email or phone is required'),
  body('password').exists(),
  body('fcmToken').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { identifier, password, fcmToken } = req.body;

    try {
      // Try finding by email OR phone
      const users = await queryPromise(
        'SELECT * FROM users WHERE email = ? OR phone = ?',
        [identifier, identifier]
      );

      if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

      const user = users[0];
      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

      const token = generateToken(user);
      await queryPromise('INSERT INTO user_tokens (user_id, token) VALUES (?, ?)', [
        user.id,
        token,
      ]);

      // Save or update the FCM token if provided
      if (fcmToken) {
        await queryPromise(
          `INSERT INTO user_fcm_tokens (user_id, fcm_token) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
          [user.id, fcmToken]
        );
      }

      // Return user without password + token
      const { password: _, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword, token });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------- Todos Routes ----------
app.get('/todos', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { status, category, priority, dueDate } = req.query;

  let filters = [`user_id = ${userId}`];
  if (status) filters.push(`status = '${status}'`);
  if (category) filters.push(`category_id = ${category}`);
  if (priority) filters.push(`priority = '${priority}'`);
  if (dueDate) filters.push(`due_date = '${dueDate}'`);

  const whereClause = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

  try {
    console.log(`[GET /todos] Querying todos with filters: ${whereClause}`);
    const todos = await queryPromise(`SELECT * FROM todos ${whereClause}`);
    const todosWithISTDates = todos.map(todo => {
      if (todo.due_date) {
        todo.due_date = moment.utc(todo.due_date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
      }
      return todo;
    });
    console.log(`[GET /todos] Retrieved ${todos.length} todos`);
    res.json(todosWithISTDates);
  } catch (err) {
    console.error('[GET /todos] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Search todos by title (partial match)
app.get('/todos/search', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { title } = req.query;

  console.log(`[GET /todos/search] Authenticated user ID: ${userId}`);
  console.log(`[GET /todos/search] Search title query param: ${title}`);

  if (!title) {
    console.log('[GET /todos/search] Missing title query parameter');
    return res.status(400).json({ error: 'Query parameter "title" is required' });
  }

  try {
    const likeQuery = `%${title}%`;
    console.log(`[GET /todos/search] Searching todos for user ${userId} with title LIKE: ${likeQuery}`);

    const todos = await queryPromise(
      'SELECT * FROM todos WHERE user_id = ? AND title LIKE ?',
      [userId, likeQuery]
    );

    console.log(`[GET /todos/search] Query returned ${todos.length} todos:`, todos);

    // Convert due_date to IST string if present
    const todosWithISTDates = todos.map(todo => {
      if (todo.due_date) {
        todo.due_date = moment.utc(todo.due_date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
      }
      return todo;
    });

    res.json(todosWithISTDates);
  } catch (err) {
    console.error('[GET /todos/search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /todos/:id - convert single due_date to IST string
app.get('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    console.log(`[GET /todos/${todoId}] Fetching todo for user ${userId}`);
    const todos = await queryPromise('SELECT * FROM todos WHERE id = ? AND user_id = ?', [
      todoId,
      userId,
    ]);
    if (todos.length === 0) {
      console.log(`[GET /todos/${todoId}] Todo not found`);
      return res.status(404).json({ error: 'Todo not found' });
    }
    const todo = todos[0];
    if (todo.due_date) {
      todo.due_date = moment.utc(todo.due_date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
    }
    console.log(`[GET /todos/${todoId}] Todo found`);
    res.json(todo);
  } catch (err) {
    console.error(`[GET /todos/${todoId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /todos - convert incoming IST due_date to DB datetime
app.post('/todos', authMiddleware, body('title').notEmpty(), async (req, res) => {
  const userId = req.user.id;
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { title, description, status, priority, category_id, due_date } = req.body;
  let dueDateIST = null;
  if (due_date) dueDateIST = moment.tz(due_date, 'Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');

  try {
    const result = await queryPromise(
      `INSERT INTO todos (user_id, title, description, status, priority, category_id, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, title, description || null, status || 'pending', priority || 'medium', category_id || null, dueDateIST]
    );

    const todoId = result.insertId;
    const fcmTokens = await getUserFcmTokens(userId);

    // Send immediate notification
    await sendPushNotification(fcmTokens, 'Todo Created', `Your todo "${title}" has been created.`);

    // Schedule reminder if due date set
    if (dueDateIST) {
      const reminderDateUTC = moment.tz(dueDateIST, 'Asia/Kolkata').toDate();
      scheduleReminderNotification(todoId, reminderDateUTC, fcmTokens, title);
    }

    res.status(201).json({ id: todoId, message: 'Todo created' });
  } catch (err) {
    console.error('[POST /todos] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /todos/:id - convert incoming IST due_date to DB datetime format
app.put('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;
  const { title, description, status, priority, category_id, due_date } = req.body;

  let dueDateIST = null;
  if (due_date) dueDateIST = moment.tz(due_date, 'Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');

  try {
    const results = await queryPromise(
      `UPDATE todos SET title=?, description=?, status=?, priority=?, category_id=?, due_date=?
       WHERE id=? AND user_id=?`,
      [title, description, status, priority, category_id, dueDateIST, todoId, userId]
    );

    if (results.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });

    const fcmTokens = await getUserFcmTokens(userId);

    // Immediate notification
    await sendPushNotification(fcmTokens, 'Todo Updated', `Your todo "${title}" has been updated.`);

    // Cancel existing reminder
    cancelReminderNotification(todoId);

    // Schedule new reminder if set
    if (dueDateIST) {
      const reminderDateUTC = moment.tz(dueDateIST, 'Asia/Kolkata').toDate();
      scheduleReminderNotification(todoId, reminderDateUTC, fcmTokens, title);
    }

    res.json({ message: 'Todo updated' });
  } catch (err) {
    console.error(`[PUT /todos/${todoId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    const results = await queryPromise('DELETE FROM todos WHERE id = ? AND user_id = ?', [todoId, userId]);
    if (results.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });

    cancelReminderNotification(todoId);

    res.json({ message: 'Todo deleted' });
  } catch (err) {
    console.error(`[DELETE /todos/${todoId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/todos/:id/complete', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    console.log(`[POST /todos/${todoId}/complete] Marking todo complete for user ${userId}`);
    const results = await queryPromise('UPDATE todos SET status = ? WHERE id = ? AND user_id = ?', [
      'completed',
      todoId,
      userId,
    ]);

    if (results.affectedRows === 0) {
      console.log(`[POST /todos/${todoId}/complete] Todo not found`);
      return res.status(404).json({ error: 'Todo not found' });
    }
    console.log(`[POST /todos/${todoId}/complete] Todo marked as complete`);
    res.json({ message: 'Todo marked as complete' });
  } catch (err) {
    console.error(`[POST /todos/${todoId}/complete] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Categories ----------
app.get('/categories', authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const categories = await queryPromise('SELECT * FROM categories WHERE user_id = ?', [userId]);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/categories', authMiddleware, body('name').notEmpty(), async (req, res) => {
  const userId = req.user.id;
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name } = req.body;

  try {
    const result = await queryPromise('INSERT INTO categories (user_id, name) VALUES (?, ?)', [
      userId,
      name,
    ]);
    res.status(201).json({ id: result.insertId, message: 'Category created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/categories/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const categoryId = req.params.id;
  const { name } = req.body;

  try {
    const results = await queryPromise('UPDATE categories SET name = ? WHERE id = ? AND user_id = ?', [
      name,
      categoryId,
      userId,
    ]);
    if (results.affectedRows === 0) return res.status(404).json({ error: 'Category not found' });
    res.json({ message: 'Category updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/categories/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const categoryId = req.params.id;

  try {
    const results = await queryPromise('DELETE FROM categories WHERE id = ? AND user_id = ?', [
      categoryId,
      userId,
    ]);
    if (results.affectedRows === 0) return res.status(404).json({ error: 'Category not found' });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/logout', authMiddleware, async (req, res) => {
  try {
    await queryPromise('DELETE FROM user_tokens WHERE user_id = ? AND token = ?', [req.user.id, req.token]);
    await queryPromise('DELETE FROM user_fcm_tokens WHERE user_id = ?', [req.user.id]);
    res.json({ message: 'Successfully logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

