const express = require('express');
const session = require('express-session');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'rpay-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Database Setup
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        saldo INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // API Keys table
    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        api_key TEXT UNIQUE,
        verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Transactions table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reff_id TEXT UNIQUE,
        nominal INTEGER,
        qr_string TEXT,
        qr_image TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expired_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Withdrawals table
    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        nominal INTEGER,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Webhook logs table
    db.run(`CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reff_id TEXT,
        status TEXT,
        payload TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create admin user if not exists
    const adminPassword = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, email, password, is_admin) 
            VALUES ('admin', 'admin@rpay.xyz', ?, 1)`, [adminPassword]);
});

// Middleware for authentication
const requireLogin = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/auth/login');
    }
};

const requireAdmin = (req, res, next) => {
    if (req.session.userId && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

// Routes

// Home Page
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

// Support Page
app.get('/support', (req, res) => {
    res.render('support');
});

// Docs Page
app.get('/docs', (req, res) => {
    res.render('docs', {
        endpoints: [
            {
                method: 'GET',
                path: '/h2h/deposit/create',
                params: 'apikey, reff_id, nominal',
                description: 'Create QRIS payment'
            },
            {
                method: 'GET',
                path: '/h2h/deposit/status',
                params: 'apikey, reff_id',
                description: 'Check payment status'
            },
            {
                method: 'GET',
                path: '/h2h/deposit/poll',
                params: 'apikey, reff_id',
                description: 'Lightweight status polling'
            }
        ]
    });
});

// Auth Routes
app.get('/auth/login', (req, res) => {
    res.render('auth/login');
});

app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err || !user) {
            return res.redirect('/auth/login?error=User not found');
        }
        
        if (bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.isAdmin = user.is_admin === 1;
            req.session.user = user;
            
            if (user.is_admin === 1) {
                res.redirect('/admin');
            } else {
                res.redirect('/dashboard');
            }
        } else {
            res.redirect('/auth/login?error=Invalid password');
        }
    });
});

app.get('/auth/register', (req, res) => {
    res.render('auth/register');
});

