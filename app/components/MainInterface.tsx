'use client'

import React, { useState, useEffect } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import MintDetection from './MintDetection'
import TokenInfo from './TokenInfo'
import SwapQuote from './SwapQuote'
import ConnectionStatus from './ConnectionStatus'

const MainInterface = () => {
  const { publicKey, connected } = useWallet()
  const { connection } = useConnection()
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState('5')
  const [mounted, setMounted] = useState(false)
  const [lastSwapSignature, setLastSwapSignature] = useState<string | null>(null)

  // Prevent hydration mismatch by only rendering wallet-dependent content after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  const handleSnipe = async () => {
    if (!connected || !publicKey) {
      alert('Please connect your wallet first')
      return
    }

    // The actual sniping is now handled by the SwapQuote component
    console.log('Sniping token:', tokenAddress)
    console.log('Amount:', amount)
    console.log('Slippage:', slippage)
  }

  const handleSwapSuccess = (signature: string) => {
    setLastSwapSignature(signature)
    alert(`🎉 Swap successful! Transaction: ${signature}`)
  }

  const handleTokenSelect = (mint: string) => {
    setTokenAddress(mint)
    // Smooth scroll to the token address input
    const tokenInput = document.querySelector('input[placeholder="Enter token mint address..."]') as HTMLInputElement
    if (tokenInput) {
      tokenInput.focus()
      tokenInput.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Wallet Connection */}
      <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-white">Wallet Connection</h2>
          {mounted && <WalletMultiButton />}
        </div>
        {mounted && connected && publicKey && (
          <div className="text-sm text-gray-300">
            Connected: {publicKey.toString().slice(0, 8)}...{publicKey.toString().slice(-8)}
            {lastSwapSignature && (
              <div className="mt-2 p-2 bg-green-500/10 border border-green-500/20 rounded text-green-400 text-xs">
                ✅ Last swap: {lastSwapSignature.slice(0, 8)}...{lastSwapSignature.slice(-8)}
              </div>
            )}
          </div>
        )}
        
        {/* Helius Connection Status */}
        {mounted && (
          <div className="mt-4">
            <ConnectionStatus />
          </div>
        )}
      </div>

      {/* Mint Detection */}
      {mounted && <MintDetection onTokenSelect={handleTokenSelect} />}

      {/* Sniper Interface */}
      <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
        <h2 className="text-xl font-semibold text-white mb-6">Token Sniper</h2>
        
        <div className="space-y-4">
          {/* Token Address Input */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Token Address
            </label>
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="Enter token mint address..."
              className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
            {tokenAddress && <TokenInfo tokenAddress={tokenAddress} />}
          </div>

          {/* Amount Input */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Amount (SOL)
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.1"
              step="0.01"
              min="0"
              className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>

          {/* Slippage Input */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Slippage Tolerance (%)
            </label>
            <div className="flex space-x-2">
              {['1', '5', '10', '15'].map((value) => (
                <button
                  key={value}
                  onClick={() => setSlippage(value)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    slippage === value
                      ? 'bg-purple-600 text-white'
                      : 'bg-white/5 text-gray-300 hover:bg-white/10'
                  }`}
                >
                  {value}%
                </button>
              ))}
              <input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="flex-1 px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                placeholder="Custom"
                min="0"
                max="50"
              />
            </div>
          </div>

          {/* Jupiter Swap Quote */}
          {mounted && tokenAddress && amount && (
            <SwapQuote 
              tokenAddress={tokenAddress}
              amount={amount}
              slippage={slippage}
              onSwapSuccess={handleSwapSuccess}
            />
          )}

          {/* Snipe Button */}
          <button
            onClick={handleSnipe}
            disabled={!mounted || !connected || !tokenAddress || !amount}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 disabled:scale-100"
          >
            {!mounted ? 'Loading...' : connected ? 'Snipe Token' : 'Connect Wallet to Snipe'}
          </button>
        </div>

        {/* Info */}
        <div className="mt-6 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <div className="flex items-start">
            <div className="text-yellow-500 mr-3">⚠️</div>
            <div className="text-sm text-yellow-200">
              <strong>Warning:</strong> Token sniping involves high risk. Only invest what you can afford to lose. 
              Make sure to verify token addresses and understand the risks involved.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MainInterface
