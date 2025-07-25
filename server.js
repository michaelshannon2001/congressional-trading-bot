// server.js - Congressional Trading Bot (Email-Only, No Twilio)
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize email service only
const emailTransporter = nodemailer.createTransport({
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
      if (userPortfolio.positions[symbol].shares === 0) {
        userPortfolio.positions[symbol].shares = 
          userPortfolio.positions[symbol].currentValue / priceData.price;
      }
      userPortfolio.positions[symbol].currentValue = 
        userPortfolio.positions[symbol].shares * priceData.price;
    }
    
    // Avoid rate limiting (Alpha Vantage: 5 calls/minute)
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  
  const totalPositionValue = Object.values(userPortfolio.positions)
    .reduce((sum, pos) => sum + pos.currentValue, 0);
  userPortfolio.totalValue = totalPositionValue + userPortfolio.cash;
  userPortfolio.lastUpdated = new Date();
  
  console.log(`📊 Portfolio updated: $${userPortfolio.totalValue.toFixed(2)}`);
}

// ===== DATA FETCHING (FREE SOURCES) =====
async function fetchHouseStockWatcher() {
  try {
    console.log('🔍 Fetching from House Stock Watcher...');
    const response = await axios.get('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json');
    
    const trades = response.data
      .filter(trade => {
        const tradeDate = new Date(trade.transaction_date);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return tradeDate > sevenDaysAgo;
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
        TOP_PERFORMERS[trade.Representative] && 
        userPortfolio.positions[trade.Ticker]
      );
    
    console.log(`📊 Found ${trades.length} relevant trades from House Stock Watcher`);
    return trades;
    
  } catch (error) {
    console.error('House Stock Watcher failed:', error.message);
    return [];
  }
}

async function fetchManualTrades() {
  return new Promise((resolve) => {
    db.all(
      'SELECT * FROM manual_trades WHERE processed = 0 ORDER BY created_at DESC',
      (err, rows) => {
        if (err || !rows) {
          resolve([]);
        } else {
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

async function fetchCongressionalTrades() {
  console.log('🔍 Fetching congressional trades from free sources...');
  
  let allTrades = [];
  
  const hswTrades = await fetchHouseStockWatcher();
  allTrades = allTrades.concat(hswTrades);
  
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
  
  const tradeImpact = Math.min((amount / 1000000) * traderWeight, 0.15);
  
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

// ===== EMAIL ALERT FUNCTIONS =====
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
  
  const emailSubject = `🚨 ${action} ALERT: ${symbol} - $${recommendedAmount.toFixed(0)}`;
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${action === 'BUY' ? '#e8f5e8' : '#ffe8e8'}; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h2 style="margin: 0; color: ${action === 'BUY' ? '#2e7d32' : '#d32f2f'};">
          🚨 ${action} RECOMMENDATION
        </h2>
        <h3 style="margin: 10px 0;">${symbol} - ${action} $${recommendedAmount.toFixed(0)}</h3>
      </div>
      
      <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h3>📊 Trade Details</h3>
        <p><strong>Current Price:</strong> $${currentPrice.toFixed(2)}</p>
        <p><strong>Shares to ${action.toLowerCase()}:</strong> ${sharesToTrade.toFixed(3)}</p>
        <p><strong>Confidence Level:</strong> ${(confidence * 100).toFixed(0)}%</p>
        <p><strong>Urgency:</strong> ${confidence > 0.85 ? 'HIGH - Act within 1 hour' : confidence > 0.7 ? 'MEDIUM - Act within 4 hours' : 'LOW - Act within 24 hours'}</p>
      </div>
      
      <div style="background: #e3f2fd; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h3>🧠 Analysis</h3>
        <p>${reason}</p>
      </div>
      
      <div style="background: #fff3e0; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h3>💼 Portfolio Impact</h3>
        <p><strong>Current ${symbol} value:</strong> $${userPortfolio.positions[symbol].currentValue.toFixed(2)}</p>
        <p><strong>After ${action}:</strong> $${(userPortfolio.positions[symbol].currentValue + (action === 'BUY' ? recommendedAmount : -recommendedAmount)).toFixed(2)}</p>
        <p><strong>New allocation:</strong> ${((userPortfolio.positions[symbol].currentValue + (action === 'BUY' ? recommendedAmount : -recommendedAmount)) / userPortfolio.totalValue * 100).toFixed(1)}%</p>
      </div>
      
      <div style="background: #f3e5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h3>📱 Step-by-Step Instructions</h3>
        <ol style="line-height: 1.8;">
          <li><strong>Open your brokerage app</strong> (Robinhood, Fidelity, Schwab, etc.)</li>
          <li><strong>Search for "${symbol}"</strong></li>
          <li><strong>Choose order type:</strong> Market ${action === 'BUY' ? 'Buy' : 'Sell'} Order</li>
          <li><strong>Enter amount:</strong>
            <ul>
              <li>Dollar amount: $${recommendedAmount.toFixed(0)}</li>
              <li>OR Share amount: ${sharesToTrade.toFixed(3)} shares</li>
            </ul>
          </li>
          <li><strong>Review and submit</strong> the order</li>
          <li><strong>Confirm execution</strong> and update your records</li>
        </ol>
      </div>
      
      <div style="text-align: center; padding: 20px; color: #666; font-size: 12px;">
        <p>Generated at ${new Date().toLocaleString()}</p>
        <p>Congressional Trading Bot - Following the most successful traders in Congress</p>
      </div>
    </div>
  `;
  
  await sendEmail(emailSubject, emailBody);
  
  // Save recommendation
  db.run(
    `INSERT INTO recommendations (symbol, action, current_price, recommended_amount, shares_to_trade, reason, confidence) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [symbol, action, currentPrice, recommendedAmount, sharesToTrade, reason, confidence]
  );
  
  console.log(`📧 ${action} alert sent via email for ${symbol}: $${recommendedAmount.toFixed(0)}`);
}

// ===== MAIN PROCESSING =====
async function processNewTrades() {
  console.log('🔍 Processing new congressional trades...');
  
  try {
    const trades = await fetchCongressionalTrades();
    
    for (const trade of trades) {
      const existing = await new Promise((resolve) => {
        db.get(
          'SELECT id FROM trades WHERE trader_name = ? AND symbol = ? AND trade_date = ? AND amount = ?',
          [trade.Representative, trade.Ticker, trade.TransactionDate, trade.Amount],
          (err, row) => resolve(row)
        );
      });
      
      if (existing) continue;
      
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
        
        await updatePortfolioValues();
        
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
app.get('/api/test-email', async (req, res) => {
  await sendEmail('🤖 Bot Test', '<h2>Congressional Trading Bot is working!</h2><p>Email alerts are configured correctly.</p>');
  res.json({ message: 'Test email sent' });
});

app.get('/api/portfolio', (req, res) => {
  res.json(userPortfolio);
});

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
        
        setTimeout(processNewTrades, 1000);
      }
    }
  );
});

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
          <p><strong>Email Configured:</strong> ${process.env.EMAIL_USER ? '✅ Yes' : '❌ No'}</p>
          <p><strong>API Key Configured:</strong> ${process.env.ALPHA_VANTAGE_API_KEY ? '✅ Yes' : '❌ No'}</p>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>💼 Current Positions</h2>
          ${Object.entries(userPortfolio.positions).map(([symbol, pos]) => 
            `<p><strong>${symbol}:</strong> ${pos.shares.toFixed(3)} shares @ $${pos.currentPrice.toFixed(2)} = $${pos.currentValue.toFixed(2)} (${(pos.targetAllocation * 100).toFixed(0)}% target)</p>`
          ).join('')}
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h2>🧪 Test Functions</h2>
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

// Scheduled jobs
cron.schedule('0 9,11,13,15 * * 1-5', async () => {
  console.log('⏰ Scheduled trade check...');
  await processNewTrades();
}, {
  timezone: "America/New_York"
});

cron.schedule('0 9,16 * * 1-5', async () => {
  console.log('⏰ Scheduled portfolio update...');
  await updatePortfolioValues();
}, {
  timezone: "America/New_York"
});

// Initialize on startup
setTimeout(async () => {
  console.log('🚀 Congressional Trading Bot starting up...');
  console.log('💰 Portfolio value: $' + userPortfolio.totalValue.toFixed(2));
  console.log('📊 Data sources: House Stock Watcher + Manual Entry');
  console.log('📧 Email configured:', !!process.env.EMAIL_USER);
  console.log('🔑 API key configured:', !!process.env.ALPHA_VANTAGE_API_KEY);
  console.log('✅ Bot initialized and ready! (Email-only mode)');
}, 3000);

app.listen(PORT, () => {
  console.log(`🚀 Congressional Trading Bot running on port ${PORT}`);
  console.log('📧 Email-only mode - No SMS required!');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  db.close();
  process.exit(0);
});
