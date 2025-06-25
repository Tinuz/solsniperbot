'use client'

import React, { useState, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useJupiterSwap } from '../hooks/useJupiterSwap'

interface SwapQuoteProps {
  tokenAddress: string
  amount: string
  slippage: string
  onSwapSuccess?: (signature: string) => void
}

const SOL_MINT = 'So11111111111111111111111111111111111111112'

const SwapQuote: React.FC<SwapQuoteProps> = ({ 
  tokenAddress, 
  amount, 
  slippage,
  onSwapSuccess 
}) => {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()
  const { swapRoute, getSwapQuote, prepareSwapTransaction, executeSwap, clearRoute, isTokenTradeable } = useJupiterSwap(connection)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [lastQuoteTime, setLastQuoteTime] = useState<number>(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [quoteAge, setQuoteAge] = useState<number>(0)

  // Smart quote refresh with user control
  useEffect(() => {
    if (!tokenAddress || !amount || parseFloat(amount) <= 0) {
      clearRoute()
      setLastQuoteTime(0)
      return
    }

    const fetchQuote = () => {
      const slippageBps = Math.floor(parseFloat(slippage) * 100)
      getSwapQuote(SOL_MINT, tokenAddress, parseFloat(amount), slippageBps)
      setLastQuoteTime(Date.now())
    }

    // Initial fetch with delay to prevent immediate multiple calls
    const initialTimeout = setTimeout(fetchQuote, 500)

    // Only auto-refresh if enabled and quote is older than 30 seconds
    let interval: NodeJS.Timeout | null = null
    if (autoRefresh) {
      interval = setInterval(() => {
        const timeSinceLastQuote = Date.now() - lastQuoteTime
        if (timeSinceLastQuote > 30000) { // Only refresh if quote is >30 seconds old
          fetchQuote()
        }
      }, 10000) // Check every 10 seconds, but only refresh if needed
    }
    
    return () => {
      clearTimeout(initialTimeout)
      if (interval) clearInterval(interval)
    }
  }, [tokenAddress, amount, slippage, getSwapQuote, clearRoute, autoRefresh, lastQuoteTime])

  // Update quote age every second
  useEffect(() => {
    if (!lastQuoteTime) return

    const updateAge = () => {
      setQuoteAge(Date.now() - lastQuoteTime)
    }

    updateAge() // Initial update
    const ageInterval = setInterval(updateAge, 1000)
    
    return () => clearInterval(ageInterval)
  }, [lastQuoteTime])

  const handleSwap = async () => {
    if (!swapRoute.quote || !publicKey || !signTransaction) return

    setIsExecuting(true)
    try {
      // Prepare transaction
      const transaction = await prepareSwapTransaction(swapRoute.quote, publicKey)
      if (!transaction) {
        throw new Error('Failed to prepare transaction')
      }

      // Execute swap
      const signature = await executeSwap(transaction, { signTransaction })
      
      if (onSwapSuccess) {
        onSwapSuccess(signature)
      }

      console.log('🎉 Swap completed successfully!')
    } catch (error) {
      console.error('Swap failed:', error)
      alert(`Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setIsExecuting(false)
    }
  }

  const refreshQuote = () => {
    if (swapRoute.loading) return
    const slippageBps = Math.floor(parseFloat(slippage) * 100)
    getSwapQuote(SOL_MINT, tokenAddress, parseFloat(amount), slippageBps)
    setLastQuoteTime(Date.now())
  }

  const formatQuoteAge = (ageMs: number) => {
    const seconds = Math.floor(ageMs / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s ago`
  }

  const formatNumber = (num: string | number, decimals = 6) => {
    const value = typeof num === 'string' ? parseFloat(num) : num
    return value.toLocaleString(undefined, { 
      minimumFractionDigits: 0, 
      maximumFractionDigits: decimals 
    })
  }

  const formatTokenAmount = (amount: string, decimals = 9) => {
    const value = parseInt(amount) / Math.pow(10, decimals)
    return formatNumber(value)
  }

  if (!tokenAddress || !amount || parseFloat(amount) <= 0) {
    return null
  }

  return (
    <div className="mt-4 p-4 bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-lg font-semibold text-white flex items-center">
          🔄 Jupiter Swap Quote
          {lastQuoteTime > 0 && !swapRoute.loading && (
            <span className="ml-2 text-xs text-gray-400">
              ({formatQuoteAge(quoteAge)})
            </span>
          )}
        </h4>
        <div className="flex items-center space-x-2">
          {(swapRoute.loading || isValidating) && (
            <div className="flex items-center text-sm text-gray-400">
              <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mr-2"></div>
              {isValidating ? 'Validating...' : 'Loading...'}
            </div>
          )}
          
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              autoRefresh 
                ? 'bg-green-600/20 text-green-400 hover:bg-green-600/30' 
                : 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30'
            }`}
            title={autoRefresh ? 'Auto-refresh enabled' : 'Auto-refresh disabled'}
          >
            {autoRefresh ? '🔄' : '⏸️'}
          </button>

          {/* Manual refresh */}
          <button
            onClick={refreshQuote}
            disabled={swapRoute.loading || isValidating}
            className="px-3 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Refresh quote now"
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {swapRoute.error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="text-red-400 text-sm">
            ❌ {swapRoute.error}
          </div>
          {swapRoute.error.includes('Jupiter API') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Try again in a few seconds. Jupiter API may be experiencing high load.
            </div>
          )}
          {swapRoute.error.includes('Network error') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Check your internet connection and try again.
            </div>
          )}
          {swapRoute.error.includes('timeout') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Request took too long. The API may be slow right now.
            </div>
          )}
          {swapRoute.error.includes('not tradeable') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 This token might be very new or not have enough liquidity yet. Try a different token or wait a bit.
            </div>
          )}
          {swapRoute.error.includes('pair does not exist') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 No trading route found for this token. It may not be listed on major DEXs yet.
            </div>
          )}
          {swapRoute.error.includes('Invalid token address') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Please check that the token address is valid and correctly formatted.
            </div>
          )}
        </div>
      )}

      {swapRoute.quote && !swapRoute.loading && (
        <div className="space-y-3">
          {/* Quote freshness indicator */}
          {lastQuoteTime > 0 && (
            <div className={`flex items-center justify-between p-2 rounded-lg text-xs ${
              quoteAge < 15000 ? 'bg-green-500/10 border border-green-500/20' :
              quoteAge < 30000 ? 'bg-yellow-500/10 border border-yellow-500/20' :
              'bg-red-500/10 border border-red-500/20'
            }`}>
              <div className="flex items-center">
                <div className={`w-2 h-2 rounded-full mr-2 ${
                  quoteAge < 15000 ? 'bg-green-400' :
                  quoteAge < 30000 ? 'bg-yellow-400' :
                  'bg-red-400'
                }`}></div>
                <span className={`${
                  quoteAge < 15000 ? 'text-green-400' :
                  quoteAge < 30000 ? 'text-yellow-400' :
                  'text-red-400'
                }`}>
                  Quote {formatQuoteAge(quoteAge)}
                  {quoteAge > 30000 && ' - Consider refreshing'}
                </span>
              </div>
              {!autoRefresh && (
                <span className="text-gray-400">Auto-refresh disabled</span>
              )}
            </div>
          )}

          {/* Swap Details */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-400">You Pay:</span>
                <span className="text-white font-medium">
                  {amount} SOL
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">You Receive:</span>
                <span className="text-green-400 font-medium">
                  {formatTokenAmount(swapRoute.quote.outAmount)} Tokens
                </span>
              </div>
            </div>
            
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-400">Price Impact:</span>
                <span className={`font-medium ${
                  swapRoute.priceImpact > 5 ? 'text-red-400' : 
                  swapRoute.priceImpact > 1 ? 'text-yellow-400' : 'text-green-400'
                }`}>
                  {swapRoute.priceImpact.toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Est. Fees:</span>
                <span className="text-gray-300">
                  {swapRoute.estimatedFees.toFixed(6)} SOL
                </span>
              </div>
            </div>
          </div>

          {/* Route Information */}
          <div className="p-3 bg-white/5 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Route:</span>
              <span className="text-white">
                {swapRoute.quote.routePlan?.length || 0} step(s) via Jupiter
              </span>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Best route found across {swapRoute.quote.routePlan?.length || 0} DEX(s)
            </div>
          </div>

          {/* Execute Button */}
          <button
            onClick={handleSwap}
            disabled={isExecuting || !publicKey}
            className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
              isExecuting || !publicKey
                ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                : swapRoute.priceImpact > 5
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white transform hover:scale-105'
            }`}
          >
            {isExecuting ? (
              <span className="flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                Executing Swap...
              </span>
            ) : !publicKey ? (
              'Connect Wallet to Swap'
            ) : swapRoute.priceImpact > 5 ? (
              '⚠️ High Impact - Execute Anyway'
            ) : (
              '🚀 Execute Swap'
            )}
          </button>

          {/* Refresh Indicator */}
          <div className="text-center text-xs text-gray-500">
            Quote auto-refreshes every 10 seconds
          </div>
        </div>
      )}
    </div>
  )
}

export default SwapQuote
