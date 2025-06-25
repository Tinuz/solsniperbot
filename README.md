# Sol Sniper Bot

Een moderne Next.js applicatie voor Solana token sniping met een intuïtieve gebruikersinterface.

## Features

- 🚀 Modern Next.js 15 met App Router
- 💼 Solana wallet integratie (Phantom, Solflare)
- 🎨 Moderne UI met Tailwind CSS
- ⚡ TypeScript ondersteuning
- 📱 Responsive design

## Installatie

1. Clone de repository:
```bash
git clone <repository-url>
cd solsniperbot
```

2. Installeer dependencies:
```bash
npm install
```

3. (Optioneel) Kopieer en configureer environment variabelen:
```bash
cp .env.example .env.local
```

4. Start de development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in je browser.

## Gebruik

1. **Wallet Verbinden**: Klik op de wallet button om je Phantom of Solflare wallet te verbinden
2. **Token Address**: Voer het mint address in van de token die je wilt snipen
3. **Amount**: Specificeer hoeveel SOL je wilt investeren
4. **Slippage**: Stel je slippage tolerance in (aanbevolen: 5-10%)
5. **Snipe**: Klik op "Snipe Token" om de transactie uit te voeren

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Bouw productie versie
- `npm run start` - Start productie server
- `npm run lint` - Run linter

## Technologie Stack

- **Next.js 15** - React framework met App Router
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS framework
- **Solana Web3.js** - Solana blockchain integratie
- **Wallet Adapter** - Solana wallet verbinding

## Waarschuwing

⚠️ **Dit is experimentele software. Gebruik op eigen risico.**

Token sniping is zeer risicovol en kan leiden tot verlies van je investering. Zorg ervoor dat je:
- De risico's begrijpt
- Token addresses verifieert
- Alleen investeert wat je kunt missen
- Altijd je eigen onderzoek doet

## Contributing

1. Fork het project
2. Maak een feature branch (`git checkout -b feature/amazing-feature`)
3. Commit je wijzigingen (`git commit -m 'Add amazing feature'`)
4. Push naar de branch (`git push origin feature/amazing-feature`)
5. Open een Pull Request

## License

Dit project is gelicenseerd onder de ISC License.
