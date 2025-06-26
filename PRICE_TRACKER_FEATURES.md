## 📊 Price Tracker Functionality

### Nieuwe Features:
1. **Price Tracker Tab** - Schakel tussen Token Detection en Price Tracker
2. **Real-time Price Updates** - Elke 60 seconden
3. **Automatic Tracking** - Tokens worden automatisch getrackt na een succesvolle swap
4. **Manual Tracking** - "Track Price" knop voor available tokens
5. **P&L Calculation** - Profit/Loss weergave met percentages
6. **Persistent Storage** - Tracked tokens worden opgeslagen in localStorage

### Hoe het werkt:
- Tokens met `marketStatus: 'available'` krijgen een "📊 Track Price" knop
- Na een succesvolle swap wordt de token automatisch toegevoegd aan tracking
- Price updates happen elke 60 seconden via Jupiter API
- P&L wordt berekend op basis van purchase price vs current price

### Test Scenario:
1. Start monitoring in Token Detection tab
2. Wacht tot tokens worden gedetecteerd en available zijn
3. Klik "📊 Track Price" om token toe te voegen
4. Ga naar Price Tracker tab om real-time updates te zien
5. Of voer een swap uit om automatic tracking te testen

### UI Improvements:
- Tab navigation tussen Detection en Price Tracker
- Aggressive Mode indicator (30s interval, 3 tokens parallel)
- Tracked tokens indicator in Detection tab
- Price update status en refresh button
