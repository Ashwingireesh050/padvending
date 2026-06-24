require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ========== RAZORPAY SETUP ==========
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// ========== DATABASE ==========
const db = new sqlite3.Database('./vending.db', (err) => {
  if (err) console.error('DB Error:', err);
  else {
    console.log('Database connected');
    initDatabase();
  }
});

function initDatabase() {
  db.run(`CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY, name TEXT, location TEXT,
    max_capacity INTEGER DEFAULT 20, current_stock INTEGER DEFAULT 20,
    price_per_item REAL DEFAULT 10.00, total_dispensed INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0, total_sales REAL DEFAULT 0.00,
    status TEXT DEFAULT 'active', last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, machine_id TEXT, transaction_id TEXT UNIQUE,
    razorpay_order_id TEXT, razorpay_payment_id TEXT, quantity INTEGER, amount REAL,
    price_per_item REAL, status TEXT DEFAULT 'pending', stock_before INTEGER,
    stock_after INTEGER, dispensed_count INTEGER, failed_count INTEGER,
    refund_id TEXT, refund_amount REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP, completed_at TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stock_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT,
    action TEXT, quantity_change INTEGER, stock_before INTEGER,
    stock_after INTEGER, reason TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  db.get("SELECT * FROM machines WHERE id = 'PAD_VM_001'", (err, row) => {
    if (!row) {
      db.run(`INSERT INTO machines (id, name, location, max_capacity, current_stock, price_per_item)
        VALUES ('PAD_VM_001', 'Block A Machine', 'Girls Hostel Block A', 20, 20, 10.00)`);
      console.log('Default machine created');
    }
  });
}

// ========== HELPERS ==========
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ========== WEBSOCKET ==========
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Dashboard connected');
  sendDashboardData(ws);
  ws.on('close', () => clients.delete(ws));
});

async function sendDashboardData(ws) {
  try {
    const machines = await dbAll('SELECT * FROM machines');
    const stats = await dbGet(`SELECT COUNT(*) as total_transactions,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) as refunded,
      SUM(CASE WHEN status='success' THEN amount ELSE 0 END) as total_revenue,
      SUM(CASE WHEN status='success' THEN quantity ELSE 0 END) as total_pads
      FROM transactions WHERE date(created_at)=date('now')`);
    const transactions = await dbAll(`SELECT t.*, m.name as machine_name FROM transactions t
      LEFT JOIN machines m ON t.machine_id=m.id ORDER BY t.created_at DESC LIMIT 10`);
    ws.send(JSON.stringify({ type: 'init', data: { machines, stats, transactions } }));
  } catch (e) { console.error(e); }
}

setInterval(async () => {
  if (clients.size === 0) return;
  try {
    const machines = await dbAll('SELECT * FROM machines');
    const stats = await dbGet(`SELECT COUNT(*) as total_transactions,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) as refunded,
      SUM(CASE WHEN status='success' THEN amount ELSE 0 END) as total_revenue,
      SUM(CASE WHEN status='success' THEN quantity ELSE 0 END) as total_pads
      FROM transactions WHERE date(created_at)=date('now')`);
    const msg = JSON.stringify({ type: 'update', data: { machines, stats, timestamp: new Date().toISOString() } });
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  } catch (e) { console.error(e); }
}, 5000);

// ========== API ROUTES ==========

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ========== RAZORPAY ORDER CREATION ==========
app.post('/api/register', async (req, res) => {
  try {
    const { machine_id, transaction_id, amount, quantity, price_per_item, stock_before } = req.body;

    const machine = await dbGet('SELECT * FROM machines WHERE id=?', [machine_id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const existing = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [transaction_id]);
    if (existing) return res.status(409).json({ error: 'Exists', status: existing.status });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: transaction_id,
      notes: {
        machine_id: machine_id,
        quantity: quantity.toString(),
        product: 'sanitary_pad'
      }
    });

    const id = uuidv4();
    await dbRun(
      `INSERT INTO transactions (id, machine_id, transaction_id, razorpay_order_id, quantity, amount, price_per_item, status, stock_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, machine_id, transaction_id, order.id, quantity, amount, price_per_item, stock_before]
    );

    console.log(`[REGISTER] ${transaction_id} | Razorpay Order: ${order.id}`);

    res.json({
      success: true,
      status: 'pending',
      order_id: order.id,
      amount: amount,
      razorpay_key: process.env.RAZORPAY_KEY_ID
    });

  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// ========== CHECK PAYMENT STATUS ==========
