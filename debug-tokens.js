// Debug script om demo tokens toe te voegen aan localStorage
const demoTokens = [
  {
    mint: "So11111111111111111111111111111111111111112",
    timestamp: Date.now() - 300000, // 5 minutes ago
    marketStatus: "not-available",
    marketCheckCount: 2,
    lastMarketCheck: Date.now() - 60000 // 1 minute ago
  },
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    timestamp: Date.now() - 180000, // 3 minutes ago
    marketStatus: "not-available", 
    marketCheckCount: 1,
    lastMarketCheck: Date.now() - 30000 // 30 seconds ago
  }
];

console.log('Adding demo tokens to localStorage...');
localStorage.setItem('detectedTokens', JSON.stringify(demoTokens));
console.log('Demo tokens added:', demoTokens);
