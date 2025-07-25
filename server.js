// server.js - Congressional Trading Bot (No Quiver Required)
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize services
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const emailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Initialize database
const db = new sqlite3.Database('./trades.db');

// User portfolio tracking
let userPortfolio = {
  totalValue: parseFloat(process.env.DEFAULT_PORTFOLIO_VALUE) || 1000,
  cash: 100, // 10% cash
  positions: {
    'QQQ': { shares: 0, targetAllocation: 0.25, currentValue: 250, currentPrice: 0 },
    'NVDA': { shares: 0, targetAllocation: 0.20, currentValue: 200, currentPrice: 0 },
    'MSFT': { shares: 0, targetAllocation: 0.20, currentValue: 200, currentPrice: 0 },
    'AAPL': { shares: 0, targetAllocation: 0.15, currentValue: 150, currentPrice: 0 },
    'GOOGL': { shares: 0, targetAllocation: 0.10, currentValue: 100, currentPrice: 0 }
  },
  lastUpdated: new Date()
};

// Top performers with their success rates
const TOP_PERFORMERS = {
  'Nancy Pelosi': { weight: 1.0, successRate: 0.89 },
  'David Rouzer': { weight: 0.95, successRate: 0.87 },
  'Debbie Wasserman Schultz': { weight: 0.85, successRate: 0.82 },
  'Ron Wyden': { weight: 0.80, successRate: 0.84 },
  'Roger Williams': { weight: 0.75, successRate: 0.79 },
  'Josh Gottheimer': { weight: 0.90, successRate: 0.85 }
};

// Database setup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trader_name TEXT,
    symbol TEXT,
    transaction_type TEXT,
    amount REAL,
    trade_date TEXT,
    disclosure_date TEXT,
    processed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    action TEXT,
    current_price REAL,
    recommended_amount REAL,
    shares_to_trade REAL,
    reason TEXT,
    confidence REAL,
    executed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS manual_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trader_name TEXT,
    symbol TEXT,
    transaction_type TEXT,
    amount REAL,
    trade_date TEXT,
    processed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ===== STOCK PRICE FUNCTIONS =====