app.get('/api/status', async (req, res) => {
  try {
    const { txn_id } = req.query;
    const txn = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [txn_id]);
    if (!txn) return res.status(404).json({ error: 'Not found' });

    if (txn.razorpay_order_id && txn.status === 'pending') {
      try {
        const razorpayOrder = await razorpay.orders.fetch(txn.razorpay_order_id);
        if (razorpayOrder.status === 'paid') {
          const payments = await razorpay.orders.fetchPayments(txn.razorpay_order_id);
          const payment = payments.items[0];
          await dbRun('UPDATE transactions SET status=?, paid_at=?, razorpay_payment_id=? WHERE id=?',
            ['paid', new Date().toISOString(), payment?.id, txn.id]);
          txn.status = 'paid';
        }
      } catch (rzpErr) {
        console.log('Razorpay fetch error:', rzpErr.message);
      }
    }

    res.json({
      transaction_id: txn.transaction_id,
      status: txn.status,
      amount: txn.amount,
      quantity: txn.quantity
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== MANUAL VERIFY ==========
app.post('/api/verify', async (req, res) => {
  try {
    const { txn_id, admin_password } = req.body;
    if (admin_password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });

    const txn = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [txn_id]);
    if (!txn) return res.status(404).json({ error: 'Not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: `Already ${txn.status}` });

    await dbRun('UPDATE transactions SET status=?, paid_at=? WHERE transaction_id=?', ['paid', new Date().toISOString(), txn_id]);
    console.log(`[VERIFY] ${txn_id} by admin`);
    res.json({ success: true, message: 'Payment verified' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== COMPLETE DISPENSING ==========
app.post('/api/complete', async (req, res) => {
  try {
    const { txn_id, machine_id, dispensed_count, failed_count, stock_after, secret_key } = req.body;
    if (secret_key !== process.env.MACHINE_SECRET) return res.status(401).json({ error: 'Invalid secret' });

    const txn = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [txn_id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    const machine = await dbGet('SELECT * FROM machines WHERE id=?', [machine_id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const finalStatus = (failed_count === 0) ? 'success' : 'partial';
    await dbRun(`UPDATE transactions SET status=?, completed_at=?, stock_after=?, dispensed_count=?, failed_count=?
      WHERE transaction_id=?`, [finalStatus, new Date().toISOString(), stock_after, dispensed_count, failed_count, txn_id]);

    const newDispensed = machine.total_dispensed + dispensed_count;
    const newFailed = machine.total_failed + failed_count;
    await dbRun('UPDATE machines SET current_stock=?, total_dispensed=?, total_failed=?, last_seen=? WHERE id=?',
      [stock_after, newDispensed, newFailed, new Date().toISOString(), machine_id]);

    if (dispensed_count > 0) {
      const saleAmount = (dispensed_count / txn.quantity) * txn.amount;
      await dbRun('UPDATE machines SET total_sales=total_sales+? WHERE id=?', [saleAmount, machine_id]);
    }

    await dbRun(`INSERT INTO stock_logs (machine_id, action, quantity_change, stock_before, stock_after, reason)
      VALUES (?, 'dispense', ?, ?, ?, ?)`, [machine_id, -dispensed_count, txn.stock_before, stock_after, `Transaction ${txn_id}`]);

    // AUTO-REFUND for failed items
    if (failed_count > 0 && txn.razorpay_payment_id) {
      const refundAmount = (failed_count / txn.quantity) * txn.amount;
      console.log(`[AUTO-REFUND] ${txn_id}: ₹${refundAmount} for ${failed_count} failed items`);

      try {
        const refund = await razorpay.payments.refund(txn.razorpay_payment_id, {
          amount: Math.round(refundAmount * 100),
          notes: { 
            reason: failed_count + ' pad(s) not dispensed', 
            transaction_id: txn_id,
            machine_id: machine_id
          }
        });

        await dbRun('UPDATE transactions SET status=?, refund_id=?, refund_amount=? WHERE id=?', 
          ['refunded', refund.id, refundAmount, txn.id]);

        console.log(`[REFUND SUCCESS] ${txn_id}: Refund ID ${refund.id}`);
      } catch (rzpErr) {
        console.error('Auto-refund failed:', rzpErr.message);
      }
    }

    console.log(`[COMPLETE] ${txn_id}: ${dispensed_count}/${txn.quantity} dispensed`);
    res.json({ success: true, status: finalStatus, refunded: failed_count > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== REFUND ENDPOINT ==========
app.post('/api/refund', async (req, res) => {
  try {
    const { txn_id, reason, admin_password } = req.body;

    if (admin_password !== process.env.ADMIN_PASSWORD && admin_password !== process.env.MACHINE_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const txn = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [txn_id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    if (txn.status !== 'paid' && txn.status !== 'success' && txn.status !== 'partial') {
      return res.status(400).json({ error: 'Transaction not paid, cannot refund' });
    }

    if (txn.status === 'refunded') {
      return res.status(400).json({ error: 'Already refunded' });
    }

    // Get payment ID from Razorpay order
    let paymentId = txn.razorpay_payment_id;
    if (!paymentId && txn.razorpay_order_id) {
      try {
        const payments = await razorpay.orders.fetchPayments(txn.razorpay_order_id);
        paymentId = payments.items[0]?.id;
      } catch (e) { console.log('Could not fetch payment ID'); }
    }

    if (!paymentId) {
      return res.status(400).json({ error: 'No payment found to refund' });
    }

    try {
      const refund = await razorpay.payments.refund(paymentId, {
        amount: Math.round(txn.amount * 100),
        notes: {
          reason: reason || 'Item not dispensed',
          transaction_id: txn_id,
          machine_id: txn.machine_id
        }
      });

      await dbRun('UPDATE transactions SET status=?, refund_id=?, refund_amount=?, completed_at=? WHERE id=?', 
        ['refunded', refund.id, txn.amount, new Date().toISOString(), txn.id]);

      console.log(`[REFUND] ${txn_id}: ₹${txn.amount} refunded | Refund ID: ${refund.id}`);

      res.json({ 
        success: true, 
        message: 'Refund initiated successfully',
        refund_id: refund.id,
        amount: txn.amount,
        status: refund.status
      });

    } catch (rzpErr) {
      console.error('Razorpay refund error:', rzpErr);
      res.status(500).json({ error: 'Refund failed', details: rzpErr.message });
    }

  } catch (e) {
    console.error('Refund error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== GET REFUND STATUS ==========
app.get('/api/refund-status', async (req, res) => {
  try {
    const { txn_id } = req.query;
    const txn = await dbGet('SELECT * FROM transactions WHERE transaction_id=?', [txn_id]);
    if (!txn) return res.status(404).json({ error: 'Not found' });

    res.json({
      transaction_id: txn.transaction_id,
      status: txn.status,
      amount: txn.amount,
      refund_amount: txn.refund_amount,
      refund_id: txn.refund_id,
      refund_status: txn.status === 'refunded' ? 'Refunded' : 'Not refunded'
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== STOCK SYNC ==========
app.post('/api/stock', async (req, res) => {
  try {
    const { machine_id, current_stock, total_dispensed, total_failed, secret_key } = req.body;
    if (secret_key !== process.env.MACHINE_SECRET) return res.status(401).json({ error: 'Invalid secret' });

    const machine = await dbGet('SELECT * FROM machines WHERE id=?', [machine_id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    await dbRun('UPDATE machines SET current_stock=?, total_dispensed=?, total_failed=?, last_seen=? WHERE id=?',
      [current_stock, total_dispensed, total_failed, new Date().toISOString(), machine_id]);

    res.json({ success: true, current_stock });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== RAZORPAY WEBHOOK ==========
app.post('/api/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.log('Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(body);
    console.log('Razorpay webhook:', event.event);

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const orderId = event.payload.payment?.entity?.order_id || 
                      event.payload.order?.entity?.id;
      const paymentId = event.payload.payment?.entity?.id;

      if (orderId) {
        const txn = await dbGet('SELECT * FROM transactions WHERE razorpay_order_id=?', [orderId]);
        if (txn && txn.status === 'pending') {
          await dbRun('UPDATE transactions SET status=?, paid_at=?, razorpay_payment_id=? WHERE id=?',
            ['paid', new Date().toISOString(), paymentId, txn.id]);
          console.log(`[RAZORPAY WEBHOOK] Payment received for ${txn.transaction_id}`);
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== OTHER ROUTES ==========
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await dbAll('SELECT * FROM machines');
    res.json(machines);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const txns = await dbAll(`SELECT t.*, m.name as machine_name FROM transactions t
      LEFT JOIN machines m ON t.machine_id=m.id ORDER BY t.created_at DESC LIMIT ?`, [limit]);
    res.json(txns);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/stats/today', async (req, res) => {
  try {
    const stats = await dbGet(`SELECT COUNT(*) as total_transactions,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) as refunded,
      SUM(CASE WHEN status='success' THEN amount ELSE 0 END) as total_revenue,
      SUM(CASE WHEN status='success' THEN quantity ELSE 0 END) as total_pads
      FROM transactions WHERE date(created_at)=date('now')`);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/machines/:id/refill', async (req, res) => {
  try {
    const { quantity, admin_password } = req.body;
    const machineId = req.params.id;
    if (admin_password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });

    const machine = await dbGet('SELECT * FROM machines WHERE id=?', [machineId]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const newStock = Math.min(machine.current_stock + quantity, machine.max_capacity);
    const added = newStock - machine.current_stock;

    await dbRun('UPDATE machines SET current_stock=? WHERE id=?', [newStock, machineId]);
    await dbRun(`INSERT INTO stock_logs (machine_id, action, quantity_change, stock_before, stock_after, reason)
      VALUES (?, 'refill', ?, ?, ?, 'Manual refill')`, [machineId, added, machine.current_stock, newStock]);

    console.log(`[REFILL] ${machineId}: +${added} (now ${newStock})`);
    res.json({ success: true, added, new_stock: newStock });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== DASHBOARD HTML ==========
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pad Vending Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f23; color: #fff; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; padding: 20px; background: #1a1a2e; border-radius: 12px; border: 1px solid #e94560; }
    .header h1 { color: #e94560; font-size: 2rem; }
    .header p { color: #888; margin-top: 5px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-box { background: #1a1a2e; padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #333; }
    .stat-box .number { font-size: 2.5rem; font-weight: bold; color: #e94560; }
    .stat-box .label { color: #888; font-size: 0.9rem; margin-top: 5px; }
    .machines { background: #1a1a2e; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
    .machines h2 { color: #e94560; margin-bottom: 15px; }
    .machine { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 15px; padding: 15px; margin-bottom: 10px; background: #0f0f23; border-radius: 8px; align-items: center; }
    .machine-info h3 { color: #fff; }
    .machine-info p { color: #888; font-size: 0.85rem; }
    .stock-bar { width: 100%; height: 25px; background: #333; border-radius: 12px; overflow: hidden; }
    .stock-fill { height: 100%; border-radius: 12px; transition: width 0.5s; }
    .stock-fill.good { background: #4ecca3; }
    .stock-fill.warning { background: #ffc107; }
    .stock-fill.critical { background: #e94560; }
    .stock-text { font-size: 0.85rem; color: #888; margin-top: 3px; }
    .status { padding: 5px 12px; border-radius: 15px; font-size: 0.85rem; text-align: center; }
    .status.active { background: #4ecca3; color: #000; }
    .status.warning { background: #ffc107; color: #000; }
    .status.critical { background: #e94560; color: #fff; }
    .transactions { background: #1a1a2e; padding: 20px; border-radius: 12px; }
    .transactions h2 { color: #e94560; margin-bottom: 15px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    th { color: #e94560; font-weight: 600; }
    td { color: #ccc; }
    .badge { padding: 3px 10px; border-radius: 10px; font-size: 0.8rem; }
    .badge.success { background: #4ecca3; color: #000; }
    .badge.pending { background: #ffc107; color: #000; }
    .badge.failed { background: #e94560; color: #fff; }
    .badge.refunded { background: #64b5f6; color: #000; }
    .connection-status { position: fixed; top: 20px; right: 20px; padding: 8px 15px; border-radius: 20px; font-size: 0.85rem; }
    .connection-status.connected { background: #4ecca3; color: #000; }
    .connection-status.disconnected { background: #e94560; color: #fff; }
    .manual-verify { background: #1a1a2e; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
    .manual-verify h3 { color: #e94560; margin-bottom: 15px; }
    .manual-verify input { padding: 10px; width: 300px; border: 1px solid #333; background: #0f0f23; color: #fff; border-radius: 5px; margin-right: 10px; }
    .manual-verify button { padding: 10px 20px; background: #e94560; color: #fff; border: none; border-radius: 5px; cursor: pointer; }
    .manual-verify button:hover { background: #ff6b81; }
    .verify-result { margin-top: 10px; color: #888; }
  </style>
</head>
<body>
  <div class="connection-status disconnected" id="connStatus">Disconnected</div>
  <div class="header">
    <h1>🩸 Sanitary Pad Vending Dashboard</h1>
    <p>Real-time monitoring & stock management | Powered by Razorpay</p>
  </div>
  <div class="stats" id="stats">
    <div class="stat-box"><div class="number" id="totalTxns">-</div><div class="label">Today's Transactions</div></div>
    <div class="stat-box"><div class="number" id="totalPads">-</div><div class="label">Pads Dispensed</div></div>
    <div class="stat-box"><div class="number" id="totalRevenue">-</div><div class="label">Revenue (Rs.)</div></div>
    <div class="stat-box"><div class="number" id="totalRefunds">-</div><div class="label">Refunds</div></div>
  </div>
  <div class="manual-verify">
    <h3>🔧 Manual Payment Verification (Testing)</h3>
    <input type="text" id="manualTxnId" placeholder="Enter Transaction ID">
    <button onclick="verifyManual()">Mark as Paid</button>
    <div class="verify-result" id="verifyResult"></div>
  </div>
  <div class="machines"><h2>📍 Machines</h2><div id="machinesList"></div></div>
  <div class="transactions">
    <h2>📝 Recent Transactions</h2>
    <table><thead><tr><th>Time</th><th>Machine</th><th>Transaction ID</th><th>Qty</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody id="transactionsList"></tbody></table>
  </div>
  <script>
    const ws = new WebSocket('ws://'+window.location.host);
    const connStatus = document.getElementById('connStatus');
    ws.onopen = () => { connStatus.textContent = 'Live'; connStatus.className = 'connection-status connected'; };
    ws.onclose = () => { connStatus.textContent = 'Disconnected'; connStatus.className = 'connection-status disconnected'; };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init' || msg.type === 'update') updateDashboard(msg.data);
    };
    function updateDashboard(data) {
      if (data.stats) {
        const s = data.stats;
        document.getElementById('totalTxns').textContent = s.total_transactions || 0;
        document.getElementById('totalPads').textContent = s.total_pads || 0;
        document.getElementById('totalRevenue').textContent = '₹' + (s.total_revenue || 0).toFixed(2);
        document.getElementById('totalRefunds').textContent = s.refunded || 0;
      }
      if (data.machines) {
        document.getElementById('machinesList').innerHTML = data.machines.map(m => {
          const percent = (m.current_stock / m.max_capacity) * 100;
          let fillClass = 'good', statusClass = 'active', statusText = 'Active';
          if (m.current_stock === 0) { fillClass = 'critical'; statusClass = 'critical'; statusText = 'Out of Stock'; }
          else if (m.current_stock <= 3) { fillClass = 'warning'; statusClass = 'warning'; statusText = 'Low Stock'; }
          return '<div class="machine"><div class="machine-info"><h3>'+m.name+'</h3><p>'+m.location+' • Last seen: '+(m.last_seen ? new Date(m.last_seen).toLocaleTimeString() : 'Never')+'</p></div><div><div class="stock-bar"><div class="stock-fill '+fillClass+'" style="width:'+percent+'%"></div></div><div class="stock-text">'+m.current_stock+'/'+m.max_capacity+' pads</div></div><div><div class="status '+statusClass+'">'+statusText+'</div></div><div style="text-align:right;"><div style="font-size:1.2rem;font-weight:bold;">₹'+(m.total_sales?.toFixed(2) || '0.00')+'</div><div style="font-size:0.8rem;color:#888;">Total Sales</div></div></div>';
        }).join('');
      }
      if (data.transactions) {
        document.getElementById('transactionsList').innerHTML = data.transactions.map(t => {
          const statusClass = t.status === 'success' ? 'success' : t.status === 'pending' ? 'pending' : t.status === 'refunded' ? 'refunded' : 'failed';
          return '<tr><td>'+new Date(t.created_at).toLocaleTimeString()+'</td><td>'+(t.machine_name || t.machine_id)+'</td><td>'+t.transaction_id.substring(0,20)+'...</td><td>'+t.quantity+'</td><td>₹'+t.amount+'</td><td><span class="badge '+statusClass+'">'+t.status+'</span></td></tr>';
        }).join('');
      }
    }
    async function verifyManual() {
      const txnId = document.getElementById('manualTxnId').value;
      const result = document.getElementById('verifyResult');
      try {
        const res = await fetch('/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txn_id: txnId, admin_password: 'admin123' })
        });
        const data = await res.json();
        result.textContent = data.success ? '✅ Payment verified!' : '❌ ' + data.error;
        result.style.color = data.success ? '#4ecca3' : '#e94560';
      } catch (e) {
        result.textContent = 'Error: ' + e.message;
        result.style.color = '#e94560';
      }
    }
    async function loadInitialData() {
      try {
        const [machines, stats, transactions] = await Promise.all([
          fetch('/api/machines').then(r => r.json()),
          fetch('/api/stats/today').then(r => r.json()),
          fetch('/api/transactions?limit=10').then(r => r.json())
        ]);
        updateDashboard({ machines, stats, transactions });
      } catch (e) { console.error('Failed to load:', e); }
    }
    loadInitialData();
  </script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log('🚀 Server running on http://localhost:' + PORT);
  console.log('📊 Dashboard: http://localhost:' + PORT);
  console.log('💳 Razorpay integrated');
});