app.post('/auth/register', (req, res) => {
    const { username, email, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
        [username, email, hashedPassword],
        function(err) {
            if (err) {
                return res.redirect('/auth/register?error=Registration failed');
            }
            res.redirect('/auth/login?success=Registration successful');
        }
    );
});

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
    const userId = req.session.userId;
    
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, 
        [userId], (err, transactions) => {
        
        db.all(`SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
            [userId], (err2, withdrawals) => {
            
            db.get('SELECT saldo FROM users WHERE id = ?', [userId], (err3, user) => {
                // Get API Key
                db.get('SELECT api_key FROM api_keys WHERE user_id = ? AND verified = 1 LIMIT 1',
                    [userId], (err4, apiKey) => {
                    
                    res.render('dashboard', {
                        user: {
                            ...req.session.user,
                            api_key: apiKey ? apiKey.api_key : null
                        },
                        saldo: user.saldo,
                        transactions: transactions || [],
                        withdrawals: withdrawals || []
                    });
                });
            });
        });
    });
});

// API Key Management
app.get('/dashboard/api-keys', requireLogin, (req, res) => {
    db.all('SELECT * FROM api_keys WHERE user_id = ?', [req.session.userId], (err, apiKeys) => {
        res.render('api-key', { apiKeys: apiKeys || [] });
    });
});

app.post('/dashboard/api-keys/generate', requireLogin, (req, res) => {
    const apiKey = require('crypto').randomBytes(32).toString('hex');
    
    db.run('INSERT INTO api_keys (user_id, api_key) VALUES (?, ?)',
        [req.session.userId, apiKey],
        function(err) {
            if (err) {
                return res.redirect('/dashboard/api-keys?error=Failed to generate API key');
            }
            res.redirect('/dashboard/api-keys?success=API key generated');
        }
    );
});

// Withdrawal
app.post('/dashboard/withdraw', requireLogin, (req, res) => {
    const { nominal } = req.body;
    const userId = req.session.userId;
    
    // Check balance
    db.get('SELECT saldo FROM users WHERE id = ?', [userId], (err, user) => {
        if (user.saldo < nominal) {
            return res.redirect('/dashboard?error=Insufficient balance');
        }
        
        // Create withdrawal record
        db.run('INSERT INTO withdrawals (user_id, nominal) VALUES (?, ?)',
            [userId, nominal],
            function(err) {
                if (err) {
                    return res.redirect('/dashboard?error=Withdrawal failed');
                }
                
                // Update balance
                db.run('UPDATE users SET saldo = saldo - ? WHERE id = ?',
                    [nominal, userId]);
                
                // Redirect to WhatsApp admin
                const phone = '6289525036410';
                const message = `Halo Admin RPay, saya ingin melakukan pencairan sebesar Rp ${nominal}`;
                const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
                res.redirect(waUrl);
            }
        );
    });
});

// API Endpoint for QRIS Payment
app.get('/h2h/deposit/create', async (req, res) => {
    const { apikey, reff_id, nominal } = req.query;
    
    // Validate API Key
    db.get(`SELECT ak.*, u.username 
            FROM api_keys ak 
            JOIN users u ON ak.user_id = u.id 
            WHERE ak.api_key = ?`, 
        [apikey], (err, apiKeyData) => {
        
        if (err || !apiKeyData) {
            return res.json({
                status: false,
                message: 'Invalid API Key'
            });
        }
        
        if (apiKeyData.verified === 0) {
            return res.json({
                status: false,
                message: 'API Key not verified'
            });
        }
        
        // Check if reff_id already exists
        db.get('SELECT * FROM transactions WHERE reff_id = ?', [reff_id], (err, existing) => {
            if (existing) {
                return res.json({
                    status: false,
                    message: 'reff_id already used'
                });
            }
            
            // Integrate with Atlantic H2H
            const atlanticApiKey = 'ftS3uUCMOztd71uxhWp9MsVQchbBNQXLOcLJpkQW1W9aQg3gyXvUzJQkHW7bV54P6fKeWrzIWJf44nuuUh7xPTMQHY8lCtslMfez';
            
            axios.get('https://atlantich2h.com/deposit/create', {
                params: {
                    apikey: atlanticApiKey,
                    reff_id: reff_id,
                    nominal: nominal,
                    type: 'ewallet',
                    metode: 'qrisfast'
                }
            })
            .then(response => {
                const atlanticData = response.data.data;
                
                // Save transaction
                const expiredAt = new Date();
                expiredAt.setHours(expiredAt.getHours() + 1);
                
                db.run(`INSERT INTO transactions 
                        (user_id, reff_id, nominal, qr_string, qr_image, status, expired_at) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        apiKeyData.user_id,
                        reff_id,
                        nominal,
                        atlanticData.qr_string,
                        atlanticData.qr_image,
                        'pending',
                        expiredAt.toISOString()
                    ],
                    function(err) {
                        if (err) {
                            return res.json({
                                status: false,
                                message: 'Failed to save transaction'
                            });
                        }
                        
                        // Return response
                        res.json({
                            status: true,
                            data: {
                                id: this.lastID,
                                reff_id: reff_id,
                                nominal: parseInt(nominal),
                                qr_string: atlanticData.qr_string,
                                qr_image: atlanticData.qr_image,
                                status: 'pending',
                                created_at: new Date().toISOString().replace('T', ' ').substr(0, 19),
                                expired_at: expiredAt.toISOString().replace('T', ' ').substr(0, 19)
                            },
                            code: 200
                        });
                    }
                );
            })
            .catch(error => {
                console.error('Atlantic API Error:', error);
                res.json({
                    status: false,
                    message: 'Failed to create QRIS payment'
                });
            });
        });
    });
});