async function getStockPrice(symbol) {
  try {
    const response = await axios.get(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`
    );
    
    const quote = response.data['Global Quote'];
    if (!quote || !quote['05. price']) {
      throw new Error('Invalid response from Alpha Vantage');
    }
    
    return {
      symbol: symbol,
      price: parseFloat(quote['05. price']),
      change: parseFloat(quote['09. change']),
      changePercent: quote['10. change percent'].replace('%', ''),
      lastUpdated: new Date()
    };
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error.message);
    return null;
  }
}

async function updatePortfolioValues() {
  console.log('💰 Updating portfolio values...');
  
  for (const symbol of Object.keys(userPortfolio.positions)) {
    const priceData = await getStockPrice(symbol);
    if (priceData) {
      userPortfolio.positions[symbol].currentPrice = priceData.price;
      // Calculate shares if we have target value but no shares set
      if (userPortfolio.positions[symbol].shares === 0) {
        userPortfolio.positions[symbol].shares = 
          userPortfolio.positions[symbol].currentValue / priceData.price;
      }
      userPortfolio.positions[symbol].currentValue = 
        userPortfolio.positions[symbol].shares * priceData.price;
    }
    
    // Avoid rate limiting (Alpha Vantage: 5 calls/minute)
    await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second delay
  }
  
  // Calculate total portfolio value
  const totalPositionValue = Object.values(userPortfolio.positions)
    .reduce((sum, pos) => sum + pos.currentValue, 0);
  userPortfolio.totalValue = totalPositionValue + userPortfolio.cash;
  userPortfolio.lastUpdated = new Date();
  
  console.log(`📊 Portfolio updated: $${userPortfolio.totalValue.toFixed(2)}`);
}

// ===== DATA FETCHING (FREE SOURCES) =====

// Source 1: House Stock Watcher (Free, GitHub hosted)
async function fetchHouseStockWatcher() {
  try {
    console.log('🔍 Fetching from House Stock Watcher...');
    const response = await axios.get('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json');
    
    const trades = response.data
      .filter(trade => {
        const tradeDate = new Date(trade.transaction_date);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return tradeDate > sevenDaysAgo; // Only recent trades
      })
      .map(trade => ({
        Representative: trade.representative,
        Ticker: trade.ticker,
        Transaction: trade.transaction_type,
        Amount: parseFloat(trade.amount) || 0,
        TransactionDate: trade.transaction_date,
        DisclosureDate: trade.disclosure_date
      }))
      .filter(trade => 
        trade.Representative && 
        trade.Ticker && 
        TOP_PERFORMERS[trade.Representative] && // Only track our top performers
        userPortfolio.positions[trade.Ticker] // Only track our portfolio stocks
      );
    
    console.log(`📊 Found ${trades.length} relevant trades from House Stock Watcher`);
    return trades;
    
  } catch (error) {
    console.error('House Stock Watcher failed:', error.message);
    return [];
  }
}

// Source 2: Manual trade entry for testing/backup
async function fetchManualTrades() {
  return new Promise((resolve) => {
    db.all(
      'SELECT * FROM manual_trades WHERE processed = 0 ORDER BY created_at DESC',
      (err, rows) => {
        if (err || !rows) {
          resolve([]);
        } else {
          // Mark as processed
          db.run('UPDATE manual_trades SET processed = 1 WHERE processed = 0');
          
          const trades = rows.map(row => ({
            Representative: row.trader_name,
            Ticker: row.symbol,
            Transaction: row.transaction_type,
            Amount: row.amount,
            TransactionDate: row.trade_date,
            DisclosureDate: new Date().toISOString().split('T')[0]
          }));
          
          console.log(`📊 Found ${trades.length} manual trades`);
          resolve(trades);
        }
      }
    );
  });
}

// Main data fetching function
async function fetchCongressionalTrades() {
  console.log('🔍 Fetching congressional trades from free sources...');
  
  let allTrades = [];
  
  // Try House Stock Watcher
  const hswTrades = await fetchHouseStockWatcher();
  allTrades = allTrades.concat(hswTrades);
  
  // Try manual trades
  const manualTrades = await fetchManualTrades();
  allTrades = allTrades.concat(manualTrades);
  
  console.log(`📊 Total trades found: ${allTrades.length}`);
  return allTrades;
}

// ===== RECOMMENDATION ENGINE =====
function calculatePositionAdjustment(symbol, traderAction, traderName, amount) {
  const position = userPortfolio.positions[symbol];
  const traderWeight = TOP_PERFORMERS[traderName]?.weight || 0.5;
  const currentAllocation = position.currentValue / userPortfolio.totalValue;
  const targetAllocation = position.targetAllocation;
  
  let recommendation = {
    symbol: symbol,
    action: 'HOLD',
    currentPrice: position.currentPrice || 0,
    recommendedAmount: 0,
    sharesToTrade: 0,
    reason: '',
    confidence: 0
  };
  
  // Calculate trade impact based on trader importance and amount
  const tradeImpact = Math.min((amount / 1000000) * traderWeight, 0.15); // Max 15% adjustment
  
  if (traderAction === 'Purchase' || traderAction === 'Buy') {
    const newTargetAllocation = Math.min(targetAllocation + tradeImpact, 0.35);
    const targetValue = newTargetAllocation * userPortfolio.totalValue;
    const additionalAmount = targetValue - position.currentValue;
    
    if (additionalAmount > 10) {
      recommendation.action = 'BUY';
      recommendation.recommendedAmount = additionalAmount;
      recommendation.sharesToTrade = additionalAmount / (position.currentPrice || 100);
      recommendation.reason = `${traderName} bought $${amount.toLocaleString()} - increasing allocation from ${(currentAllocation * 100).toFixed(1)}% to ${(newTargetAllocation * 100).toFixed(1)}%`;
      recommendation.confidence = traderWeight * 0.9;
    }
    
  } else if (traderAction === 'Sale' || traderAction === 'Sell') {
    const newTargetAllocation = Math.max(targetAllocation - tradeImpact, 0.05);
    const targetValue = newTargetAllocation * userPortfolio.totalValue;
    const reductionAmount = position.currentValue - targetValue;
    
    if (reductionAmount > 10) {
      recommendation.action = 'SELL';
      recommendation.recommendedAmount = reductionAmount;
      recommendation.sharesToTrade = reductionAmount / (position.currentPrice || 100);
      recommendation.reason = `${traderName} sold $${amount.toLocaleString()} - reducing allocation from ${(currentAllocation * 100).toFixed(1)}% to ${(newTargetAllocation * 100).toFixed(1)}%`;
      recommendation.confidence = traderWeight * 0.8;
    }
  }
  
  return recommendation;
}

// ===== ALERT FUNCTIONS =====
async function sendSMS(message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.YOUR_PHONE_NUMBER) {
    console.log('📱 SMS not configured, skipping...');
    return;
  }
  
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.YOUR_PHONE_NUMBER
    });
    console.log('📱 SMS sent successfully');
  } catch (error) {
    console.error('SMS failed:', error.message);
  }
}

async function sendEmail(subject, htmlBody) {
  if (!process.env.EMAIL_USER) {
    console.log('📧 Email not configured, skipping...');
    return;
  }
  
  try {
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: subject,
      html: htmlBody
    });
    console.log('📧 Email sent:', subject);
  } catch (error) {
    console.error('Email failed:', error.message);
  }
}

async function sendBuyRecommendation(recommendation) {
  const { symbol, action, currentPrice, recommendedAmount, sharesToTrade, reason, confidence } = recommendation;
  
  // SMS Alert for urgent trades
  if (confidence > 0.7) {
    const smsMessage = `🚨 ${action}: ${symbol}\n` +
      `Amount: $${recommendedAmount.toFixed(0)}\n` +
      `Price: $${currentPrice.toFixed(2)}\n` +
      `Shares: ${sharesToTrade.toFixed(3)}\n` +
      `Confidence: ${(confidence * 100).toFixed(0)}%\n` +
      `${reason.substring(0, 100)}`;
    
    await sendSMS(smsMessage);
  }
  
  // Detailed Email Alert
  const emailSubject = `${action} Alert: ${symbol} - $${recommendedAmount.toFixed(0)}`;
  const emailBody = `
    <h2>🎯 ${action} RECOMMENDATION</h2>
    <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
      <h3>${symbol} - ${action} $${recommendedAmount.toFixed(0)}</h3>
      <p><strong>Current Price:</strong> $${currentPrice.toFixed(2)}</p>
      <p><strong>Shares to ${action.toLowerCase()}:</strong> ${sharesToTrade.toFixed(3)}</p>
      <p><strong>Confidence:</strong> ${(confidence * 100).toFixed(0)}%</p>
    </div>
    
    <h3>📊 Analysis</h3>
    <p>${reason}</p>
    
    <h3>💼 Portfolio Impact</h3>
    <p><strong>Current ${symbol} value:</strong> $${userPortfolio.positions[symbol].currentValue.toFixed(2)}</p>
    <p><strong>After ${action}:</strong> $${(userPortfolio.positions[symbol].currentValue + (action === 'BUY' ? recommendedAmount : -recommendedAmount)).toFixed(2)}</p>
    
    <h3>📱 How to Execute</h3>
    <ol>
      <li>Open your brokerage app (Robinhood, Fidelity, etc.)</li>
      <li>Search for "${symbol}"</li>
      <li>${action === 'BUY' ? 'Place a market buy order' : 'Place a market sell order'}</li>
      <li>Amount: $${recommendedAmount.toFixed(0)} OR ${sharesToTrade.toFixed(3)} shares</li>
      <li>Review and submit</li>
    </ol>
    
    <p style="color: #666; font-size: 12px;">
      Generated at ${new Date().toLocaleString()}<br>
      Congressional Trading Bot
    </p>
  `;
  
  await sendEmail(emailSubject, emailBody);
  
  // Save recommendation to database
  db.run(
    `INSERT INTO recommendations (symbol, action, current_price, recommended_amount, shares_to_trade, reason, confidence) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [symbol, action, currentPrice, recommendedAmount, sharesToTrade, reason, confidence]
  );
  
  console.log(`📨 ${action} recommendation sent for ${symbol}: $${recommendedAmount.toFixed(0)}`);
}

// ===== MAIN PROCESSING =====
async function processNewTrades() {
  console.log('🔍 Processing new congressional trades...');
  
  try {
    const trades = await fetchCongressionalTrades();
    
    for (const trade of trades) {
      // Check if already processed
      const existing = await new Promise((resolve) => {
        db.get(
          'SELECT id FROM trades WHERE trader_name = ? AND symbol = ? AND trade_date = ? AND amount = ?',
          [trade.Representative, trade.Ticker, trade.TransactionDate, trade.Amount],
          (err, row) => resolve(row)
        );
      });
      
      if (existing) continue;
      
      // Save new trade
      db.run(
        `INSERT INTO trades (trader_name, symbol, transaction_type, amount, trade_date, disclosure_date) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [trade.Representative, trade.Ticker, trade.Transaction, trade.Amount, trade.TransactionDate, trade.DisclosureDate]
      );
      
      const traderName = trade.Representative;
      const symbol = trade.Ticker;
      const amount = parseFloat(trade.Amount) || 0;
      const transactionType = trade.Transaction;
      
      if (TOP_PERFORMERS[traderName] && userPortfolio.positions[symbol]) {
        console.log(`🎯 Analyzing trade: ${traderName} ${transactionType} ${symbol} $${amount.toLocaleString()}`);
        
        // Update current portfolio values
        await updatePortfolioValues();
        
        // Calculate recommendation
        const recommendation = calculatePositionAdjustment(symbol, transactionType, traderName, amount);
        
        if (recommendation.action !== 'HOLD' && recommendation.confidence > 0.6) {
          await sendBuyRecommendation(recommendation);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error processing trades:', error.message);
  }
}

// ===== API ENDPOINTS =====

// Test endpoints
app.get('/api/test-sms', async (req, res) => {
  await sendSMS('🤖 Congressional Trading Bot test - SMS working!');
  res.json({ message: 'Test SMS sent' });
});

app.get('/api/test-email', async (req, res) => {
  await sendEmail('🤖 Bot Test', '<h2>Congressional Trading Bot is working!</h2><p>Email alerts are configured correctly.</p>');
  res.json({ message: 'Test email sent' });
});

// Portfolio endpoints
app.get('/api/portfolio', (req, res) => {
  res.json(userPortfolio);
});

// Manual trade entry for testing
app.post('/api/manual-trade', async (req, res) => {
  const { trader, symbol, type, amount } = req.body;
  
  if (!trader || !symbol || !type || !amount) {
    return res.status(400).json({ error: 'Missing required fields: trader, symbol, type, amount' });
  }
  
  db.run(
    'INSERT INTO manual_trades (trader_name, symbol, transaction_type, amount, trade_date) VALUES (?, ?, ?, ?, ?)',
    [trader, symbol, type, parseFloat(amount), new Date().toISOString().split('T')[0]],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ 
          message: 'Manual trade added successfully',
          id: this.lastID,
          trade: { trader, symbol, type, amount }
        });
        
        // Process immediately
        setTimeout(processNewTrades, 1000);
      }
    }
  );
});

// Trigger endpoints
app.post('/api/trigger/trades', async (req, res) => {
  await processNewTrades();
  res.json({ message: 'Trade processing triggered' });
});

app.post('/api/trigger/update-prices', async (req, res) => {
  await updatePortfolioValues();
  res.json({ message: 'Portfolio prices updated', portfolio: userPortfolio });
});

// Basic dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Congressional Trading Bot</title></head>
      <body style="font-family: Arial; padding: 20px; background: #f5f5f5;">
        <h1>🤖 Congressional Trading Bot</h1>
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>📊 Portfolio Status</h2>
          <p><strong>Total Value:</strong> $${userPortfolio.totalValue.toFixed(2)}</p>
          <p><strong>Cash:</strong> $${userPortfolio.cash.toFixed(2)}</p>
          <p><strong>Last Updated:</strong> ${userPortfolio.lastUpdated.toLocaleString()}</p>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>💼 Current Positions</h2>
          ${Object.entries(userPortfolio.positions).map(([symbol, pos]) => 
            `<p><strong>${symbol}:</strong> ${pos.shares.toFixed(3)} shares @ $${pos.currentPrice.toFixed(2)} = $${pos.currentValue.toFixed(2)} (${(pos.targetAllocation * 100).toFixed(0)}% target)</p>`
          ).join('')}
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>🧪 Test Functions</h2>
          <a href="/api/test-sms" style="margin: 10px; padding: 10px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Test SMS</a>
          <a href="/api/test-email" style="margin: 10px; padding: 10px; background: #28a745; color: white; text-decoration: none; border-radius: 5px;">Test Email</a>
          <a href="/api/trigger/update-prices" style="margin: 10px; padding: 10px; background: #ffc107; color: black; text-decoration: none; border-radius: 5px;">Update Prices</a>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>⚡ Manual Triggers</h2>
          <button onclick="fetch('/api/trigger/trades', {method: 'POST'}).then(() => alert('Trade check triggered!'))" style="margin: 5px; padding: 10px; background: #dc3545; color: white; border: none; border-radius: 5px;">Check Trades</button>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>📝 Add Manual Trade (For Testing)</h2>
          <input type="text" id="trader" placeholder="Trader Name (e.g., Nancy Pelosi)" style="margin: 5px; padding: 8px; width: 200px;"><br>
          <input type="text" id="symbol" placeholder="Symbol (e.g., NVDA)" style="margin: 5px; padding: 8px; width: 100px;">
          <select id="type" style="margin: 5px; padding: 8px;">
            <option value="Purchase">Purchase</option>
            <option value="Sale">Sale</option>
          </select><br>
          <input type="number" id="amount" placeholder="Amount (e.g., 500000)" style="margin: 5px; padding: 8px; width: 150px;">
          <button onclick="addManualTrade()" style="margin: 5px; padding: 10px; background: #17a2b8; color: white; border: none; border-radius: 5px;">Add Trade</button>
        </div>
        
        <script>
          function addManualTrade() {
            const trader = document.getElementById('trader').value;
            const symbol = document.getElementById('symbol').value;
            const type = document.getElementById('type').value;
            const amount = document.getElementById('amount').value;
            
            if (!trader || !symbol || !amount) {
              alert('Please fill all fields');
              return;
            }
            
            fetch('/api/manual-trade', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({trader, symbol, type, amount: parseFloat(amount)})
            }).then(res => res.json()).then(data => {
              alert('Trade added: ' + data.message);
              // Clear form
              document.getElementById('trader').value = '';
              document.getElementById('symbol').value = '';
              document.getElementById('amount').value = '';
            }).catch(err => alert('Error: ' + err));
          }
        </script>
      </body>
    </html>
  `);
});

// ===== SCHEDULED JOBS =====

// Check for new trades every 2 hours during market hours (9 AM - 4 PM EST, Mon-Fri)
cron.schedule('0 9,11,13,15 * * 1-5', async () => {
  console.log('⏰ Scheduled trade check...');
  await processNewTrades();
}, {
  timezone: "America/New_York"
});

// Update portfolio values twice daily (market open and close)
cron.schedule('0 9,16 * * 1-5', async () => {
  console.log('⏰ Scheduled portfolio update...');
  await updatePortfolioValues();
}, {
  timezone: "America/New_York"
});

// Weekly check on Sunday mornings
cron.schedule('0 10 * * 0', async () => {
  console.log('⏰ Weekly system check...');
  await processNewTrades();
}, {
  timezone: "America/New_York"
});

// Initialize on startup
setTimeout(async () => {
  console.log('🚀 Congressional Trading Bot starting up...');
  console.log('💰 Portfolio value: $' + userPortfolio.totalValue.toFixed(2));
  console.log('📊 Data sources: House Stock Watcher + Manual Entry');
  console.log('📅 Schedule: Every 2 hours during market hours');
  
  // Send startup confirmation
  await sendSMS('🤖 Congressional Trading Bot is now active! Using free data sources. Add manual trades to test alerts.');
  
  console.log('✅ Bot initialized and ready!');
}, 3000);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Congressional Trading Bot running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log('🔑 No premium APIs required - using free sources!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  db.close();
  process.exit(0);
});