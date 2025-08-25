// Load .env at the very top
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const bodyParser = require('body-parser');

const connection = require('./db');
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
  new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => (err ? reject(err) : resolve(results)));
  });

// Table creation SQL (same as before)
const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
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

// Create tables
(async () => {
  try {
    await queryPromise(createUsersTable);
    await queryPromise(createCategoriesTable);
    await queryPromise(createTodosTable);
    await queryPromise(createUserTokensTable);
    console.log('All tables ready');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
})();

// ---------- Authentication Routes ----------

// Signup
app.post(
  '/signup',
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    console.log('Signup body:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, name } = req.body;

    try {
      const existingUsers = await queryPromise('SELECT * FROM users WHERE email = ?', [email]);
      if (existingUsers.length > 0)
        return res.status(409).json({ error: 'Email already registered' });

      const hashedPassword = await bcrypt.hash(password, 10);
      await queryPromise('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [
        name,
        email,
        hashedPassword,
      ]);

      res.status(201).json({ message: 'User registered' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Signin
app.post(
  '/signin',
  body('email').isEmail(),
  body('password').exists(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    try {
      const users = await queryPromise('SELECT * FROM users WHERE email = ?', [email]);
      if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

      const user = users[0];
      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

      const token = generateToken(user);
      await queryPromise('INSERT INTO user_tokens (user_id, token) VALUES (?, ?)', [user.id, token]);

      res.json({ token });
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
    const todos = await queryPromise(`SELECT * FROM todos ${whereClause}`);
    res.json(todos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    const todos = await queryPromise('SELECT * FROM todos WHERE id = ? AND user_id = ?', [
      todoId,
      userId,
    ]);
    if (todos.length === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json(todos[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/todos', authMiddleware, body('title').notEmpty(), async (req, res) => {
  const userId = req.user.id;
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { title, description, status, priority, category_id, due_date } = req.body;

  try {
    const result = await queryPromise(
      'INSERT INTO todos (user_id, title, description, status, priority, category_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, title, description || null, status || 'pending', priority || 'medium', category_id || null, due_date || null]
    );
    res.status(201).json({ id: result.insertId, message: 'Todo created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;
  const { title, description, status, priority, category_id, due_date } = req.body;

  try {
    const results = await queryPromise(
      `UPDATE todos SET title=?, description=?, status=?, priority=?, category_id=?, due_date=? WHERE id=? AND user_id=?`,
      [title, description, status, priority, category_id, due_date, todoId, userId]
    );

    if (results.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ message: 'Todo updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/todos/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    const results = await queryPromise('DELETE FROM todos WHERE id = ? AND user_id = ?', [
      todoId,
      userId,
    ]);

    if (results.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ message: 'Todo deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/todos/:id/complete', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const todoId = req.params.id;

  try {
    const results = await queryPromise('UPDATE todos SET status = ? WHERE id = ? AND user_id = ?', [
      'completed',
      todoId,
      userId,
    ]);

    if (results.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ message: 'Todo marked as complete' });
  } catch (err) {
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

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