// API Endpoint untuk Cek Status Deposit
app.get('/h2h/deposit/status', async (req, res) => {
    const { apikey, reff_id } = req.query;
    
    // Validate API Key
    db.get(`SELECT ak.*, u.username 
            FROM api_keys ak 
            JOIN users u ON ak.user_id = u.id 
            WHERE ak.api_key = ?`, 
        [apikey], async (err, apiKeyData) => {
        
        if (err || !apiKeyData) {
            return res.json({
                status: false,
                message: 'Invalid API Key'
            });
        }
        
        if (apiKeyData.verified === 0) {
            return res.json({
                status: false,
                message: 'API Key not verified'
            });
        }
        
        // Cari transaksi di database
        db.get(`SELECT * FROM transactions 
                WHERE reff_id = ? AND user_id = ?`,
            [reff_id, apiKeyData.user_id], async (err, transaction) => {
            
            if (err || !transaction) {
                return res.json({
                    status: false,
                    message: 'Transaction not found'
                });
            }
            
            // Jika status sudah success di database, langsung return
            if (transaction.status === 'success') {
                return res.json({
                    status: true,
                    data: {
                        id: transaction.id,
                        reff_id: transaction.reff_id,
                        nominal: transaction.nominal,
                        qr_string: transaction.qr_string,
                        qr_image: transaction.qr_image,
                        status: transaction.status,
                        created_at: transaction.created_at,
                        expired_at: transaction.expired_at
                    },
                    code: 200
                });
            }
            
            // Cek ke Atlantic H2H API
            try {
                const atlanticApiKey = 'ftS3uUCMOztd71uxhWp9MsVQchbBNQXLOcLJpkQW1W9aQg3gyXvUzJQkHW7bV54P6fKeWrzIWJf44nuuUh7xPTMQHY8lCtslMfez';
                
                const response = await axios.get('https://atlantich2h.com/deposit/status', {
                    params: {
                        apikey: atlanticApiKey,
                        reff_id: reff_id
                    }
                });
                
                const atlanticData = response.data.data;
                
                // Update status di database jika berbeda
                if (atlanticData.status !== transaction.status) {
                    db.run('UPDATE transactions SET status = ? WHERE reff_id = ?',
                        [atlanticData.status, reff_id], (updateErr) => {
                            if (!updateErr && atlanticData.status === 'success') {
                                // Jika berhasil, update saldo user (dikurangi fee 1.4% + 300)
                                const fee = Math.floor(transaction.nominal * 0.014) + 300;
                                const netAmount = transaction.nominal - fee;
                                
                                db.run('UPDATE users SET saldo = saldo + ? WHERE id = ?',
                                    [netAmount, apiKeyData.user_id]);
                            }
                        });
                }
                
                // Update data dari Atlantic
                db.run(`UPDATE transactions 
                        SET qr_string = ?, qr_image = ?, status = ?
                        WHERE reff_id = ?`,
                    [
                        atlanticData.qr_string || transaction.qr_string,
                        atlanticData.qr_image || transaction.qr_image,
                        atlanticData.status,
                        reff_id
                    ]);
                
                // Return updated transaction
                res.json({
                    status: true,
                    data: {
                        id: transaction.id,
                        reff_id: transaction.reff_id,
                        nominal: transaction.nominal,
                        qr_string: atlanticData.qr_string || transaction.qr_string,
                        qr_image: atlanticData.qr_image || transaction.qr_image,
                        status: atlanticData.status,
                        created_at: transaction.created_at,
                        expired_at: transaction.expired_at
                    },
                    code: 200
                });
                
            } catch (error) {
                console.error('Atlantic Status Check Error:', error);
                
                // Jika gagal cek Atlantic, return data dari database
                res.json({
                    status: true,
                    data: {
                        id: transaction.id,
                        reff_id: transaction.reff_id,
                        nominal: transaction.nominal,
                        qr_string: transaction.qr_string,
                        qr_image: transaction.qr_image,
                        status: transaction.status,
                        created_at: transaction.created_at,
                        expired_at: transaction.expired_at
                    },
                    code: 200
                });
            }
        });
    });
});

// Endpoint untuk Polling Status (Auto Refresh)
app.get('/h2h/deposit/poll', (req, res) => {
    const { apikey, reff_id } = req.query;
    
    // Similar logic to status check but simplified for polling
    db.get(`SELECT ak.* FROM api_keys ak WHERE ak.api_key = ? AND ak.verified = 1`, 
        [apikey], (err, apiKeyData) => {
        
        if (err || !apiKeyData) {
            return res.json({ status: 'invalid_api' });
        }
        
        db.get(`SELECT status FROM transactions WHERE reff_id = ? AND user_id = ?`,
            [reff_id, apiKeyData.user_id], (err, transaction) => {
            
            if (err || !transaction) {
                return res.json({ status: 'not_found' });
            }
            
            res.json({ 
                status: transaction.status,
                message: transaction.status === 'success' ? 'Payment successful' : 
                        transaction.status === 'pending' ? 'Waiting for payment' :
                        'Payment expired/failed'
            });
        });
    });
});

