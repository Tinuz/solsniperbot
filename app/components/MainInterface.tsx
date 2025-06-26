'use client'

import React, { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import MintDetection from './MintDetection'
import TokenInfo from './TokenInfo'
import SwapQuote from './SwapQuote'
import ConnectionStatus from './ConnectionStatus'
import PriceTracker from './PriceTracker'

const MainInterface = () => {
  const { publicKey, connected } = useWallet()
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState('5')
  const [mounted, setMounted] = useState(false)
  const [lastSwapSignature, setLastSwapSignature] = useState<string | null>(null)
  const [isQuickSniping, setIsQuickSniping] = useState(false)
  const [markTokenAsSniped, setMarkTokenAsSniped] = useState<((mint: string, snipeData?: { amount?: number; price?: number; signature?: string }) => void) | null>(null)
  const [activeSection, setActiveSection] = useState<'detection' | 'tracker'>('detection')

  // Prevent hydration mismatch by only rendering wallet-dependent content after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  const handleSnipe = async () => {
    if (!connected || !publicKey) {
      alert('Please connect your wallet first')
      return
    }

    if (!tokenAddress || !amount) {
      alert('Please enter token address and amount first')
      return
    }

    setIsQuickSniping(true)
    
    try {
      // Quick snipe: immediately trigger the swap process
      
      // Try to trigger quote refresh or initial quote get
      const refreshButton = document.querySelector('[data-testid="swap-quote-refresh"]') as HTMLButtonElement
      const getQuoteButton = document.querySelector('[data-testid="get-swap-quote"]') as HTMLButtonElement
      
      if (refreshButton && !refreshButton.disabled) {
        refreshButton.click()
        alert(`🎯 Quick Snipe initiated!\n\n✅ Refreshing quote for ${amount} SOL\n⏰ Watch the swap section below for updates`)
      } else if (getQuoteButton) {
        getQuoteButton.click()
        alert(`🎯 Quick Snipe initiated!\n\n✅ Getting initial quote for ${amount} SOL\n⏰ Watch the swap section below for updates`)
      } else {
        // Scroll to swap section as fallback
        const swapSection = document.querySelector('.mt-4.p-4.bg-gradient-to-r.from-purple-500')
        if (swapSection) {
          swapSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        
        alert(`🎯 Quick Snipe Ready!\n\nToken: ${tokenAddress.slice(0, 8)}...\nAmount: ${amount} SOL\nSlippage: ${slippage}%\n\n👇 Scroll down to the swap section to get a quote!`)
      }
      
    } catch (error) {
      console.error('Quick snipe error:', error)
      alert('Quick snipe failed: ' + (error instanceof Error ? error.message : 'Unknown error'))
    } finally {
      setIsQuickSniping(false)
    }
  }

  const handleSwapSuccess = (signature: string) => {
    setLastSwapSignature(signature)
    
    // Mark token as sniped if we have the function and a valid token address
    if (markTokenAsSniped && tokenAddress && amount) {
      try {
        const snipeAmount = parseFloat(amount)
        markTokenAsSniped(tokenAddress, {
          amount: snipeAmount,
          signature: signature
        })
      } catch (error) {
        console.warn('Failed to mark token as sniped:', error)
      }
    }
    
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

      {/* Section Navigation */}
      <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex space-x-1">
            <button
              onClick={() => setActiveSection('detection')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeSection === 'detection'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-white/10'
              }`}
            >
              🔍 Token Detection
            </button>
            <button
              onClick={() => setActiveSection('tracker')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeSection === 'tracker'
                  ? 'bg-green-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-white/10'
              }`}
            >
              📊 Price Tracker
            </button>
          </div>
        </div>

        {/* Token Detection Section */}
        {activeSection === 'detection' && mounted && (
          <MintDetection 
            onTokenSelect={handleTokenSelect} 
            onMarkTokenAsSnipedRef={setMarkTokenAsSniped}
          />
        )}

        {/* Price Tracker Section */}
        {activeSection === 'tracker' && mounted && (
          <PriceTracker />
        )}
      </div>

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

          {/* Quick Snipe Button */}
          <div className="mt-6">
            <button
              onClick={handleSnipe}
              disabled={!mounted || !connected || !tokenAddress || !amount || isQuickSniping}
              className="w-full bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-bold py-4 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 disabled:scale-100 shadow-lg hover:shadow-xl"
            >
              <div className="flex items-center justify-center">
                {isQuickSniping ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-3"></div>
                    Quick Sniping...
                  </>
                ) : !mounted ? (
                  'Loading...'
                ) : !connected ? (
                  '🔗 Connect Wallet to Snipe'
                ) : !tokenAddress || !amount ? (
                  '⚡ Enter Token & Amount First'
                ) : (
                  <>
                    🎯 Quick Snipe {amount} SOL
                    <span className="ml-2 text-xs opacity-75">({slippage}% slippage)</span>
                  </>
                )}
              </div>
            </button>
            
            {connected && tokenAddress && amount && (
              <div className="mt-2 text-center text-xs text-gray-400">
                Quick snipe will get a fresh quote and guide you through the swap
              </div>
            )}
          </div>
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
