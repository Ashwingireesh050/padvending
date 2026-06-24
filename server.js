require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ========== RAZORPAY SETUP ==========
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// In-memory storage
const machines = new Map();
const transactions = new Map();
let txnCounter = 0;

// Initialize default machine
machines.set('PAD_VM_001', {
  id: 'PAD_VM_001',
  name: 'Block A Machine',
  location: 'Girls Hostel Block A',
  max_capacity: 20,
  current_stock: 20,
  price_per_item: 10.00,
  total_dispensed: 0,
  total_failed: 0,
  total_sales: 0,
  status: 'active',
  last_seen: new Date().toISOString()
});

// ========== API ROUTES ==========

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/machines', (req, res) => {
  res.json(Array.from(machines.values()));
});

app.get('/api/machine/:id', (req, res) => {
  const machine = machines.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  res.json(machine);
});

// ========== CREATE ORDER ==========
app.post('/api/register', async (req, res) => {
  try {
    const { machine_id, transaction_id, amount, quantity, price_per_item, stock_before } = req.body;

    const machine = machines.get(machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    if (machine.current_stock < quantity) return res.status(400).json({ error: 'Not enough stock' });

    const existing = Array.from(transactions.values()).find(t => t.transaction_id === transaction_id);
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

    const txn = {
      id: 'txn_' + (++txnCounter),
      machine_id: machine_id,
      transaction_id: transaction_id,
      razorpay_order_id: order.id,
      quantity: quantity,
      amount: amount,
      price_per_item: price_per_item,
      status: 'pending',
      stock_before: stock_before,
      created_at: new Date().toISOString()
    };
    transactions.set(txn.id, txn);

    console.log(`[REGISTER] ${transaction_id} | Order: ${order.id}`);

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

// ========== CHECK STATUS ==========
app.get('/api/status', async (req, res) => {
  try {
    const { txn_id } = req.query;
    const txn = Array.from(transactions.values()).find(t => t.transaction_id === txn_id);
    if (!txn) return res.status(404).json({ error: 'Not found' });

    if (txn.razorpay_order_id && txn.status === 'pending') {
      try {
        const razorpayOrder = await razorpay.orders.fetch(txn.razorpay_order_id);
        if (razorpayOrder.status === 'paid') {
          const payments = await razorpay.orders.fetchPayments(txn.razorpay_order_id);
          const payment = payments.items[0];
          txn.status = 'paid';
          txn.paid_at = new Date().toISOString();
          txn.razorpay_payment_id = payment?.id;
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

    const txn = Array.from(transactions.values()).find(t => t.transaction_id === txn_id);
    if (!txn) return res.status(404).json({ error: 'Not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: `Already ${txn.status}` });

    txn.status = 'paid';
    txn.paid_at = new Date().toISOString();
    console.log(`[VERIFY] ${txn_id} by admin`);
    res.json({ success: true, message: 'Payment verified' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== COMPLETE DISPENSING ==========
app.post('/api/complete', async (req, res) => {
  try {
    const { txn_id, machine_id, dispensed_count, failed_count, stock_after, secret_key } = req.body;
    if (secret_key !== process.env.MACHINE_SECRET) return res.status(401).json({ error: 'Invalid secret' });

    const txn = Array.from(transactions.values()).find(t => t.transaction_id === txn_id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    const machine = machines.get(machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const finalStatus = (failed_count === 0) ? 'success' : 'partial';
    txn.status = finalStatus;
    txn.completed_at = new Date().toISOString();
    txn.stock_after = stock_after;
    txn.dispensed_count = dispensed_count;
    txn.failed_count = failed_count;

    machine.current_stock = stock_after;
    machine.total_dispensed += dispensed_count;
    machine.total_failed += failed_count;
    machine.last_seen = new Date().toISOString();

    if (dispensed_count > 0) {
      machine.total_sales += (dispensed_count / txn.quantity) * txn.amount;
    }

    // AUTO-REFUND for failed items
    if (failed_count > 0 && txn.razorpay_payment_id) {
      const refundAmount = (failed_count / txn.quantity) * txn.amount;
      console.log(`[AUTO-REFUND] ${txn_id}: Rs.${refundAmount} for ${failed_count} failed items`);

      try {
        const refund = await razorpay.payments.refund(txn.razorpay_payment_id, {
          amount: Math.round(refundAmount * 100),
          notes: { 
            reason: failed_count + ' pad(s) not dispensed', 
            transaction_id: txn_id,
            machine_id: machine_id
          }
        });

        txn.status = 'refunded';
        txn.refund_id = refund.id;
        txn.refund_amount = refundAmount;
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

// ========== REFUND ==========
app.post('/api/refund', async (req, res) => {
  try {
    const { txn_id, reason, admin_password } = req.body;

    if (admin_password !== process.env.ADMIN_PASSWORD && admin_password !== process.env.MACHINE_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const txn = Array.from(transactions.values()).find(t => t.transaction_id === txn_id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'refunded') return res.status(400).json({ error: 'Already refunded' });

    let paymentId = txn.razorpay_payment_id;
    if (!paymentId && txn.razorpay_order_id) {
      try {
        const payments = await razorpay.orders.fetchPayments(txn.razorpay_order_id);
        paymentId = payments.items[0]?.id;
      } catch (e) { console.log('Could not fetch payment ID'); }
    }

    if (!paymentId) return res.status(400).json({ error: 'No payment found to refund' });

    const refund = await razorpay.payments.refund(paymentId, {
      amount: Math.round(txn.amount * 100),
      notes: { reason: reason || 'Item not dispensed', transaction_id: txn_id }
    });

    txn.status = 'refunded';
    txn.refund_id = refund.id;
    txn.refund_amount = txn.amount;
    txn.completed_at = new Date().toISOString();

    console.log(`[REFUND] ${txn_id}: Rs.${txn.amount} refunded | Refund ID: ${refund.id}`);
    res.json({ success: true, refund_id: refund.id, amount: txn.amount });
  } catch (e) {
    console.error('Refund error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== STOCK SYNC ==========
app.post('/api/stock', async (req, res) => {
  try {
    const { machine_id, current_stock, total_dispensed, total_failed, secret_key } = req.body;
    if (secret_key !== process.env.MACHINE_SECRET) return res.status(401).json({ error: 'Invalid secret' });

    const machine = machines.get(machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    machine.current_stock = current_stock;
    machine.total_dispensed = total_dispensed;
    machine.total_failed = total_failed;
    machine.last_seen = new Date().toISOString();

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
        const txn = Array.from(transactions.values()).find(t => t.razorpay_order_id === orderId);
        if (txn && txn.status === 'pending') {
          txn.status = 'paid';
          txn.paid_at = new Date().toISOString();
          txn.razorpay_payment_id = paymentId;
          console.log(`[WEBHOOK] Payment received for ${txn.transaction_id}`);
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== GET TRANSACTIONS ==========
app.get('/api/transactions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const txns = Array.from(transactions.values())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
    res.json(txns);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== GET STATS ==========
app.get('/api/stats/today', (req, res) => {
  try {
    const today = new Date().toDateString();
    const todayTxns = Array.from(transactions.values()).filter(t => 
      new Date(t.created_at).toDateString() === today
    );

    const stats = {
      total_transactions: todayTxns.length,
      successful: todayTxns.filter(t => t.status === 'success').length,
      failed: todayTxns.filter(t => t.status === 'failed').length,
      refunded: todayTxns.filter(t => t.status === 'refunded').length,
      total_revenue: todayTxns.filter(t => t.status === 'success').reduce((sum, t) => sum + t.amount, 0),
      total_pads: todayTxns.filter(t => t.status === 'success').reduce((sum, t) => sum + t.quantity, 0)
    };
    res.json(stats);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== REFILL ==========
app.post('/api/machines/:id/refill', async (req, res) => {
  try {
    const { quantity, admin_password } = req.body;
    const machineId = req.params.id;
    if (admin_password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });

    const machine = machines.get(machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const newStock = Math.min(machine.current_stock + quantity, machine.max_capacity);
    const added = newStock - machine.current_stock;
    machine.current_stock = newStock;

    console.log(`[REFILL] ${machineId}: +${added} (now ${newStock})`);
    res.json({ success: true, added, new_stock: newStock });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ========== START SERVER ==========
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💳 Razorpay integrated`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});