// QRIS Payment Page
app.get('/pg/:reff_id/:apikey', (req, res) => {
    const { reff_id, apikey } = req.params;
    
    db.get(`SELECT t.*, u.username 
            FROM transactions t 
            JOIN api_keys ak ON t.user_id = ak.user_id
            JOIN users u ON t.user_id = u.id
            WHERE t.reff_id = ? AND ak.api_key = ?`,
        [reff_id, apikey], (err, transaction) => {
        
        if (err || !transaction) {
            return res.send('Transaction not found');
        }
        
        res.render('payment', { transaction });
    });
});

// Admin Routes
app.get('/admin/login', (req, res) => {
    res.render('admin/login');
});

app.post('/admin/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get('SELECT * FROM users WHERE email = ? AND is_admin = 1', [email], (err, admin) => {
        if (err || !admin) {
            return res.redirect('/admin/login?error=Admin not found');
        }
        
        if (bcrypt.compareSync(password, admin.password)) {
            req.session.userId = admin.id;
            req.session.isAdmin = true;
            req.session.user = admin;
            res.redirect('/admin');
        } else {
            res.redirect('/admin/login?error=Invalid password');
        }
    });
});

app.get('/admin', requireAdmin, (req, res) => {
    db.all(`SELECT u.*, ak.api_key, ak.verified 
            FROM users u 
            LEFT JOIN api_keys ak ON u.id = ak.user_id 
            WHERE u.is_admin = 0
            ORDER BY u.created_at DESC`,
        (err, users) => {
        
        res.render('admin/panel', { users: users || [] });
    });
});

app.post('/admin/verify-api-key/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    db.run('UPDATE api_keys SET verified = 1 WHERE user_id = ?', [userId], (err) => {
        if (err) {
            return res.redirect('/admin?error=Verification failed');
        }
        res.redirect('/admin?success=API Key verified');
    });
});

// FITUR HAPUS USER - TAMBAHAN
app.post('/admin/delete-user/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    // Jangan izinkan menghapus diri sendiri
    if (parseInt(userId) === req.session.userId) {
        return res.redirect('/admin?error=Cannot delete your own account');
    }
    
    // Cek apakah user ada
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.redirect('/admin?error=User not found');
        }
        
        // Hapus user dan semua data terkait (CASCADE delete akan menangani ini)
        db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
            if (err) {
                return res.redirect('/admin?error=Failed to delete user');
            }
            res.redirect('/admin?success=User deleted successfully');
        });
    });
});

// Check payment status (webhook from Atlantic)
app.post('/webhook/atlantic', express.json(), (req, res) => {
    const { reff_id, status } = req.body;
    
    // Log webhook
    db.run('INSERT INTO webhook_logs (reff_id, status, payload) VALUES (?, ?, ?)',
        [reff_id, status, JSON.stringify(req.body)]);
    
    if (status === 'success') {
        // Update transaction and balance
        db.get('SELECT * FROM transactions WHERE reff_id = ?', [reff_id], (err, transaction) => {
            if (transaction && transaction.status !== 'success') {
                // Update transaction
                db.run('UPDATE transactions SET status = ? WHERE reff_id = ?', 
                    ['success', reff_id]);
                
                // Update balance
                const fee = Math.floor(transaction.nominal * 0.014) + 300;
                const netAmount = transaction.nominal - fee;
                
                db.run('UPDATE users SET saldo = saldo + ? WHERE id = ?',
                    [netAmount, transaction.user_id]);
            }
        });
    }
    
    res.json({ received: true });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// API untuk mendapatkan saldo
app.get('/api/balance', requireLogin, (req, res) => {
    const userId = req.session.userId;
    
    db.get('SELECT saldo FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.json({ status: false, message: 'User not found' });
        }
        
        res.json({ status: true, balance: user.saldo });
    });
});

app.listen(PORT, () => {
    console.log(`RPay running on port ${PORT}`);
    console.log(`Website: http://localhost:${PORT}`);
});
