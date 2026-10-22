require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Database Pool Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect()
};

function generateReferralCode() {
  return 'AGRI' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// 1. User Registration & Referral Link
app.post('/api/auth/register', async (req, res) => {
  const { full_name, email, phone_number, password, invite_code } = req.body;
  if (!full_name || !phone_number || !password) {
    return res.status(400).json({ error: 'Full name, phone, and password are required.' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const existingUser = await client.query(
      'SELECT id FROM users WHERE phone_number = $1 OR (email IS NOT NULL AND email = $2)',
      [phone_number, email || null]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User already exists.' });
    }
    let referrerId = null;
    if (invite_code) {
      const parentRes = await client.query('SELECT id FROM users WHERE referral_code = $1', [invite_code.trim().toUpperCase()]);
      if (parentRes.rows.length > 0) {
        referrerId = parentRes.rows[0].id;
      }
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newRefCode = generateReferralCode();
    const insertRes = await client.query(
      `INSERT INTO users (full_name, email, phone_number, password_hash, referral_code, referrer_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, full_name, phone_number, referral_code`,
      [full_name, email || null, phone_number, hashedPassword, newRefCode, referrerId]
    );
    await client.query('COMMIT');
    const newUser = insertRes.rows[0];
    const token = jwt.sign({ id: newUser.id }, process.env.JWT_SECRET || 'secretkey', { expiresIn: '7d' });
    return res.status(201).json({ message: 'Account created successfully', token, user: newUser });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Server error during registration' });
  } finally {
    client.release();
  }
});

// 2. Equipment Lease & 10% Commission
app.post('/api/leases/purchase', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secretkey');
    userId = decoded.id;
  } catch (e) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const { tier_id } = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT wallet_balance, referrer_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const tierRes = await client.query('SELECT * FROM equipment_tiers WHERE id = $1 AND is_available = TRUE', [tier_id]);

    if (tierRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Equipment tier not found or unavailable.' });
    }
    const user = userRes.rows[0];
    const tier = tierRes.rows[0];

    if (parseFloat(user.wallet_balance) < parseFloat(tier.price)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [tier.price, userId]);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + tier.duration_days);

    await client.query(
      `INSERT INTO user_leases (user_id, tier_id, amount_paid, daily_yield, end_date) VALUES ($1, $2, $3, $4, $5)`,
      [userId, tier.id, tier.price, tier.daily_yield, endDate]
    );

    if (user.referrer_id) {
      const commissionAmount = parseFloat(tier.price) * 0.10;
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [commissionAmount, user.referrer_id]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'REFERRAL_COMMISSION', $2, 'APPROVED')`,
        [user.referrer_id, commissionAmount]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Machinery leased successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to complete lease transaction' });
  } finally {
    client.release();
  }
});

// 3. Admin Pending & Approval Routes
app.get('/api/admin/pending', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*, u.full_name, u.phone_number FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'PENDING' ORDER BY t.created_at ASC`
    );
    return res.status(200).json({ pending_transactions: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch pending transactions' });
  }
});

app.post('/api/admin/resolve', async (req, res) => {
  const { transaction_id, action } = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transaction_id]);
    if (txRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    const tx = txRes.rows[0];
    if (action === 'APPROVED') {
      if (tx.type === 'DEPOSIT') {
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [tx.amount, tx.user_id]);
      } else if (tx.type === 'WITHDRAWAL') {
        await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [tx.amount, tx.user_id]);
      }
    }
    await client.query('UPDATE transactions SET status = $1 WHERE id = $2', [action, transaction_id]);
    await client.query('COMMIT');
    return res.status(200).json({ message: `Transaction ${action.toLowerCase()}.` });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to resolve transaction' });
  } finally {
    client.release();
  }
});

// 4. Flutterwave Webhook Route
app.post('/api/webhook/flutterwave', async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLW_SECRET_HASH) {
    return res.status(401).send('Unauthorized webhook signature');
  }
  res.sendStatus(200);
  const eventData = req.body;
  if (eventData && eventData.event === 'charge.completed' && eventData.data.status === 'successful') {
    const paymentData = eventData.data;
    const txRef = paymentData.tx_ref;
    const amountPaid = paymentData.amount;
    const customerPhone = paymentData.customer.phone_number;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const userRes = await client.query('SELECT id FROM users WHERE phone_number = $1', [customerPhone]);
      if (userRes.rows.length > 0) {
        const userId = userRes.rows[0].id;
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amountPaid, userId]);
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, status, payment_reference) VALUES ($1, 'DEPOSIT', $2, 'COMPLETED', $3)`,
          [userId, amountPaid, txRef]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
});

// 5. Daily Yield Cron Job
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Running daily yield payouts...');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const activeLeases = await client.query(
      `SELECT id, user_id, daily_yield FROM user_leases WHERE status = 'ACTIVE' AND end_date > CURRENT_TIMESTAMP`
    );
    for (let lease of activeLeases.rows) {
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [lease.daily_yield, lease.user_id]);
      await client.query('UPDATE user_leases SET total_earned = total_earned + $1 WHERE id = $2', [lease.daily_yield, lease.id]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'DAILY_YIELD', $2, 'APPROVED')`,
        [lease.user_id, lease.daily_yield]
      );
    }
    await client.query(`UPDATE user_leases SET status = 'COMPLETED' WHERE end_date <= CURRENT_TIMESTAMP`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`AgriYield Server running on port ${PORT}`);
});