// Load .env at the very top
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const bodyParser = require('body-parser');

const pool = require('./db');
const { generateToken } = require('./auth');
const authMiddleware = require('./middleware/authMiddleware');

const app = express();

// ✅ Parse JSON
app.use(express.json());
app.use(bodyParser.json());
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
  due_date DATE,
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
  file_url TEXT,
  album_art_url TEXT,
  audio_lang VARCHAR(10),
  lyrics JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

// Create tables
(async () => {
  try {
    await queryPromise(createUsersTable);
    await queryPromise(createCategoriesTable);
    await queryPromise(createTodosTable);
    await queryPromise(createUserTokensTable);
    await queryPromise(createSongsTable);
    console.log('All tables ready');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
})();

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
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { identifier, password } = req.body;

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
    console.log(`[GET /todos] Retrieved ${todos.length} todos`);
    res.json(todos);
  } catch (err) {
    console.error('[GET /todos] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    console.log(`[GET /todos/${todoId}] Todo found`);
    res.json(todos[0]);
  } catch (err) {
    console.error(`[GET /todos/${todoId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/todos', authMiddleware, body('title').notEmpty(), async (req, res) => {
  const userId = req.user.id;
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('[POST /todos] Validation errors:', errors.array());
    return res.status(400).json({ errors: errors.array() });
  }

  const { title, description, status, priority, category_id, due_date } = req.body;

  try {
    console.log('[POST /todos] Creating todo for user:', userId);
    const result = await queryPromise(
      'INSERT INTO todos (user_id, title, description, status, priority, category_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, title, description || null, status || 'pending', priority || 'medium', category_id || null, due_date || null]
    );
    console.log('[POST /todos] Todo created with id:', result.insertId);
    res.status(201).json({ id: result.insertId, message: 'Todo created' });
  } catch (err) {
    console.error('[POST /todos] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;
  const { title, description, status, priority, category_id, due_date } = req.body;

  try {
    console.log(`[PUT /todos/${todoId}] Updating todo for user ${userId}`);
    const results = await queryPromise(
      `UPDATE todos SET title=?, description=?, status=?, priority=?, category_id=?, due_date=? WHERE id=? AND user_id=?`,
      [title, description, status, priority, category_id, due_date, todoId, userId]
    );

    if (results.affectedRows === 0) {
      console.log(`[PUT /todos/${todoId}] Todo not found`);
      return res.status(404).json({ error: 'Todo not found' });
    }
    console.log(`[PUT /todos/${todoId}] Todo updated`);
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
    console.log(`[DELETE /todos/${todoId}] Deleting todo for user ${userId}`);
    const results = await queryPromise('DELETE FROM todos WHERE id = ? AND user_id = ?', [
      todoId,
      userId,
    ]);

    if (results.affectedRows === 0) {
      console.log(`[DELETE /todos/${todoId}] Todo not found`);
      return res.status(404).json({ error: 'Todo not found' });
    }
    console.log(`[DELETE /todos/${todoId}] Todo deleted`);
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
    res.json({ message: 'Successfully logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Add this:
app.get("/", (req, res) => {
  res.send("🚀 Assister API is running!");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

