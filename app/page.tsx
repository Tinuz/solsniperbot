import WalletProvider from './components/WalletProvider'
import DynamicMainInterface from './components/DynamicMainInterface'

export default function Home() {
  return (
    <WalletProvider>
      <main className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">
        <div className="container mx-auto px-4 py-8">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">
              Sol Sniper Bot
            </h1>
            <p className="text-gray-300">
              Advanced Solana token sniping interface
            </p>
          </div>
          <DynamicMainInterface />
        </div>
      </main>
    </WalletProvider>
  )
}
