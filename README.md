# Solana Sniper Bot

A modern Next.js application for Solana token sniping with real-time mint detection, price tracking, and intuitive user interface.

## 🚀 Features

### Core Functionality
- � **Real-time Mint Detection** - Monitor new token mints on Solana mainnet in real-time
- 💰 **Price Tracking** - Track purchased tokens with live price updates and P&L calculations
- ⚡ **Jupiter DEX Integration** - Get quotes and execute swaps through Jupiter aggregator
- 🌐 **Helius RPC Support** - High-performance WebSocket connections for reliable data
- 💼 **Multi-Wallet Support** - Compatible with Phantom, Solflare, and other Solana wallets

### Technical Features
- 🚀 **Next.js 15** with App Router and React 18
- 💎 **TypeScript** for type-safe development
- 🎨 **Tailwind CSS** for modern, responsive design
- 📱 **Mobile-friendly** responsive interface
- 🔄 **Real-time Updates** with WebSocket connections
- 📊 **Market Analysis** with automated market availability checks

## 📦 Installation

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/solsniperbot.git
cd solsniperbot
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment variables:**
```bash
cp .env.example .env.local
```
Edit `.env.local` and add your Helius API key:
```env
NEXT_PUBLIC_HELIUS_API_KEY=your_helius_api_key_here
```

4. **Start the development server:**
```bash
npm run dev
```

5. **Open your browser:**
Navigate to [http://localhost:3000](http://localhost:3000)

## 🎯 Usage

### Getting Started
1. **Connect Wallet**: Click the wallet button to connect your Solana wallet
2. **Monitor New Tokens**: Use the "Mint Detection" tab to discover new token launches
3. **Analyze Markets**: Check if tokens have available trading pairs on DEXs
4. **Execute Swaps**: Trade tokens through the integrated Jupiter interface
5. **Track Performance**: Monitor your purchases in the "Price Tracker" tab

### Mint Detection
- **Real-time Monitoring**: Automatically detects new token mints
- **Market Validation**: Checks trading availability on Jupiter DEX
- **Rate Limiting**: Built-in protections to avoid API limits
- **Queue Management**: Efficiently processes multiple tokens

### Price Tracking
- **Portfolio Overview**: View all tracked tokens with current prices
- **P&L Calculations**: Real-time profit/loss tracking
- **Auto-adding**: Purchased tokens are automatically added for tracking
- **Manual Control**: Add or remove tokens from tracking manually
- **Update Intervals**: Configurable price update frequencies (5-minute default)

### Swap Interface
- **Jupiter Integration**: Access to the best routes across Solana DEXs
- **Slippage Control**: Adjustable slippage tolerance for market conditions
- **Quote Validation**: Real-time price quotes with expiration tracking
- **Transaction Monitoring**: Track swap execution and confirmation

## 🛠️ Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint checks
```

## 🏗️ Technology Stack

- **Frontend Framework**: Next.js 15 with App Router
- **Language**: TypeScript for type safety
- **Styling**: Tailwind CSS for modern UI
- **Blockchain**: Solana Web3.js and SPL Token libraries
- **DEX Integration**: Jupiter API for swap aggregation
- **RPC Provider**: Helius for enhanced Solana connectivity
- **Wallet Adapter**: Solana Wallet Adapter for multi-wallet support

## ⚙️ Configuration

### Environment Variables
```env
NEXT_PUBLIC_HELIUS_API_KEY=your_helius_api_key
NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta
```

### Customization
- **Price Update Intervals**: Modify in `PriceTracker.tsx`
- **Rate Limiting**: Adjust delays in `useMintDetection.ts`
- **Market Check Settings**: Configure in mint detection hook
- **UI Themes**: Customize Tailwind configuration

## 🔒 Security & Risk Warning

⚠️ **IMPORTANT: This is experimental software. Use at your own risk.**

Token sniping involves significant risks:
- **Financial Risk**: You may lose your entire investment
- **Smart Contract Risk**: Tokens may be malicious or have hidden functions
- **Market Risk**: Extreme volatility and potential for total loss
- **Technical Risk**: Software bugs or network issues may cause losses

**Always:**
- Verify token contracts independently
- Only invest what you can afford to lose
- Do your own research (DYOR)
- Test with small amounts first
- Understand the risks of new token launches

## 🤝 Contributing

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Commit your changes**: `git commit -m 'Add amazing feature'`
4. **Push to the branch**: `git push origin feature/amazing-feature`
5. **Open a Pull Request**

### Development Guidelines
- Follow TypeScript best practices
- Use meaningful commit messages
- Add tests for new features
- Update documentation as needed
- Follow the existing code style

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Jupiter](https://jup.ag) for DEX aggregation
- [Helius](https://helius.xyz) for enhanced Solana RPC
- [Solana Labs](https://solana.com) for the blockchain infrastructure
- The Solana developer community

## 📞 Support

For questions, issues, or contributions:
- Open an issue on GitHub
- Check existing documentation
- Review the code comments for implementation details

---

**Disclaimer**: This software is for educational and research purposes. Users are responsible for compliance with applicable laws and regulations.
